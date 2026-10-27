"""Export atlas behaviour on the real map record (port fixture).

Run from dsh-port-04:
    PYTHONDONTWRITEBYTECODE=1 /root/data/mediaflow/FFPR-Agent/.venv/bin/python \
        scripts/fixtures/atlas.py
"""

import json
import tempfile
from pathlib import Path

from ffpr_agent.ds.atlas import Atlas

REPO = Path("/root/data/mediaflow/FFPR-Agent")
SOURCE = REPO / ".deps" / "ds" / "atlas-ff5.json"
OUT = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "atlas" / "cases.json"


def describes(atlas: Atlas) -> list[dict]:
    return [
        {"around": around, "limit": 30, "text": atlas.describe(around=around)}
        for around in (212, 211, 30, 999, None)
    ]


def main() -> None:
    initial = json.loads(SOURCE.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "atlas.json"
        path.write_text(json.dumps(initial, ensure_ascii=False, indent=1), encoding="utf-8")
        atlas = Atlas(path)
        first = describes(atlas)
        steps = []

        def record(op: str, args: dict, around=999) -> None:
            steps.append(
                {
                    "op": op,
                    "args": args,
                    "describe": {
                        "around": around,
                        "limit": 30,
                        "text": atlas.describe(around=around),
                    },
                }
            )

        args = {
            "map_id": 999,
            "name": "新地图",
            "exits": [{"cell": [1, 2], "to": 211, "name": "回船舶墓场"}],
            "chests": [{"cell": [3, 4], "name": "宝箱A"}],
        }
        atlas.visit(**args)
        record("visit", args)
        link = {"map_id": 999, "start": [10, 20], "end": [30, 40], "how": "调查后跳"}
        atlas.link(**link)
        atlas.link(**link)  # once only
        record("link", link)
        atlas.visit(**args)  # a later look keeps the jump link
        record("visit", args)
        old = {"cell": [22, 15], "to": 212}
        atlas.visit(211, "船舶墓场", [old], [{"cell": [13, 54], "name": "フレイル"}])
        record(
            "visit",
            {
                "map_id": 211,
                "name": "船舶墓场",
                "exits": [old],
                "chests": [{"cell": [13, 54], "name": "フレイル"}],
            },
            around=211,
        )
        final = atlas.maps
        reloaded = Atlas(path)
        reloaded_describes = describes(reloaded)
        saved = json.loads(path.read_text(encoding="utf-8"))
    data = {
        "initial": initial,
        "initialDescribes": first,
        "steps": steps,
        "final": final,
        "reloadedDescribes": reloaded_describes,
        "saved": saved,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(steps)} steps, {len(final)} maps -> {OUT}")
    print(f"fixture {OUT.stat().st_size // 1024} KiB")


if __name__ == "__main__":
    main()
