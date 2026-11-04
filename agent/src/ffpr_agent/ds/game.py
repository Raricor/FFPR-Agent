"""The tool side of the DeepSeek player: runs each tool through the skills and describes
what the player sees afterwards. Notes the model keeps survive between runs."""

import json
import re
from pathlib import Path

from ffpr_agent import laptop as lp
from ffpr_agent import nav, pilot, view
from ffpr_agent.ds.atlas import Atlas
from ffpr_agent.ds.prompt import FLOOR_MARKS, describe_battle, render_floor, render_terrain
from ffpr_agent.ds.tactics import Tactics
from ffpr_agent.events import KeyEvents
from ffpr_agent.guide.kb import Guide
from ffpr_agent.skills import battle, gambit, menu, move, save, shop

MAX_NOTES = 40
GEAR = {"Weapon", "Armor"}  # item types worth wearing (bridge 0.6.8)
WORLD_EXIT = "ワールドマップ"  # events by this name take the party out to the world map
TOWN_WORDS = ("宿屋", "武器", "防具", "魔法屋", "道具屋")  # exits that make a map a town


def load_notes(path: Path | None) -> list[str]:
    """Notes survive between runs, so what one run learned (an inn's door, a dead end) helps
    the next."""
    if path is None or not path.exists():
        return []
    return list(json.loads(path.read_text(encoding="utf-8")))[-MAX_NOTES:]


def save_notes(path: Path | None, notes: list[str]) -> None:
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(notes, ensure_ascii=False, indent=1), encoding="utf-8")


class Game:
    """The tool side: runs each tool through the pilot and describes what the player now sees."""

    def __init__(
        self,
        laptop: lp.Laptop,
        game: str = "ff5",
        notes_file: Path | None = None,
        events: KeyEvents | None = None,
        atlas_file: Path | None = None,
        tactics_file: Path | None = None,
    ):
        self.laptop = laptop
        self.game = game
        self.notes_file = notes_file
        self.notes: list[str] = load_notes(notes_file)
        self.events = events  # key events from the bridge's stream (None without the LAN link)
        self.atlas = Atlas(atlas_file)
        self.save_point: tuple[int, int] | None = None  # on the current map, if it has one
        self.gear: dict[str, int] | None = None  # weapons and armour in the bag, last look
        # The player's tactics per map fight the regular battles (control plan §4.10).
        self.tactics = Tactics(tactics_file)
        battle.table_for = self.tactics.current
        battle.report = self.tactics.record
        self.map_id: int | None = None
        self.town: int | None = None  # the town map last hinted about
        self.guide = Guide.load()  # the walkthroughs (ffpr-guide fetch), None until fetched
        self.advised: set[str] = set()  # areas and monsters whose guide notes were shown

    def observe(self) -> str:
        sample = self.events.live_sample() if self.events else None
        if sample is not None:
            return view.summarize(sample, self.events.take_recent()[-8:])
        text = lp.run_ps(
            self.laptop, view.state_script(self.laptop, self.game), capture=True
        ).stdout
        sample, events = view.parse_state(text)
        events = [e for e in events if e.get("type") != "pos.change"]
        return view.summarize(sample, events[-8:])

    def window(self, layer: int) -> str:
        """The key events in this layer's window (control plan §4.8), "" without the stream."""
        return self.events.window(layer) if self.events else ""

    def news(self) -> str:
        return self.events.news() if self.events else ""

    def ready(self) -> str | None:
        """None when keys can reach the game; otherwise why not (the laptop is locked, or
        another window is in front)."""
        status = pilot.send(self.laptop, "status")
        if status.get("locked"):
            return "locked"
        if not status.get("focused"):
            pilot.send(self.laptop, "focus")
            status = pilot.send(self.laptop, "status")
            if not status.get("focused"):
                return "not_focused"
        return None

    def settle(self) -> str:
        """Finish a regular battle locally, so the model never waits on enemies. A boss battle
        (bridge 0.4.0+ reads the flag) is left running for the model to plan with `fight`."""
        pos = pilot.send(self.laptop, "pos")["pos"]
        if not (pos.get("battle") or pos.get("state") == "Battle"):
            return ""
        sample = pilot.query(self.laptop, "sample").get("sample") or {}
        fight = sample.get("battle") or {}
        if fight.get("boss"):
            return "首领战开始了!战斗暂停等你决定:用 fight 交一张规则表。\n" + describe_battle(
                fight, sample.get("party")
            )
        return f"(途中遇敌,{battle.regular(self.laptop, say=lambda _: None)})"

    def chart(self) -> int | None:
        """Record the current map's exits and chests in the atlas; returns the map id."""
        pos = pilot.send(self.laptop, "pos").get("pos") or {}
        map_id = pos.get("map")
        if map_id is None or pos.get("state") in ("ChangeMap", "FieldReady"):
            return map_id
        found = {}
        for kind in ("GotoMap", "TresureBox", "Event"):
            listing = pilot.send(self.laptop, "entities", kind=kind, max=200).get("entities")
            found[kind] = [
                e for e in (listing or {}).get("entities") or [] if e.get("active", True)
            ]
        sample = (self.events.live_sample() if self.events else None) or (
            pilot.query(self.laptop, "sample").get("sample") or {}
        )
        user = sample.get("user") or {}
        name = " ".join(x for x in (user.get("areaText"), user.get("locationText")) if x)
        exits = [
            {"cell": e["cell"], "to": e["toMap"], "name": e.get("name") or ""}
            for e in found["GotoMap"]
            if e.get("cell") and e.get("toMap") is not None
        ]
        # A town's way out to the world map can be an event, not an entrance (10-22: Karnak's
        # at (27,45); the player found no exit and walked the town for fifty steps).
        exits += [
            {"cell": e["cell"], "to": 1, "name": e.get("name") or ""}
            for e in found["Event"]
            if e.get("cell") and WORLD_EXIT in (e.get("name") or "")
        ]
        chests = [{"cell": e["cell"], "name": e.get("name") or ""} for e in found["TresureBox"]]
        self.atlas.visit(map_id, name, exits, chests)
        self.save_point = next(
            (tuple(e["cell"]) for e in found["Event"] if "SavePoint" in (e.get("name") or "")),
            None,
        )
        return map_id

    def keep_drake(self) -> None:
        """Remember where the drake was left, across runs (the file next to the atlas)."""
        path = self.atlas.path.parent / "drake.json" if self.atlas.path else None
        if path is None:
            return
        if move.drake is None and path.exists():
            move.drake = tuple(json.loads(path.read_text(encoding="utf-8")))
        elif move.drake is not None:
            path.write_text(json.dumps(list(move.drake)), encoding="utf-8")

    def world_entrance(self, goal: tuple[int, int]) -> bool:
        """An entrance (town, castle, dungeon) on the world map at or right next to goal."""
        found = pilot.send(self.laptop, "entities", kind="GotoMap", max=300).get("entities") or {}
        return any(
            e.get("cell") and abs(e["cell"][0] - goal[0]) + abs(e["cell"][1] - goal[1]) <= 1
            for e in found.get("entities") or []
        )

    def gear_in_bag(self) -> dict[str, int]:
        held = (pilot.query(self.laptop, "items").get("items") or {}).get("normal") or []
        return {
            i["name"]: i.get("count") or 0
            for i in held
            if i.get("type") in GEAR and i.get("name")  # types from bridge 0.6.8
        }

    def check_gear(self) -> str:
        """New weapons or armour in the bag since the last look (a chest, an event, a shop):
        put on the strongest, the game's own 最强装备 deciding who wears what, and say what
        changed. Gear put on leaves the bag, so that is never new. Waits for the field: in a
        shop or a dialog the new gear stays new until the next look (10-21: the Mythril helmet
        from North Mountain went unworn)."""
        bag = self.gear_in_bag()
        if self.gear is None:
            self.gear = bag
            return ""
        new = [name for name, count in bag.items() if count > self.gear.get(name, 0)]
        if not new:
            self.gear = bag
            return ""
        if (pilot.send(self.laptop, "pos").get("pos") or {}).get("state") != "Player":
            return ""
        ok, text = menu.optimize_equipment(self.laptop)
        self.gear = self.gear_in_bag()
        if ok and self.events:
            self.events.note("equip", text)
        return f"得到新装备「{'、'.join(new)}」,已检查最强装备:{text}"

    def guide_hint(self) -> str:
        """The guides' warnings for an area entered and for monsters met for the first time
        (control plan §4.11; 10-21: Jackanapes, "RUN from" it, wiped the party twice)."""
        if self.guide is None:
            return ""
        out = []
        sample = (self.events.live_sample() if self.events else None) or {}
        area = (sample.get("user") or {}).get("areaText")
        if area and area not in self.advised:
            self.advised.add(area)
            warnings = self.guide.warnings(area)
            if warnings:
                out.append(f"攻略(「{area}」):" + ";".join(warnings) + "。详情用 guide 查。")
        met = (self.events.enemies.get(self.map_id) or set()) if self.events else set()
        for name in sorted(met - self.advised):
            self.advised.add(name)
            book = self.events.books.get(name)
            note = self.guide.monster_note(book) if book else ""
            if note:
                out.append(f"攻略(怪物「{name}」= #{book:03d}):{note}")
        return "\n".join(out)

    def town_hint(self) -> str:
        """In a town (its exits lead to an inn or shops) with the party below full: say to get
        ready there first, once per visit (10-21: the party left Walse at half HP, with its
        shops unvisited, and fell in the castle basement)."""
        entry = self.atlas.maps.get(str(self.map_id)) or {}
        names = " ".join(e.get("name") or "" for e in entry.get("exits") or [])
        if self.map_id == self.town or not any(w in names for w in TOWN_WORDS):
            return ""
        party = menu.party_state(self.laptop)
        hp = sum(p.get("hp") or 0 for p in party), sum(p.get("maxHp") or 0 for p in party)
        mp = sum(p.get("mp") or 0 for p in party), sum(p.get("maxMp") or 0 for p in party)
        self.town = self.map_id
        sample = (self.events.live_sample() if self.events else None) or {}
        area = (sample.get("user") or {}).get("areaText") or ""
        stock = self.town_stock(area)
        lines = []
        if hp[0] < hp[1] or mp[0] < mp[1]:
            lines.append(
                f"提示:这里是城镇,队伍 HP {hp[0]}/{hp[1]}、MP {mp[0]}/{mp[1]} 没满。"
                "出发去迷宫前先整备:住店回满;看看魔法店、武器防具店有没有新东西"
                "(买到的装备会自动穿上)。"
            )
        ailing = {s for p in party for s in gambit.statuses(p) if s in gambit.CURES}
        if ailing:
            items = [gambit.CURES[s][1] for s in sorted(ailing) if gambit.CURES[s][1]]
            lines.append(
                f"提示:队伍有状态异常({'、'.join(sorted(ailing))}),住店能治好;"
                f"道具店买些治它的道具({'、'.join(items)})带着,战斗里会自动用。"
            )
        if stock:
            lines.append(f"攻略:{area}的商店卖 {stock}。详情用 guide(kind=shop)查。")
        return "\n".join(lines)

    def town_stock(self, area: str) -> str:
        """The magic and gear the guide lists for this town's shops, names and prices."""
        if self.guide is None or not area:
            return ""
        parts = []
        for s in self.guide.sections_for(area)[:1]:
            for table in s.get("shops") or []:
                if table["kind"] in ("魔法", "武器", "防具", "饰品", "盾", "头盔"):
                    goods = "、".join(f"{g['name']} {g['cost'] or '?'}" for g in table["goods"])
                    parts.append(f"{table['kind']}:{goods}")
        return ";".join(parts)

    def tactics_hint(self) -> str:
        """Monsters met on this map and no tactics for them yet: ask for some (§4.10)."""
        if self.map_id is None or self.map_id == 1 or self.tactics.has(self.map_id):
            return ""
        met = sorted((self.events.enemies.get(self.map_id) or set()) if self.events else set())
        if not met:
            return ""
        return (
            f"提示:这张地图遇到过的怪物有 {'、'.join(met)},还没有战斗策略。"
            "用 set_tactics 针对它们写 2–3 套规则表(主策略和备用策略),普通战斗就会按策略打。"
        )

    def save_hint(self) -> str:
        """A save point on this map and no save for a while (10-20: run 8 walked past one with
        nothing saved since the canal): say so; saving stays the player's call."""
        if self.save_point is None:
            return ""
        last = self.events.last_save_minutes() if self.events else None
        if last is not None and last < 10:
            return ""
        since = "这次还没存过档" if last is None else f"上次存档是 {last:.0f} 分钟前"
        return f"提示:这张地图有存档点 {self.save_point},{since}。站上去用 save_game 可以存档。"

    def note_jump(self, text: str) -> None:
        """After interact: standing somewhere far from where the press was made, on the same
        map, means a jump stone (or a lift) carried the party; the atlas keeps it as a link."""
        m = re.search(r"站在 \((\d+), (\d+)\)", text)
        pos = pilot.send(self.laptop, "pos").get("pos") or {}
        cell = pos.get("cell")
        if not m or not cell or pos.get("state") != "Player":
            return
        start = [int(m.group(1)), int(m.group(2))]
        if abs(cell[0] - start[0]) + abs(cell[1] - start[1]) > 1:
            self.atlas.link(pos.get("map"), start, cell, "调查后跳")

    def floor(self, radius: int) -> str:
        """Towns, dungeons, the canal: the collision grid with the entities marked."""
        collision = pilot.send(self.laptop, "collision").get("collision") or {}
        grid = nav.layered_grid(collision, set())
        if grid is None:
            return "这里读不到地图(可能正在切换地图)"
        marks: dict[tuple[int, int], str] = {}
        for kind, (mark, _) in FLOOR_MARKS.items():
            found = pilot.send(self.laptop, "entities", kind=kind, max=200).get("entities") or {}
            for e in found.get("entities") or []:
                cell = e.get("cell")
                named = kind not in ("DefaultEntity", "DefaultAnimEntity") or (
                    e.get("name") and "吹き出し" not in e["name"] and "【汎用】" not in e["name"]
                )
                if e.get("active", True) and cell and named:
                    marks.setdefault(tuple(cell), mark)
        return render_floor(nav.layered_view(grid), radius, marks)

    def run(self, name: str, args: dict) -> str:
        if name in ("walk_to", "go_to"):
            legs: list[str] = []
            goal = (int(args["x"]), int(args["y"]))
            if move.flying(self.laptop) and self.world_entrance(goal):
                _, message = move.fly_in(self.laptop, goal, legs.append)
            else:
                ship = bool(args.get("by_ship"))
                _, message = move.navigate(self.laptop, goal, ship, legs.append)
            text = "\n".join([*legs, message])
        elif name == "terrain":
            radius = max(4, min(24, int(args.get("radius") or 12)))
            result = pilot.send(self.laptop, "cells", r=radius)
            cells = result.get("cells")
            world = cells and nav.has_terrain(cells)
            text = render_terrain(cells) if world else self.floor(radius)
        elif name == "entrances":
            result = pilot.send(self.laptop, "entities", kind="GotoMap", max=300)
            found = result.get("entities")
            text = view.describe_entities(found) if found else "这里读不到入口"
        elif name == "look_around":
            parts = []
            exits = pilot.send(self.laptop, "entities", kind="Event", max=200).get("entities")
            out = [
                e
                for e in (exits or {}).get("entities") or []
                if WORLD_EXIT in (e.get("name") or "")
            ]
            if out:
                parts.append(
                    "\n".join(
                        f"  出口 @ {e['cell']} 通往世界地图(事件点,走上去就出去)" for e in out
                    )
                )
            for kind in ("GotoMap", "TresureBox", "Npc", "DefaultEntity", "DefaultAnimEntity"):
                found = pilot.send(self.laptop, "entities", kind=kind, max=60).get("entities")
                if found and kind in ("DefaultEntity", "DefaultAnimEntity"):
                    found = view.named_objects(found)
                if found and found["entities"]:
                    lines = view.describe_entities(found).split("\n")[1:]
                    if kind == "GotoMap":  # which exits lead somewhere not seen yet
                        lines = [
                            line + self.atlas.mark(e["toMap"]) if "toMap" in e else line
                            for line, e in zip(lines, found["entities"], strict=False)
                        ]
                    parts.append("\n".join(lines))
            text = "\n".join(parts) or "附近没有入口、宝箱、NPC 或物体"
        elif name == "interact":
            text = move.open_at(self.laptop, (int(args["x"]), int(args["y"])))
            self.note_jump(text)
        elif name == "advance_story":
            result = pilot.send(self.laptop, "story", _wait=620, pageMs=3000, timeout=600000)
            why = result.get("stop") or result.get("error")
            text = f"翻了 {result.get('pages')} 页,停下原因:{why}"
        elif name == "choose":
            state = pilot.send(self.laptop, "pos")["pos"].get("state")
            if state in ("Shop", "Menu"):
                return "现在是商店/菜单界面,不是选项。要离开就用 leave_menu。"
            index = max(0, min(int(args["index"]), 9))
            # Bridge 0.4.0 reports where the cursor is; older ones start from the top.
            choice = (pilot.query(self.laptop, "sample").get("sample") or {}).get("choice") or {}
            open_ = next((c for c in choice.values() if isinstance(c, dict) and c.get("open")), {})
            at = open_.get("cursor") or 0
            step = "Down" if index >= at else "Up"
            keys = [step] * abs(index - at) + ["Enter"]
            result = pilot.send(self.laptop, "keys", keys=keys, gap=250)
            text = "已选择" if result.get("ok") else f"没选成:{result.get('error')}"
        elif name == "fight":
            plan = gambit.normalize(dict(args.get("plan") or {}))
            problems = gambit.check(plan)
            if problems:
                # Sent back before a key is pressed (§4.6): the battle waits for a full table.
                return "规则表没有通过检查,请改好再交:\n" + "\n".join(problems)
            result = battle.fight(self.laptop, plan, say=lambda _: None)
            done = "战斗结束" if result.get("ok") else f"战斗没打完:{result.get('error')}"
            text = f"{done};出招:{'、'.join(result.get('turns') or [])}"
            healed = battle.patch_up(self.laptop, say=lambda _: None) if result.get("ok") else []
            if healed:
                text += "\n战后回复:" + ";".join(healed)
        elif name == "sell":
            ok, text = shop.sell(self.laptop, args["item"], int(args.get("count") or 1))
            if ok and self.events:
                self.events.note("buy", text)
        elif name == "shop_gear":
            _, text = shop.gear_report(self.laptop)
        elif name == "buy":
            ok, text = shop.buy(self.laptop, args["product"], int(args.get("count") or 1))
            if ok and self.events:
                self.events.note("buy", text)
        elif name == "cast":
            _, text = menu.cast(self.laptop, args["caster"], args["spell"], args.get("target"))
        elif name == "leave_menu":
            text = menu.leave_menu(self.laptop)
        elif name == "save_game":
            _, text = save.save_game(self.laptop, 3)
        elif name == "land":
            _, text = move.land(self.laptop, say=lambda _: None)
        elif name == "board":
            _, text = move.board(self.laptop, say=lambda _: None)
        elif name == "optimize_equipment":
            ok, text = menu.optimize_equipment(self.laptop)
            if ok and self.events:
                self.events.note("equip", text)
        elif name == "set_tactics":
            tables = [gambit.normalize(dict(t)) for t in args.get("tables") or [] if t]
            problems = [f"第 {i} 套:{p}" for i, t in enumerate(tables, 1) for p in gambit.check(t)]
            if not tables or problems:
                return "策略没有通过检查,请改好再交:\n" + ("\n".join(problems) or "至少要一套")
            map_id = args.get("map") or (pilot.send(self.laptop, "pos").get("pos") or {}).get("map")
            self.tactics.set(int(map_id), tables)
            text = (
                f"已为地图 {map_id} 设好 {len(tables)} 套战斗策略;"
                "普通战斗先用第 1 套,打得不好会自动换下一套。"
            )
        elif name == "guide":
            if self.guide is None:
                return "攻略知识库还没有准备好(要先运行 ffpr-guide fetch)"
            query = str(args.get("query") or "")
            kind = str(args.get("kind") or "area")
            text = self.guide.lookup(query, part=int(args.get("part") or 1), kind=kind) or (
                f"攻略里没有找到「{query}」;换个说法(英文名、地区名或图鉴编号)再查"
            )
            return text
        elif name == "atlas":
            text = self.atlas.describe(self.chart())
        elif name == "inventory":
            text = view.describe_items(pilot.query(self.laptop, "items").get("items") or {})
        elif name == "remember":
            self.notes = [*self.notes, args["note"]][-MAX_NOTES:]
            save_notes(self.notes_file, self.notes)
            return f"已记下(第 {len(self.notes)} 条)"
        elif name == "forget":
            index = int(args["index"]) - 1
            if not 0 <= index < len(self.notes):
                return f"没有第 {index + 1} 条笔记"
            removed = self.notes.pop(index)
            save_notes(self.notes_file, self.notes)
            return f"已删除:{removed}"
        else:
            return f"未知工具 {name}"
        settled = self.settle()
        self.map_id = self.chart()
        self.keep_drake()
        gear = self.check_gear()
        news = self.news()
        hints = (self.guide_hint(), self.save_hint(), self.tactics_hint(), self.town_hint())
        hint = "\n".join(x for x in hints if x)
        parts = (
            text,
            settled,
            gear,
            news and "新的重要事件:\n" + news,
            hint,
            "当前状态:\n" + self.observe(),
        )
        return "\n".join(x for x in parts if x)
