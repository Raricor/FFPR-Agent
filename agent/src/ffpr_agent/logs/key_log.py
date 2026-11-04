"""Build the key log (design doc §12.2) from bridge probe logs.

v0 works offline on the dev box, from files fetched with `ffpr-laptop probe-logs`:

    uv run ffpr-keylog ff5                # every probe file in .deps/ff5/probe
    uv run ffpr-keylog ff5 --out key/     # write key-ff5.jsonl and ff5.md there

Each probe file is one run (one game start). Entries come from what the bridge reports:
chest dialogs (ID prefix T) and the game's chest counter, "得到了【X】" lines, party levels,
who joins and leaves the party, story scenes (dialog IDs with prefix E, one entry per scene),
battles (with enemy names from bridge 0.3.0), bestiary registrations, saves and first visits.
Bosses come from the monster master's boss flag (bridge 0.3.1+); for older logs a battle won
without gil is marked as a likely boss. Whether a battle was won, fled or lost comes from the
game's own counters (wins, escapes) when the samples carry them.

The same Builder runs live on the dev box (ffpr_agent.events), fed from the bridge's stream;
its entries are the windows of key events the planning layers read.
"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from ffpr_agent.repo import REPO

SHANGHAI = ZoneInfo("Asia/Shanghai")

LABEL = {
    "run": "运行",
    "place": "地点",
    "chest": "宝箱",
    "item": "道具",
    "level": "升级",
    "party": "队伍",
    "story": "剧情",
    "bossfight": "首领战",
    "boss": "首领",
    "defeat": "战败",
    "bestiary": "图鉴",
    "save": "存档",
    "buy": "购买",
    "equip": "装备",
}

BRACKETED = re.compile(r"【([^】]+)】")
GOT = re.compile(r"(得到了|获得了|拿到了)")
SCENE = re.compile(r"^(E\d+_\d+_\d+)")
# A scene's lines more than this far apart are two visits (the same scene can replay).
SCENE_GAP_S = 120


def local_time(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone(SHANGHAI)


def load(path: Path) -> list[dict]:
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # the game may be mid-write on the last line
    return records


def counters(user: dict) -> tuple[int | None, int | None]:
    return user.get("wins"), user.get("escapes")


def scene_of(ids: list[str]) -> str | None:
    """The story scene a dialog belongs to: E0001_00_071 for E0001_00_071_a_01."""
    for i in ids:
        m = SCENE.match(i or "")
        if m:
            return m.group(1)
    return None


def party_levels(sample: dict) -> dict[str, int]:
    party = sample.get("party")
    if not isinstance(party, list):
        return {}
    return {c["name"]: c["lv"] for c in party if c.get("name") and c.get("lv") is not None}


class Builder:
    """Walks one run's records in order and emits key entries."""

    def __init__(self, run: str):
        self.run = run
        self.entries: list[dict] = []
        self.levels: dict[str, int] = {}
        self.places: set[str] = set()
        self.chests: int | None = None
        self.gil: int | None = None
        self.picture_book: int | None = None
        self.battle: dict | None = None
        self.party: list[str] | None = None
        self.story: dict | None = None  # the scene entry lines are being added to
        self.story_at: datetime | None = None
        self.pending_chest: dict | None = None
        # The level entry being merged: {name: [from, to]} and when it was last updated.
        self.level_changes: dict[str, list[int]] = {}
        self.level_at: datetime | None = None

    def add(self, record: dict, kind: str, text: str, progress: str = "—", **data) -> None:
        self.entries.append(
            {
                "ts": local_time(record["t"]).isoformat(timespec="seconds"),
                "run": self.run,
                "seq": record.get("seq"),
                "key": True,
                "type": kind,
                "text": text,
                "progress": progress,
                **({"data": data} if data else {}),
            }
        )

    def feed(self, r: dict) -> None:
        handler = getattr(self, "on_" + r["type"].replace(".", "_"), None)
        if handler:
            handler(r)

    def on_hello(self, r: dict) -> None:
        self.add(
            r,
            "run",
            f"开始:{r.get('product')} {r.get('gameVersion')},桥插件 {r.get('plugin')}",
        )

    def on_sample(self, r: dict) -> None:
        user = r.get("user") or {}
        battle = r.get("battle") or {}
        place = user.get("areaText")
        if place and place not in self.places:
            self.places.add(place)
            self.add(r, "place", f"首次到达「{place}」", map=user.get("mapId"))

        chests = user.get("chests")
        if self.pending_chest is not None and chests is not None:
            item, record = self.pending_chest
            progress = f"本作已开 {chests} 个" if chests else "—"
            self.add(record, "chest", f"地图 {user.get('mapId')}:{item}", progress, item=item)
            self.pending_chest = None
        if chests is not None:
            self.chests = chests

        if battle.get("active"):
            if self.battle is None:
                self.battle = {
                    "record": r,
                    "gil": self.gil,
                    "counts": counters(user),
                    "enemies": [],
                    "boss": None,
                    "announced": False,
                }
                self.level_at = None  # level-ups after this battle get their own entry
            names = [e.get("name") for e in battle.get("enemies") or [] if e.get("name")]
            if names:
                self.battle["enemies"] = names
            if "boss" in battle:  # bridge 0.3.1+: the monster master's boss flag
                self.battle["boss"] = bool(battle["boss"]) or bool(self.battle["boss"])
            if self.battle["boss"] and self.battle["enemies"] and not self.battle["announced"]:
                self.battle["announced"] = True
                enemies = "、".join(dict.fromkeys(self.battle["enemies"]))
                self.add(r, "bossfight", f"开始:「{enemies}」", enemies=self.battle["enemies"])
        elif self.battle is not None:
            self.end_battle(r, user)

        names = [c.get("name") for c in r.get("party") or [] if c.get("name")]
        if names:  # empty on the title screen and while a save loads
            self.party_change(r, names)

        levels = party_levels(r)
        ups = {n: lv for n, lv in levels.items() if lv > self.levels.get(n, lv)}
        if ups:
            self.level_up(r, ups, min(levels.values()))
        if levels:
            self.levels = levels
        if user.get("gil") is not None:
            self.gil = user["gil"]

    def party_change(self, r: dict, names: list[str]) -> None:
        if self.party is not None:
            size = f"队伍 {len(names)} 人"
            for name in self.party:
                if name not in names:
                    self.add(r, "party", f"{name} 离队", size, name=name, change="leave")
            for name in names:
                if name not in self.party:
                    self.add(r, "party", f"{name} 入队", size, name=name, change="join")
        self.party = names

    def level_up(self, r: dict, ups: dict[str, int], lowest: int) -> None:
        """One entry per battle: the result screen updates members one by one, so changes
        within 90 s with no other entry in between join the previous level entry."""
        now = local_time(r["t"])
        last = self.entries[-1] if self.entries else None
        joined = (
            last is not None
            and last["type"] == "level"
            and self.level_at is not None
            and (now - self.level_at).total_seconds() <= 90
        )
        if not joined:
            self.level_changes = {}
            self.add(r, "level", "", "")
            last = self.entries[-1]
        for name, lv in ups.items():
            self.level_changes.setdefault(name, [self.levels[name], lv])[1] = lv
        last["text"] = "、".join(f"{n} {a}→{b}" for n, (a, b) in self.level_changes.items())
        last["progress"] = f"全员最低 Lv{lowest}"
        self.level_at = now

    def end_battle(self, r: dict, user: dict) -> None:
        start, self.battle = self.battle, None
        gained = (user.get("gil") or 0) - (start["gil"] or 0)
        party = r.get("party") or []
        alive = all((c.get("hp") or 0) > 0 for c in party)
        wiped = bool(party) and all((c.get("hp") or 0) <= 0 for c in party)
        down = [c["name"] for c in party if (c.get("hp") or 0) <= 0 and c.get("name")]
        enemies = "、".join(dict.fromkeys(start["enemies"])) or "未知敌人"
        (wins, escapes), (wins_now, escapes_now) = start["counts"], counters(user)
        outcome = None
        if None not in (wins, escapes, wins_now, escapes_now):
            outcome = "win" if wins_now > wins else "fled" if escapes_now > escapes else "lost"
        if outcome == "lost" or (outcome is None and wiped):
            what = f"全灭:「{enemies}」" if wiped else f"没有打赢「{enemies}」(战斗中止)"
            self.add(r, "defeat", what, boss=bool(start["boss"]), enemies=start["enemies"])
            return
        if outcome == "fled":
            if start["boss"]:
                self.add(r, "bossfight", f"从「{enemies}」逃跑", enemies=start["enemies"])
            return
        if start["boss"] is not None:
            if start["boss"] and (outcome == "win" or alive):
                fallen = f",{'、'.join(down)} 倒下" if down else ""
                self.add(r, "boss", f"击败「{enemies}」{fallen}", enemies=start["enemies"])
            return
        # Logs from before bridge 0.3.1 lack the flag. Bosses in FF5 drop no gil and regular
        # encounters always do, so a gil-less win is the best signal there.
        if gained == 0 and alive and start["gil"] is not None:
            text = f"击败「{enemies}」(推测为首领:战后没有金钱)"
            self.add(r, "boss", text, enemies=start["enemies"])

    def on_dialog_play(self, r: dict) -> None:
        lines = [x for x in r.get("lines") or [] if x]
        text = "".join(lines)
        ids = r.get("ids") or []
        scene = scene_of(ids)
        if scene and text:
            self.story_line(r, scene, r.get("speaker") or "", text)
        item = BRACKETED.search(text)
        if any(i.startswith("T") for i in ids) and "宝箱中发现了" in text and item:
            # Written once the chest counter in the next sample confirms it.
            self.pending_chest = (item.group(1), r)
        elif item and GOT.search(text):
            self.add(r, "item", f"得到「{item.group(1)}」", source="事件")

    def story_line(self, r: dict, scene: str, speaker: str, text: str) -> None:
        """One entry per scene: its lines are added as the pages come."""
        now = local_time(r["t"])
        current = self.story
        same = (
            current is not None
            and current["data"]["scene"] == scene
            and self.story_at is not None
            and (now - self.story_at).total_seconds() <= SCENE_GAP_S
        )
        if not same:
            self.add(r, "story", "", "", scene=scene, lines=[])
            current = self.story = self.entries[-1]
        lines = current["data"]["lines"]
        lines.append(f"{speaker}:{text}" if speaker else text)
        first, last = lines[0], lines[-1]
        current["text"] = first if len(lines) == 1 else f"{first} …… {last}"
        current["progress"] = f"{len(lines)} 句"
        self.story_at = now

    def on_bestiary_register(self, r: dict) -> None:
        progress = f"图鉴 {self.picture_book}" if self.picture_book else "—"
        self.add(r, "bestiary", f"新增怪物 #{r.get('monster')}", progress, monster=r.get("monster"))

    def on_steam_setProgress(self, r: dict) -> None:
        if r.get("api") == "picture_book":
            self.picture_book = r.get("value")

    on_achievement_steamProgress = on_steam_setProgress  # bridge before 0.1.1

    def on_save_write(self, r: dict) -> None:
        ok = r.get("result") in (None, "Success", "Succeeded", "Ok")
        self.add(
            r, "save", f"存档到 {r.get('slot')} 号位" + ("" if ok else f"(结果 {r.get('result')})")
        )


def build(path: Path) -> list[dict]:
    builder = Builder(run=path.stem.removeprefix("probe-"))
    for record in load(path):
        builder.feed(record)
    return builder.entries


def render(game: str, runs: list[tuple[str, list[dict]]]) -> str:
    out = [f"# 关键日志 · {game.upper()}", ""]
    for run, entries in runs:
        if not entries:
            continue
        day = entries[0]["ts"][:10]
        out += [
            f"## {day} 运行 {run}",
            "",
            "| 时间 | 类型 | 内容 | 进度 |",
            "| --- | --- | --- | --- |",
        ]
        for e in entries:
            cells = [e["ts"][11:16], LABEL.get(e["type"], e["type"]), e["text"], e["progress"]]
            out.append("| " + " | ".join(c.replace("|", "\\|") for c in cells) + " |")
        out.append("")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="从探针日志生成关键日志")
    parser.add_argument("game", help="作品,如 ff5(读 .deps/<作品>/probe 下所有探针文件)")
    parser.add_argument("--out", type=Path, default=None, help="输出目录,默认 .deps/<作品>/key")
    args = parser.parse_args(argv)
    files = sorted((REPO / ".deps" / args.game / "probe").glob("probe-*.jsonl"))
    if not files:
        print(f"没有探针文件:先运行 uv run ffpr-laptop probe-logs {args.game}")
        return 1
    runs = [(f.stem.removeprefix("probe-"), build(f)) for f in files]
    out = args.out or REPO / ".deps" / args.game / "key"
    out.mkdir(parents=True, exist_ok=True)
    with (out / f"key-{args.game}.jsonl").open("w", encoding="utf-8") as f:
        for _, entries in runs:
            for e in entries:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
    (out / f"{args.game}.md").write_text(render(args.game, runs), encoding="utf-8")
    total = sum(len(e) for _, e in runs)
    print(f"{len(runs)} 次运行,{total} 条关键事件 → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
