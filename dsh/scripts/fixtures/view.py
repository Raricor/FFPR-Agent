"""Export view.py results for the TypeScript port's comparison tests."""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[2]
BASE = REPO.parent
sys.path.insert(0, str(BASE / "agent" / "src"))
sys.path.insert(0, str(BASE / "common" / "src"))

from ffpr_agent import view  # noqa: E402

OUT = REPO / "test" / "fixtures" / "view"


def save(name, data):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def probe_records():
    for path in sorted((BASE / ".deps" / "ff5" / "probe").glob("probe-*.jsonl")):
        records = []
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        yield path, records


def find_samples():
    wanted = {
        "field": lambda r: (
            r.get("type") == "sample"
            and r.get("field")
            and r.get("party")
            and not (r.get("battle") or {}).get("active")
        ),
        "dialog": lambda r: r.get("type") == "sample" and (r.get("dialog") or {}).get("open"),
        "choice": lambda r: (
            r.get("type") == "sample"
            and any(
                isinstance(v, dict) and v.get("open") and (v.get("labels") or v.get("options"))
                for v in (r.get("choice") or {}).values()
            )
        ),
        "battle": lambda r: (
            r.get("type") == "sample"
            and isinstance(r.get("battle"), dict)
            and (r["battle"].get("enemies") or r["battle"].get("players"))
        ),
        "empty": lambda r: r.get("type") == "sample" and r.get("scene", {}).get("name") is None,
    }
    found = {}
    events = {}
    for _, records in probe_records():
        for record in records:
            for name, predicate in wanted.items():
                if name not in found and predicate(record):
                    found[name] = record
            kind = record.get("type")
            if kind in {
                "dialog.play",
                "choice.open",
                "sysmsg",
                "map.change",
                "save.write",
                "achievement.progress",
            }:
                events.setdefault(kind, record)
        if len(found) == len(wanted) and len(events) >= 5:
            break
    return found, events


def main():
    samples, events = find_samples()
    cases = [
        {"sample": samples["field"], "events": [events["map.change"], events["dialog.play"]]},
        {"sample": samples["dialog"], "events": [events["sysmsg"], events["choice.open"]]},
        {"sample": samples["choice"], "events": []},
        {
            "sample": samples["battle"],
            "events": [events["save.write"], events["achievement.progress"]],
        },
        {"sample": samples["empty"], "events": [events["dialog.play"]]},
    ]
    for case in cases:
        case["text"] = view.summarize(case["sample"], case["events"])

    items = {
        "normal": [
            {"name": "<IC_DRAG>恢复药", "count": 3},
            {"name": "<IC_STAR>不死鸟之尾", "count": 1},
            {"name": "空手", "count": 1},
            {"name": "无", "count": 1},
            {"name": "<IC_KEY>", "count": 2},
        ],
        "important": [
            {"name": "<IC_KEY>运河的钥匙", "count": 1},
            {"name": "", "count": 1},
        ],
    }
    found = {
        "total": 5,
        "entities": [
            {
                "kind": "GotoMap",
                "cell": [12, 21],
                "toMap": 242,
                "name": "",
                "active": True,
            },
            {
                "kind": "TresureBox",
                "tile": [13, 54],
                "content": "フレイル",
                "num": 1,
                "name": "宝箱",
            },
            {
                "kind": "Npc",
                "cell": [12, 19],
                "npc": 0,
                "name": "兵士(色違い：黄)",
            },
            {
                "kind": "DefaultEntity",
                "cell": [12, 7],
                "name": "閉まっている扉",
                "active": False,
            },
            {"kind": "DefaultEntity", "cell": [17, 18], "name": "トルナ運河の開錠_右扉"},
        ],
    }
    named_input = {
        "total": 7,
        "entities": [
            {"kind": "DefaultEntity", "cell": [17, 18], "name": "トルナ運河の開錠_右扉"},
            {"kind": "DefaultEntity", "cell": [39, 32], "name": "x", "active": False},
            {"kind": "DefaultEntity", "cell": [4, 0], "name": "【汎用】海賊船"},
            {"kind": "DefaultEntity", "cell": [128, 128], "name": ""},
            {"kind": "DefaultAnimEntity", "cell": [8, 7], "name": "クリスタルかけら"},
            {"kind": "Npc", "cell": [12, 17], "name": "ガルラ吹き出し"},
            {"kind": "Npc", "cell": [12, 19], "name": "兵士(色違い：黄)", "active": True},
        ],
    }
    tail_path = sorted((BASE / ".deps" / "ff5" / "probe").glob("probe-*.jsonl"))[0]
    tail_lines = tail_path.read_text(encoding="utf-8").splitlines()[:6]
    tail_text = "probe-cut-line\n" + "\n".join(tail_lines[1:])

    statuses = [
        {"unit": {"name": "蕾娜", "hp": 12, "maxHp": 100, "status": ["Poison", ""]}},
        {"unit": {"name": "巴兹", "status": ["Blind", "Silence"]}},
        {"unit": {"name": "法利斯", "status": []}},
        {"unit": {}},
    ]

    save(
        "view.json",
        {
            "items": {"input": items, "text": view.describe_items(items)},
            "entities": {"input": found, "text": view.describe_entities(found)},
            "namedObjects": {"input": named_input, "out": view.named_objects(named_input)},
            "parseTail": {"text": tail_text, "out": view.parse_tail(tail_text)},
            "marks": [{"unit": unit["unit"], "out": view.marks(unit["unit"])} for unit in statuses],
            "summarize": cases,
        },
    )


if __name__ == "__main__":
    main()
