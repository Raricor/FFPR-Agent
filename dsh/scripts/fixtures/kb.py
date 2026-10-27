"""Export guide lookups from the cached guide index (port fixture).

Run from dsh-port-04:
    PYTHONDONTWRITEBYTECODE=1 /root/data/mediaflow/FFPR-Agent/.venv/bin/python \
        scripts/fixtures/kb.py
"""

import json
import tempfile
from pathlib import Path

from ffpr_agent.guide.kb import Guide

REPO = Path("/root/data/mediaflow/FFPR-Agent")
SOURCE = REPO / ".deps" / "knowledge" / "ff5" / "guide.json"
OUT = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "kb" / "cases.json"
TITLES = {
    "Tule",
    "Walse",
    "Tower of Walse",
    "Karnak",
    "Carwen",
    "Ship Graveyard",
    "Crescent and Black Chocobo Forest",
    "Istory",
}


def main() -> None:
    full = json.loads(SOURCE.read_text(encoding="utf-8"))
    data = {
        "fetched": full["fetched"],
        "sources": full["sources"],
        "walkthrough": [s for s in full["walkthrough"] if s["title"] in TITLES],
        "missables": full["missables"],
        "bestiary": full["bestiary"],
        "ludo": full["ludo"],
    }
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "guide.json"
        path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        guide = Guide.load(path)
        assert guide is not None
        cases = []

        def add(method: str, args: dict, kwargs: dict | None = None) -> None:
            kwargs = kwargs or {}
            value = getattr(guide, method)(**args, **kwargs)
            if not isinstance(value, str):
                value = list(value)
            cases.append({"method": method, "args": args, "kwargs": kwargs, "expected": value})

        add("lookup", {"query": "沃尔斯城"})
        add("lookup", {"query": "沃尔斯塔"})
        add("lookup", {"query": "图尔村"})
        add("lookup", {"query": "卡文镇"})
        add("lookup", {"query": "30"})
        add("lookup", {"query": "#30"})
        add("lookup", {"query": "Jackanapes"})
        add("lookup", {"query": "没有这个地方"})
        add("lookup", {"query": "沃尔斯城"}, {"kind": "shop"})
        add("lookup", {"query": "沃尔斯城"}, {"kind": "treasure"})
        add("lookup", {"query": "沃尔斯城"}, {"part": 2})
        add("warnings", {"area": "沃尔斯塔"})
        add("warnings", {"area": "沃尔斯城"})
        add("monster_note", {"book": 30})
        add("monster_note", {"book": 99})
        add("search", {"q": "one-visit"})
        add("area", {"query": "沃尔斯城"}, {"limit": 300, "part": 2})
        sections = guide.sections_for("沃尔斯城")
        cases.append(
            {
                "method": "sections_for",
                "args": {"query": "沃尔斯城"},
                "kwargs": {},
                "expected": [section["title"] for section in sections],
            }
        )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps({"data": data, "cases": cases}, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"{len(cases)} cases, {len(data['walkthrough'])} sections -> {OUT}")
    print(f"fixture {OUT.stat().st_size // 1024} KiB")
    for case in cases:
        print(
            case["method"],
            case["args"],
            case["kwargs"],
            len(case["expected"]),
            repr(case["expected"][:60]),
        )


if __name__ == "__main__":
    main()
