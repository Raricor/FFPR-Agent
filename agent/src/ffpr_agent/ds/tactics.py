"""Battle tactics per map (control plan §4.10): the rule tables the player wrote for a map's
monsters, a main one and spares, which one is in use, and how the battles went. Regular
battles on that map use the table in use; a battle that went badly moves to the next one.

    tactics = Tactics(path)
    tactics.set(64, [table_a, table_b])     # from the player's set_tactics
    tactics.current(64)                     # table_a
    tactics.record(64, "hard", "巴兹倒下")   # → table_b from the next battle on
"""

import json
from pathlib import Path

BAD = {"lost", "hard"}  # a wipe, or someone down / the party under 40% HP


class Tactics:
    def __init__(self, path: Path | None = None):
        self.path = path
        self.maps: dict[str, dict] = {}
        if path is not None and path.exists():
            self.maps = json.loads(path.read_text(encoding="utf-8"))

    def set(self, map_id, tables: list[dict]) -> None:
        self.maps[str(map_id)] = {"tables": tables, "current": 0, "results": []}
        self.save()

    def has(self, map_id) -> bool:
        return bool((self.maps.get(str(map_id)) or {}).get("tables"))

    def current(self, map_id) -> dict | None:
        entry = self.maps.get(str(map_id)) or {}
        tables = entry.get("tables") or []
        return tables[entry.get("current", 0) % len(tables)] if tables else None

    def record(self, map_id, verdict: str, detail: str) -> str:
        """Note how a battle went; a bad one switches to the next table. Returns what to tell
        the player ("" when the map has no tactics)."""
        entry = self.maps.get(str(map_id))
        if not entry or not entry.get("tables"):
            return ""
        index = entry.get("current", 0)
        entry.setdefault("results", []).append(
            {"table": index, "verdict": verdict, "detail": detail}
        )
        entry["results"] = entry["results"][-30:]
        text = ""
        if verdict in BAD:
            count = len(entry["tables"])
            entry["current"] = (index + 1) % count
            tried = {r["table"] for r in entry["results"] if r["verdict"] in BAD}
            text = f"策略 {index + 1} 打得不好({detail}),下一场换策略 {entry['current'] + 1}"
            if len(tried) >= count:
                text += ";这张地图的每套策略都失败过,考虑练级、换职业或换装备,或者重写策略"
        self.save()
        return text

    def describe(self, map_id) -> str:
        entry = self.maps.get(str(map_id)) or {}
        tables = entry.get("tables") or []
        if not tables:
            return "这张地图还没有战斗策略"
        bad = [r for r in entry.get("results") or [] if r["verdict"] in BAD]
        return (
            f"这张地图有 {len(tables)} 套策略,正在用第 {entry.get('current', 0) + 1} 套;"
            f"打得不好的记录 {len(bad)} 次"
        )

    def save(self) -> None:
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.maps, ensure_ascii=False, indent=1), "utf-8")
