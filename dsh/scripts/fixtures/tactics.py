"""Export tactics behaviour on the real tactics record (port fixture).

Run from dsh-port-04:
    PYTHONDONTWRITEBYTECODE=1 /root/data/mediaflow/FFPR-Agent/.venv/bin/python \
        scripts/fixtures/tactics.py
"""

import json
import tempfile
from pathlib import Path

from ffpr_agent.ds.tactics import Tactics

REPO = Path("/root/data/mediaflow/FFPR-Agent")
SOURCE = REPO / ".deps" / "ds" / "tactics-ff5.json"
OUT = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "tactics" / "cases.json"


def main() -> None:
    initial = json.loads(SOURCE.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "tactics.json"
        path.write_text(json.dumps(initial, ensure_ascii=False, indent=1), encoding="utf-8")
        tactics = Tactics(path)
        initial_describes = [
            {"mapId": map_id, "text": tactics.describe(map_id), "has": tactics.has(map_id)}
            for map_id in ("64", "234", "999")
        ]
        current = {"mapId": "64", "table": tactics.current(64)}
        steps = []
        a = {
            "巴兹": [
                {"if": "ally.hp_pct < 40", "do": "道具:恢复药", "target": "hp最低的同伴"},
                {"do": "攻击"},
            ]
        }
        b = {"巴兹": [{"do": "防御"}]}
        tactics.set(777, [a, b])
        steps.append(
            {
                "op": "set",
                "args": {"mapId": "777", "tables": [a, b]},
                "describe": tactics.describe(777),
                "current": tactics.current(777),
                "has": tactics.has(777),
            }
        )
        for verdict, detail in (("ok", "全队 HP 80%"), ("hard", "巴兹倒下"), ("lost", "全员倒下")):
            message = tactics.record(777, verdict, detail)
            steps.append(
                {
                    "op": "record",
                    "args": {"mapId": "777", "verdict": verdict, "detail": detail},
                    "message": message,
                    "describe": tactics.describe(777),
                    "current": tactics.current(777),
                }
            )
        final = tactics.maps
        reloaded = Tactics(path)
        reloaded_state = {
            "current": reloaded.current(777),
            "describe": reloaded.describe(777),
        }
        saved = json.loads(path.read_text(encoding="utf-8"))
    data = {
        "initial": initial,
        "initialDescribes": initial_describes,
        "current": current,
        "steps": steps,
        "final": final,
        "reloaded": reloaded_state,
        "saved": saved,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(steps)} steps, {len(final)} maps -> {OUT}")
    print(f"fixture {OUT.stat().st_size // 1024} KiB")


if __name__ == "__main__":
    main()
