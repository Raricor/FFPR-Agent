"""Battles by rule table (control plan §4.6; the rules and the choice are skills/gambit.py).
At each character's turn the first rule that holds and can be done is done; one that cannot
(no such command, spell not learned, MP short) is backed out of and the next rule tried.

Every step is checked against the battle menu the bridge reads: the command list from 0.4.0,
and from 0.6.0 which window has the keys (menuState, commandState) and the target cursor.
Older bridges get the game's default target and a fixed pause after each command."""

import re
import time
from collections.abc import Callable

from ffpr_agent import laptop as lp
from ffpr_agent.pilot import query, send
from ffpr_agent.skills import gambit
from ffpr_agent.skills.cursor import move_cursor, pick, steer

ICON = re.compile(r"^<[^>]+>")  # 「<IC_WMGC>治疗」 → 「治疗」
HIDDEN = {"防御": ("Right", "Defence"), "换列": ("Left", "Change")}
UNDO = {"Right": "Left", "Left": "Right"}


def battle_menu(laptop: lp.Laptop) -> dict:
    return query(laptop, "battlemenu").get("battlemenu") or {}


def wait_for(laptop: lp.Laptop, test, seconds: float = 1.5) -> dict:
    """Poll the battle menu until `test` holds; returns the last reading either way."""
    end = time.monotonic() + seconds
    menu = battle_menu(laptop)
    while not test(menu) and time.monotonic() < end:
        time.sleep(0.08)
        menu = battle_menu(laptop)
    return menu


def ready(menu: dict) -> bool:
    """Someone's command list has the keys."""
    if not menu.get("actor") or not menu.get("commands"):
        return False
    if "menuState" in menu and menu["menuState"] != "CommandSelecting":
        return False
    return (menu.get("target") or {}).get("state") in (None, "None")


def target_open(menu: dict) -> bool:
    return (menu.get("target") or {}).get("state") not in (None, "None")


def list_open(menu: dict) -> bool:
    return any(menu.get(k) not in (None, "None") for k in ("abilityState", "itemState"))


def press_until(laptop: lp.Laptop, key: str, done, tries: int = 3) -> dict:
    """Press `key` until the reading shows `done`: a window that just opened ignores keys for
    a moment (its inputWait), so a press can be lost (10-20, the target confirm)."""
    menu = {}
    for _ in range(tries):
        send(laptop, "keys", keys=[key], gap=100)
        menu = wait_for(laptop, done, 0.7)
        if done(menu):
            break
    return menu


def fight(laptop: lp.Laptop, plan: dict, timeout: float = 300, say=print) -> dict:
    """Fight a battle with a rule table ({角色: [规则...]}, or the older {角色: "指令"}).
    Characters without rules attack. Returns {"ok", "turns"}; turns say who did what."""
    table = gambit.normalize(plan)
    deadline = time.monotonic() + timeout
    turns: list[str] = []
    count: dict[str, int] = {}
    # Items ordered this battle: ATB queues commands before they act, so the bag still shows
    # them (10-20: three potions went where one was meant).
    ordered: dict[str, int] = {}
    bag = held_items(laptop)
    idle_since = time.monotonic()
    while time.monotonic() < deadline:
        menu = battle_menu(laptop)
        if not menu.get("battle"):
            return {"ok": True, "turns": turns}
        if not ready(menu):
            stuck = time.monotonic() - idle_since > 2.5
            if stuck and target_open(menu):  # a target cursor left open: confirm it
                send(laptop, "keys", keys=["Enter"], gap=100)
                idle_since = time.monotonic()
                continue
            if stuck and list_open(menu):  # a magic list left open: back out of it
                back_to_commands(laptop)
                idle_since = time.monotonic()
                continue
            # Enemy turns and animations; on the result screens Enter moves on. Never press it
            # while a command list is up: it would choose whatever is highlighted.
            idle = time.monotonic() - idle_since > 2.5
            if idle and menu.get("menuState") != "CommandSelecting" and not menu.get("actor"):
                send(laptop, "keys", keys=["Enter"], gap=100)
                idle_since = time.monotonic()
            time.sleep(0.15)
            continue
        actor = menu["actor"]
        count[actor] = count.get(actor, 0) + 1
        situation = situation_of(laptop, menu, actor, count[actor], bag, ordered)
        done = act(laptop, menu, table.get(actor) or [{"do": "攻击"}], situation)
        if done.startswith("道具:"):
            item = ICON.sub("", done.removeprefix("道具:").split("→")[0].split("(")[0])
            ordered[item] = ordered.get(item, 0) + 1
        turns.append(f"{actor}→{done}")
        say(f"  {actor}:{done}")
        turn_over(laptop, actor)
        idle_since = time.monotonic()
    return {"ok": False, "error": "timeout", "turns": turns}


def held_items(laptop: lp.Laptop) -> dict[str, int]:
    held = (query(laptop, "items").get("items") or {}).get("normal") or []
    return {ICON.sub("", i.get("name") or ""): i.get("count") or 0 for i in held}


def situation_of(
    laptop: lp.Laptop,
    menu: dict,
    actor: str,
    turn: int,
    bag: dict[str, int] | None = None,
    ordered: dict[str, int] | None = None,
) -> gambit.Situation:
    """What the rules read. Items count what is in the bag less what was already ordered this
    battle (`bag` as it began, `ordered` since), whichever is fewer."""
    players, enemies = menu.get("players"), menu.get("enemies")
    if players is None:  # bridge before 0.6.0: the sample has both sides
        battle = (query(laptop, "sample").get("sample") or {}).get("battle") or {}
        players, enemies = battle.get("players") or [], battle.get("enemies") or []
    boss = any(e.get("boss") for e in enemies or [])
    items = held_items(laptop)
    if bag and ordered:
        items = {
            name: max(0, min(n, bag.get(name, n) - ordered.get(name, 0)))
            for name, n in items.items()
        }
    return gambit.Situation(actor, players or [], enemies or [], turn, boss, items)


class CannotDo(Exception):
    """This rule cannot be done now (the reason is the message); try the next one."""


def act(laptop: lp.Laptop, menu: dict, rules: list[dict], situation: gambit.Situation) -> str:
    """Do the first rule that can be done; returns what was done, with why earlier rules were
    passed over."""
    skip: set[int] = set()
    passed: list[str] = []
    for _ in range(len(rules) + 1):
        if menu.get("actor") != situation.actor:
            # Never press on: these would be someone else's commands (10-20).
            return "回合已经轮到别人" + note(passed)
        action = gambit.choose(rules, situation, skip)
        try:
            done = attempt(laptop, menu, action, situation)
            return (done if action.rule else f"{done}(兜底)") + note(passed)
        except CannotDo as why:
            passed.append(f"{action.command}:{action.ability}".rstrip(":") + f" {why}")
            back_to_commands(laptop)
        if action.rule == 0:
            break
        skip.add(action.rule)
        menu = wait_for(laptop, ready)
    return "什么也没做成" + note(passed)


def note(passed: list[str]) -> str:
    return f"(跳过:{';'.join(passed)})" if passed else ""


def attempt(
    laptop: lp.Laptop, menu: dict, action: gambit.Action, situation: gambit.Situation
) -> str:
    """Choose the command, the ability and the target; raises CannotDo when this action cannot
    be done now (the caller then backs out to the command list)."""
    names = [c.get("name") for c in menu.get("commands") or []]
    index = pick(names, action.command)
    hidden = HIDDEN.get(action.command)
    if index is None and hidden:
        # Defend and row change sit behind Right / Left on the command list (10-20). With
        # several characters waiting the same key may move to another one instead (Galuf,
        # 10-20), so press once, and undo it when the command set did not change.
        key, state = hidden
        send(laptop, "keys", keys=[key], gap=120)
        menu = wait_for(laptop, lambda m: m.get("commandState") == state, 0.8)
        if menu.get("commandState") != state:
            send(laptop, "keys", keys=[UNDO[key]], gap=120)
            wait_for(laptop, ready, 0.8)
            raise CannotDo(f"按 {key} 没有切出「{action.command}」")
        names = [c.get("name") for c in menu.get("commands") or []]
        index = pick(names, action.command)
    if index is None:
        raise CannotDo(f"没有这个指令(有:{'、'.join(n for n in names if n)})")
    if menu["commands"][index].get("enabled") is False:
        raise CannotDo("现在不能用")
    move_cursor(laptop, menu.get("cursor") or 0, index)
    # A command opens a magic list or a target cursor (Defend does neither and ends the turn).
    press_until(laptop, "Enter", lambda m: list_open(m) or target_open(m) or not ready(m))
    used = names[index]
    if action.ability and action.command == "道具":
        used = f"{used}:{choose_item(laptop, action.ability)}"
    elif action.ability:
        used = f"{used}:{choose_ability(laptop, action.ability, situation.me().get('mp'))}"
    aim(laptop, action, situation)
    press_until(laptop, "Enter", lambda m: not target_open(m))
    return used + (f"→{action.whom}" if action.whom else "")


def choose_ability(laptop: lp.Laptop, wanted: str, mp: int | None) -> str:
    """Highlight `wanted` in the open magic list and press Enter; returns its name. The list is
    a grid of every slot of the magic type, three to a row, unlearned ones blank (10-20);
    `abilities` holds the slots in order and `abilityCursor` indexes them. The learned ones,
    with their names, are `shown` (0.6.1+)."""
    menu = wait_for(laptop, lambda m: list_open(m) and m.get("shown") is not None)
    shown = menu.get("shown")
    if not list_open(menu) or shown is None:
        raise CannotDo("魔法列表没有打开(或桥插件早于 0.6.1)")
    # A blank slot keeps the text it last drew (Lenna's list read 冰结, 10-20): only names
    # whose spell is one of this list's slots count.
    slots = [a.get("id") for a in menu.get("abilities") or []]
    shown = [s for s in shown if s.get("id") in slots]
    names = [ICON.sub("", s.get("name") or "") for s in shown]
    # 「治疗+」「最强」 (gambit.ability_candidates): the best one known and affordable.
    known = [c for c in gambit.ability_candidates(wanted) if c in names]
    if not known:
        raise CannotDo(f"没学会(会的:{'、'.join(names) or '无'})")
    affordable = [c for c in known if mp is None or (shown[names.index(c)].get("mp") or 0) <= mp]
    if not affordable:
        need = shown[names.index(known[-1])].get("mp")
        raise CannotDo(f"MP 不够({need} > {mp})")
    k = names.index(affordable[0])
    if not steer(
        lambda: battle_menu(laptop).get("abilityCursor"),
        lambda key: send(laptop, "keys", keys=[key], gap=120),
        slots.index(shown[k]["id"]),
    ):
        raise CannotDo("光标移不过去")
    press_until(laptop, "Enter", target_open)
    return names[k]


def choose_item(laptop: lp.Laptop, wanted: str) -> str:
    """Highlight `wanted` in the open item list (bridge 0.6.2+: what is held, in list order,
    and the cursor) and press Enter; returns its name."""
    menu = wait_for(laptop, lambda m: m.get("itemState") == "UseSelect" and m.get("items"))
    if menu.get("itemState") != "UseSelect" or not menu.get("items"):
        raise CannotDo("道具列表没有打开(或桥插件早于 0.6.2)")
    names = [i.get("name") or "" for i in menu["items"]]
    k = pick(names, wanted)
    if k is None or (menu["items"][k].get("count") or 0) <= 0:
        raise CannotDo(f"没有「{wanted}」")
    if not steer(
        lambda: battle_menu(laptop).get("itemCursor"),
        lambda key: send(laptop, "keys", keys=[key], gap=120),
        k,
    ):
        raise CannotDo("光标移不过去")
    press_until(laptop, "Enter", target_open)
    return ICON.sub("", names[k])


def back_to_commands(laptop: lp.Laptop) -> None:
    """Cancel out of a magic list or target cursor until the command list has the
    keys. Only while one is open: on the command list itself the cancel key passes the turn to
    the next character (10-20)."""
    for _ in range(4):
        menu = wait_for(laptop, lambda m: ready(m) or list_open(m) or target_open(m), 1.0)
        if ready(menu) or not (list_open(menu) or target_open(menu)):
            return
        send(laptop, "keys", keys=["Backspace"], gap=150)


def aim(laptop: lp.Laptop, action: gambit.Action, situation: gambit.Situation) -> None:
    """Put the target cursor on the ally the rule names (bridge 0.6.0+). Enemies, and older
    bridges, keep the game's default target."""
    if action.target == gambit.ENEMY or action.whom is None:
        return

    def target(m: dict) -> dict:
        return m.get("target") or {}

    menu = wait_for(laptop, lambda m: target(m).get("state") not in (None, "None"), 1.0)
    if target(menu).get("state") in (None, "None"):
        return
    for side in ("Right", "Left"):  # from the enemies over to the party
        if target(menu).get("state") not in ("Enemys", "EnemyAll"):
            break
        send(laptop, "keys", keys=[side], gap=120)
        menu = battle_menu(laptop)
    row = next((i for i, p in enumerate(situation.players) if p.get("name") == action.whom), None)
    if row is not None:
        steer(
            lambda: target(battle_menu(laptop)).get("cursor"),
            lambda key: send(laptop, "keys", keys=[key], gap=120),
            row,
        )


def turn_over(laptop: lp.Laptop, actor: str) -> None:
    """Wait until this actor's command is in, so the next reading is someone else's turn."""
    wait_for(laptop, lambda m: not ready(m) or m.get("actor") != actor, 3.0)


# Set by the player (ds/game.py, control plan §4.10): the table in use for a map's monsters,
# and where to tell how a battle went. Without them the default table by job fights.
table_for: Callable[[int | None], dict | None] | None = None
report: Callable[[int | None, str, str], str] | None = None


def regular(laptop: lp.Laptop, say=print, slot: int = 3) -> str:
    """A regular battle and the patching up after it. The map's tactics fight it when the
    player wrote some, else the default table (healers heal), with menu states from bridge
    0.6.0; older bridges leave it to the pilot agent's Enter presses on the laptop. A wipe
    loads the last save; a bad battle moves the map to its next table."""
    started = time.monotonic()
    if "menuState" not in battle_menu(laptop):
        result = send(laptop, "battle", _wait=200, timeout=180000)
        return f"本地战斗 {result.get('seconds')} 秒"
    sample = query(laptop, "sample").get("sample") or {}
    map_id = (sample.get("user") or {}).get("mapId")
    names = "、".join(
        dict.fromkeys(e.get("name") for e in (sample.get("battle") or {}).get("enemies") or [])
    )
    table = table_for(map_id) if table_for else None
    which = "这张地图的策略" if table else "默认规则"
    result = fight(
        laptop, table or gambit.default_table(sample.get("party") or []), say=lambda _: None
    )
    verdict, detail = judge(laptop)
    note = report(map_id, verdict, detail) if report else ""
    if verdict == "lost":
        from ffpr_agent.skills.save import load_game  # save imports the menu skills

        _, loaded = load_game(laptop, slot)
        return f"全灭(敌人:{names}),{loaded}" + (f";{note}" if note else "")
    healed = patch_up(laptop, say)
    text = f"按{which}打完 {time.monotonic() - started:.0f} 秒(敌人:{names};{detail})"
    if not result.get("ok"):
        text = f"战斗没打完:{result.get('error')}"
    return text + ("," + ";".join(healed) if healed else "") + (f";{note}" if note else "")


def judge(laptop: lp.Laptop) -> tuple[str, str]:
    """How the battle went, from the party afterwards: lost (everyone down), hard (someone
    down, or under 40% of the party's HP), or ok."""
    party = (query(laptop, "sample").get("sample") or {}).get("party") or []
    if not party:
        return "ok", "读不到队伍"
    down = [p.get("name") for p in party if (p.get("hp") or 0) <= 0]
    total = sum(p.get("hp") or 0 for p in party)
    top = sum(p.get("maxHp") or 0 for p in party) or 1
    if len(down) == len(party):
        return "lost", "全员倒下"
    if down:
        return "hard", f"{'、'.join(down)}倒下"
    if total / top < 0.4:
        return "hard", f"全队 HP 只剩 {100 * total // top}%"
    return "ok", f"全队 HP {100 * total // top}%"


def patch_up(laptop: lp.Laptop, say=print, casts: int = 4) -> list[str]:
    """After a battle (the table's after_battle, §4.6): a white mage casts 治疗 on whoever is
    under half HP, the lowest first, then 解毒 on whoever is poisoned, while MP lasts. Returns
    what was cast."""
    from ffpr_agent.skills.menu import cast, party_state  # menu needs the field, battle not

    send(laptop, "wait", _wait=40, timeout=30000)
    done: list[str] = []
    for _ in range(casts):
        party = party_state(laptop)
        hurt = [p for p in party if (p.get("hp") or 0) > 0 and gambit.pct(p) < 50]
        healers = [
            p
            for p in party
            if p.get("jobName") == "白魔法师" and (p.get("hp") or 0) > 0 and (p.get("mp") or 0) >= 4
        ]
        if not hurt or not healers:
            break
        ok, text = cast(laptop, healers[0]["name"], "治疗", min(hurt, key=gambit.pct)["name"])
        done.append(text)
        say(f"  {text}")
        if not ok:
            break
    # Ailments that stay after a battle (poison), cured with the white magic for each; the
    # field reads statuses from bridge 0.6.5.
    for ailment, spell in CURES.items():
        for _ in range(casts):
            party = party_state(laptop)
            ailing = [p for p in party if any(ailment in s for s in gambit.statuses(p))]
            healers = [
                p
                for p in party
                if p.get("jobName") == "白魔法师"
                and (p.get("hp") or 0) > 0
                and (p.get("mp") or 0) >= 2
            ]
            if not ailing or not healers:
                break
            ok, text = cast(laptop, healers[0]["name"], spell, ailing[0]["name"])
            done.append(text)
            say(f"  {text}")
            if not ok:
                break
    return done


CURES = {"毒": "解毒"}  # ailment → the white magic that cures it
