"""The field menu: reading it (bridge 0.4.1+), casting a spell from it, leaving it."""

import time

from ffpr_agent import laptop as lp
from ffpr_agent.pilot import query, send
from ffpr_agent.skills.cursor import pick, steer


def menu_state(laptop: lp.Laptop) -> dict:
    return query(laptop, "menu").get("menu") or {}


def wait_menu(laptop: lp.Laptop, ok, timeout: float = 3.0) -> dict:
    """Polls the field menu until `ok(menu)` holds or the time is up; returns the last read."""
    deadline = time.monotonic() + timeout
    while True:
        menu = menu_state(laptop)
        if ok(menu) or time.monotonic() > deadline:
            return menu
        time.sleep(0.2)


def party_state(laptop: lp.Laptop) -> list[dict]:
    return (query(laptop, "sample").get("sample") or {}).get("party") or []


def cast(laptop: lp.Laptop, caster: str, spell: str, target: str | None = None) -> tuple[bool, str]:
    """Cast a spell from the field menu: Magic → caster → the list holding `spell` → target
    (the caster when not given). Each step is checked against the menu the bridge (0.4.1+)
    reads, and the result against HP and MP. Leaves the menu afterwards, whatever happened."""
    pos = send(laptop, "pos")["pos"]
    if pos.get("state") != "Player":
        return False, f"现在不能打开菜单(状态 {pos.get('state')})"
    party = party_state(laptop)
    names = [c.get("name") for c in party]
    who = pick(names, caster)
    if who is None:
        return False, f"队伍里没有「{caster}」,有:{'、'.join(n for n in names if n)}"
    whom = pick(names, target or caster)
    if whom is None:
        return False, f"队伍里没有「{target}」"
    try:
        return _cast(laptop, party, who, whom, spell)
    finally:
        leave_menu(laptop)


def _cast(laptop: lp.Laptop, party: list[dict], who: int, whom: int, spell: str):
    def press(key: str) -> None:
        send(laptop, "keys", keys=[key], gap=120)

    def cursor(*path):
        def read():
            node = menu_state(laptop)
            for key in path:
                node = (node or {}).get(key)
            return node

        return read

    caster, patient = party[who], party[whom]
    send(laptop, "keys", keys=["Tab"], gap=100)
    menu = wait_menu(laptop, lambda m: m.get("open") and m.get("commands"))
    ids = [c.get("id") for c in menu.get("commands") or []]
    if "Magic" not in ids:
        return False, f"菜单没有打开或没有「魔法」:{menu}"
    if not steer(cursor("cursor"), press, ids.index("Magic")):
        return False, "光标没能移到「魔法」"
    press("Enter")
    # partyCursor is there on the top menu too; the state tells the party list has opened.
    menu = wait_menu(laptop, lambda m: m.get("magic") or m.get("state") == "Magic")
    if not menu.get("magic"):
        # The game first asks whose magic.
        if not steer(cursor("partyCursor"), press, who):
            return False, f"没能选中 {caster.get('name')}:{menu}"
        press("Enter")
        menu = wait_menu(laptop, lambda m: m.get("magic"))
    magic = menu.get("magic") or {}
    if not magic:
        return False, f"魔法窗口没有打开:{menu}"
    if magic.get("character") not in (None, caster.get("name")):
        return False, f"打开的是 {magic['character']} 的魔法"

    def in_list(m: dict) -> bool:
        return (m.get("magic") or {}).get("state") == "MagicList"

    # Try each magic command (White, Black, ...) until a list holds the spell.
    found = None
    seen: list[str] = []
    commands = magic.get("commands") or []
    if not any(c.get("enabled") for c in commands):
        # Spells are bought in magic shops; a new party knows none.
        return False, f"{caster.get('name')} 还没有学会任何魔法(魔法要在魔法店买)"
    for i, command in enumerate(commands):
        if not in_list(menu):
            if command.get("enabled") is False:
                continue
            if not steer(cursor("magic", "commandCursor"), press, i):
                continue
            press("Enter")
            menu = wait_menu(laptop, in_list)
        entries = (menu.get("magic") or {}).get("abilities") or []
        seen += [a.get("name") for a in entries if a.get("name")]
        found = pick([a.get("name") for a in entries], spell)
        if found is not None:
            break
        if in_list(menu):
            press("Backspace")
            menu = wait_menu(laptop, lambda m: not in_list(m))
    if found is None:
        known = "、".join(seen) or "(一个也没读到)"
        return False, f"{caster.get('name')} 的魔法里没有「{spell}」,有:{known}"
    entry = (menu.get("magic") or {}).get("abilities")[found]
    if entry.get("usable") is False:
        return False, f"现在用不了「{entry.get('name')}」:这个魔法在地图上不能用(只能在战斗里用)"
    if (entry.get("mp") or 0) > (caster.get("mp") or 0):
        return False, f"MP 不够:「{entry.get('name')}」要 {entry.get('mp')},只有 {caster.get('mp')}"
    # The list is a grid of every slot of the magic type, three a row, unlearned ones blank,
    # and the cursor moves over all of them; `abilities` holds the learned ones only (10-20:
    # 解毒 is at 2, behind an unlearned 侦测). contentIds (bridge 0.6.5+) gives each slot's
    # spell, so the cursor's goal is the slot of this spell. abilityIndex does not follow
    # the cursor.
    slots = (menu.get("magic") or {}).get("contentIds")
    goal = slots.index(entry.get("id")) if slots and entry.get("id") in slots else found
    if not steer(cursor("magic", "abilityCursor"), press, goal):
        return False, f"光标没能移到「{entry.get('name')}」"
    press("Enter")
    menu = wait_menu(laptop, lambda m: (m.get("magic") or {}).get("targets"))
    targets = (menu.get("magic") or {}).get("targets") or []
    if not targets:
        return False, f"没有出现选择对象:{menu.get('magic')}"
    if (menu.get("magic") or {}).get("targetMode") != "All":
        row = pick([t.get("name") for t in targets], patient.get("name"))
        if row is None or not steer(cursor("magic", "targetCursor"), press, row):
            return False, f"没能选中 {patient.get('name')}"
    press("Enter")
    time.sleep(1.5)  # the effect animation
    after = party_state(laptop)
    hp = (patient.get("hp"), after[whom].get("hp") if whom < len(after) else None)
    mp = (caster.get("mp"), after[who].get("mp") if who < len(after) else None)
    if mp[1] is not None and mp[0] is not None and mp[1] < mp[0]:
        return True, (
            f"{caster.get('name')} 用了「{entry.get('name')}」:"
            f"{patient.get('name')} HP {hp[0]}→{hp[1]},MP {mp[0]}→{mp[1]}"
        )
    return False, f"MP 没有减少({mp[0]}),可能没用出去"


def leave_menu(laptop: lp.Laptop) -> str:
    result = send(laptop, "leave", _wait=30)
    if result.get("ok"):
        return f"已回到地图(按了 {result.get('presses')} 次返回)"
    return f"没能退出:{result.get('error')}(状态 {(result.get('pos') or {}).get('state')})"


STRONGEST = 1  # the equipment commands: Equip, Strongest, Remove everything (EquipmentCommandId)


def optimize_equipment(laptop: lp.Laptop) -> tuple[bool, str]:
    """「最强装备」for every member: menu → Equipment → member → Strongest. Reports what
    changed, read from the equipment slots before and after. Leaves the menu afterwards."""
    pos = send(laptop, "pos")["pos"]
    if pos.get("state") != "Player":
        return False, f"现在不能打开菜单(状态 {pos.get('state')})"
    try:
        return _optimize(laptop)
    finally:
        leave_menu(laptop)


def _optimize(laptop: lp.Laptop) -> tuple[bool, str]:
    def press(key: str) -> None:
        send(laptop, "keys", keys=[key], gap=120)

    def equipment() -> dict:
        return menu_state(laptop).get("equipment") or {}

    party = party_state(laptop)
    send(laptop, "keys", keys=["Tab"], gap=100)
    menu = wait_menu(laptop, lambda m: m.get("open") and m.get("commands"))
    ids = [c.get("id") for c in menu.get("commands") or []]
    if "Equipment" not in ids:
        return False, f"菜单没有打开或没有「装备」:{menu}"
    if not steer(lambda: menu_state(laptop).get("cursor"), press, ids.index("Equipment")):
        return False, "光标没能移到「装备」"
    press("Enter")
    wait_menu(laptop, lambda m: m.get("state") == "Equipment" or m.get("equipment"))
    changes = []
    for i, member in enumerate(party):
        if not steer(lambda: menu_state(laptop).get("partyCursor"), press, i):
            return False, f"没能选中 {member.get('name')}"
        press("Enter")
        menu = wait_menu(laptop, lambda m: (m.get("equipment") or {}).get("state") == "Command")
        before = [s.get("item") for s in (menu.get("equipment") or {}).get("slots") or []]
        if not steer(lambda: equipment().get("commandCursor"), press, STRONGEST):
            return False, f"{member.get('name')}:光标没能移到「最强装备」"
        press("Enter")
        time.sleep(0.6)
        after = [s.get("item") for s in equipment().get("slots") or []]
        changed = [
            f"{a or '空'}→{b or '空'}" for a, b in zip(before, after, strict=False) if a != b
        ]
        changes.append(f"{member.get('name')}:{'、'.join(changed) if changed else '没有更好的'}")
        press("Backspace")  # back to choosing a member
        wait_menu(laptop, lambda m: (m.get("equipment") or {}).get("state") != "Command")
    return True, "最强装备:" + ";".join(changes)
