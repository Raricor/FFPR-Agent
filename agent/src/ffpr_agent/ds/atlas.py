"""The maps seen so far, with their exits and where each leads, kept across runs: in a maze
like the Ship Graveyard the player can tell the exits it has been through from the ones it
has not, instead of walking back into rooms it already searched (10-20, run 7).

The game side records a map whenever the player is on it (Game.chart); the player reads it
with the `atlas` tool, and look_around marks each exit visited or not.
"""

import json
from pathlib import Path


class Atlas:
    def __init__(self, path: Path | None = None):
        self.path = path
        self.maps: dict[str, dict] = {}
        if path is not None and path.exists():
            self.maps = json.loads(path.read_text(encoding="utf-8"))

    def visited(self, map_id) -> bool:
        return str(map_id) in self.maps

    def visit(self, map_id, name: str, exits: list[dict], chests: list[dict]) -> None:
        """Record what the player sees on a map: exits as {"cell", "to", "name"}, chests as
        {"cell", "name"}. Links found by walking (jumps) are kept."""
        old = self.maps.get(str(map_id)) or {}
        entry = {"name": name or "", "exits": exits, "chests": chests}
        if old.get("links"):
            entry["links"] = old["links"]
        if old == entry:
            return
        self.maps[str(map_id)] = entry
        self.save()

    def link(self, map_id, start: list[int], end: list[int], how: str) -> None:
        """A way between two cells that are not next to each other, found by doing it: a jump
        stone (interact at one, land on the other). The grid cannot show these."""
        entry = self.maps.setdefault(str(map_id), {"name": "", "exits": [], "chests": []})
        link = {"from": list(start), "to": list(end), "how": how}
        if link not in entry.setdefault("links", []):
            entry["links"].append(link)
            self.save()

    def save(self) -> None:
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.maps, ensure_ascii=False, indent=1), "utf-8")

    def mark(self, to) -> str:
        if str(to) == "1":
            return "(世界地图)"
        return "(去过)" if self.visited(to) else "(没去过)"

    def describe(self, around=None, limit: int = 30) -> str:
        """Every map seen, its exits with where they lead and whether that map was visited;
        the current map first. World maps are left out (their exits are towns)."""
        ids = sorted(self.maps, key=lambda m: (m != str(around), m))
        lines = []
        for map_id in ids[:limit]:
            entry = self.maps[map_id]
            if map_id == "1":
                continue
            here = "(你在这里)" if map_id == str(around) else ""
            exits = "、".join(
                f"{tuple(e['cell'])}→地图 {e['to']} {e.get('name', '')}{self.mark(e['to'])}"
                for e in entry.get("exits") or []
            )
            chests = "、".join(
                f"{tuple(c['cell'])} {c.get('name', '')}" for c in entry.get("chests") or []
            )
            lines.append(f"地图 {map_id} {entry.get('name', '')}{here}:出口 {exits or '无'}")
            if chests:
                lines.append(f"    宝箱 {chests}")
            links = "、".join(
                f"在 {tuple(k['from'])} {k['how']} 到 {tuple(k['to'])}"
                for k in entry.get("links") or []
            )
            if links:
                lines.append(f"    走法 {links}")
        return "\n".join(lines) or "还没有记录任何地图"
