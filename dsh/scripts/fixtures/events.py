"""Export KeyEvents windows/news from the same real probe records as keylog.py.

Run from dsh-port-04:
    PYTHONDONTWRITEBYTECODE=1 /root/data/mediaflow/FFPR-Agent/.venv/bin/python \
        scripts/fixtures/events.py
"""

import json
from datetime import timedelta
from pathlib import Path

from ffpr_agent import events as ev
from ffpr_agent.logs.key_log import local_time

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "test" / "fixtures" / "keylog" / "runs.json"
OUT = ROOT / "test" / "fixtures" / "events" / "runs.json"


def now_at(records: list[dict], count: int, extra_minutes: int = 1):
    stamp = records[max(0, count - 1)]["t"]
    return local_time(stamp) + timedelta(minutes=extra_minutes)


def run_calls(events: ev.KeyEvents, calls: list[dict]) -> list[str]:
    out = []
    for call in calls:
        if call["op"] == "window":
            out.append(events.window(call["layer"]))
        else:
            out.append(events.news(call["layer"]))
    return out


def main() -> None:
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    runs = []
    for run in data["runs"]:
        records = run["records"]
        split = len(records) // 2
        stages = []
        clock = [now_at(records, split)]
        events = ev.KeyEvents(now=lambda clock=clock: clock[0])
        for record in records[:split]:
            events.feed(record, live=False)
        first_calls = [
            {"op": "window", "layer": 1},
            {"op": "window", "layer": 2},
            {"op": "news", "layer": 2},
        ]
        stages.append(
            {
                "feed": split,
                "now": clock[0].isoformat(timespec="seconds"),
                "calls": first_calls,
                "expected": run_calls(events, first_calls),
            }
        )
        for record in records[split:]:
            events.feed(record, live=False)
        clock[0] = now_at(records, len(records))
        second_calls = [
            {"op": "news", "layer": 1},
            {"op": "news", "layer": 2},
            {"op": "window", "layer": 1},
            {"op": "window", "layer": 2},
        ]
        stages.append(
            {
                "feed": len(records),
                "now": clock[0].isoformat(timespec="seconds"),
                "calls": second_calls,
                "expected": run_calls(events, second_calls),
            }
        )
        late_clock = [now_at(records, len(records), extra_minutes=30)]
        late_events = ev.KeyEvents(now=lambda late_clock=late_clock: late_clock[0])
        for record in records:
            late_events.feed(record, live=False)
        late_calls = [{"op": "window", "layer": 2}]
        enemies = [
            {"mapId": map_id, "names": sorted(names)} for map_id, names in events.enemies.items()
        ]
        runs.append(
            {
                "name": run["name"],
                "records": records,
                "stages": stages,
                "late": {
                    "now": late_clock[0].isoformat(timespec="seconds"),
                    "calls": late_calls,
                    "expected": run_calls(late_events, late_calls),
                },
                "entries": events.entries,
                "enemies": enemies,
                "books": [
                    {"name": name, "book": book} for name, book in sorted(events.books.items())
                ],
            }
        )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"runs": runs}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(runs)} runs -> {OUT}")


if __name__ == "__main__":
    main()
