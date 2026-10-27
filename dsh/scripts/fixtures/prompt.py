"""Export ds/prompt.py results for the TypeScript port's comparison tests."""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[2]
BASE = REPO.parent
sys.path.insert(0, str(BASE / "agent" / "src"))
sys.path.insert(0, str(BASE / "common" / "src"))

from ffpr_agent import nav  # noqa: E402
from ffpr_agent.ds import prompt  # noqa: E402

OUT = REPO / "test" / "fixtures" / "prompt"


def save(name, data):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def find_records():
    battle = None
    party = None
    for path in sorted((BASE / ".deps" / "ff5" / "probe").glob("probe-*.jsonl")):
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("type") != "sample":
                    continue
                if party is None and any(
                    "jobName" in member for member in record.get("party") or []
                ):
                    party = record["party"]
                data = record.get("battle")
                if battle is None and isinstance(data, dict) and data.get("enemies"):
                    battle = data
        if battle and party:
            break
    return battle, party


def main():
    cells = json.loads((BASE / ".deps" / "pilot" / "cells-map1.json").read_text(encoding="utf-8"))
    cells_b = json.loads(
        (BASE / ".deps" / "pilot" / "cells-map1-b.json").read_text(encoding="utf-8")
    )
    tiny = {"origin": [9, 4], "center": [10, 5], "attr": [[16, 19, 3], [10, 3, 99]]}
    terrain_cases = [
        {"cells": cells, "text": prompt.render_terrain(cells)},
        {"cells": cells_b, "text": prompt.render_terrain(cells_b)},
        {"cells": tiny, "text": prompt.render_terrain(tiny)},
    ]

    carwen = {
        "playerCell": [0, 2],
        "searchLayer": 0,
        "layers": [
            {"name": "BottomCollision", "rows": ["111", "111", "000"]},
            {"name": "GroundCollision", "rows": ["000", "013", "111"]},
        ],
    }
    real = json.loads((BASE / ".deps" / "pilot" / "collision-202.json").read_text(encoding="utf-8"))
    views = [
        {
            "name": "Carwen street and terrace",
            "view": nav.layered_view(nav.layered_grid(carwen, set())),
            "radius": 4,
            "marks": [
                {"cell": [0, 0], "mark": "E"},
                {"cell": [1, 0], "mark": "T"},
                {"cell": [2, 0], "mark": "N"},
                {"cell": [0, 2], "mark": "!"},
            ],
        },
        {
            "name": "Wind Shrine map 202 layered",
            "view": nav.layered_view(nav.layered_grid(real, set())),
            "radius": 12,
            "marks": [
                {"cell": [1, 3], "mark": "T"},
                {"cell": [2, 1], "mark": "O"},
                {"cell": [18, 20], "mark": "!"},
                {"cell": [30, 5], "mark": "E"},
            ],
        },
        {
            "name": "small hand-made view",
            "view": {"center": [2, 1], "rows": ["####", "#...", "#.##"]},
            "radius": 4,
            "marks": [{"cell": [3, 1], "mark": "!"}, {"cell": [1, 2], "mark": "T"}],
        },
    ]
    for case in views:
        marks = {tuple(item["cell"]): item["mark"] for item in case["marks"]}
        case["text"] = prompt.render_floor(case["view"], case["radius"], marks)

    battle, party = find_records()
    battle_cases = [
        {"battle": battle, "party": party, "text": prompt.describe_battle(battle, party)},
        {
            "battle": {
                "players": [
                    {
                        "name": "蕾娜",
                        "hp": 60,
                        "maxHp": 142,
                        "mp": 16,
                        "status": ["Poison", "Blind"],
                    },
                    {"name": "加拉夫", "hp": 0, "maxHp": 215, "mp": 19},
                ]
            },
            "party": [
                {"name": "蕾娜", "jobName": "白魔法师"},
                {"name": "加拉夫", "jobName": "武僧"},
            ],
            "text": prompt.describe_battle(
                {
                    "players": [
                        {
                            "name": "蕾娜",
                            "hp": 60,
                            "maxHp": 142,
                            "mp": 16,
                            "status": ["Poison", "Blind"],
                        },
                        {"name": "加拉夫", "hp": 0, "maxHp": 215, "mp": 19},
                    ]
                },
                [
                    {"name": "蕾娜", "jobName": "白魔法师"},
                    {"name": "加拉夫", "jobName": "武僧"},
                ],
            ),
        },
    ]

    save(
        "prompt.json",
        {
            "systemPrompt": prompt.SYSTEM_PROMPT,
            "tools": prompt.TOOLS,
            "terrain": {
                "entries": [[code, list(value)] for code, value in prompt.TERRAIN.items()],
                "cases": terrain_cases,
            },
            "floor": {
                "marks": [[kind, list(value)] for kind, value in prompt.FLOOR_MARKS.items()],
                "cases": views,
            },
            "battle": battle_cases,
        },
    )


if __name__ == "__main__":
    main()
