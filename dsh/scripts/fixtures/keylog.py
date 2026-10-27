"""Export key-log records and Builder output from real probe files (port fixture).

Run from dsh-port-04:
    PYTHONDONTWRITEBYTECODE=1 /root/data/mediaflow/FFPR-Agent/.venv/bin/python \
        scripts/fixtures/keylog.py
"""

import json
from pathlib import Path

from ffpr_agent.logs.key_log import Builder, load

REPO = Path("/root/data/mediaflow/FFPR-Agent")
OUT = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "keylog" / "runs.json"
FILES = [
    "probe-20261020-200244.jsonl",  # story, party, boss fight, levels
    "probe-20261020-210529.jsonl",  # joins, levels, story, saves
    "probe-20261021-230908.jsonl",  # bridge 0.7.2: bestiary numbers in battle
]
KEEP = {
    "hello",
    "dialog.play",
    "save.write",
    "steam.setProgress",
    "achievement.steamProgress",
    "bestiary.register",
}


def slim(record: dict) -> dict:
    """Only the fields the Builder and KeyEvents read, so the fixture stays small."""
    kind = record.get("type")
    out = {"seq": record.get("seq"), "t": record.get("t"), "type": kind}
    if kind == "hello":
        out.update(
            product=record.get("product"),
            gameVersion=record.get("gameVersion"),
            plugin=record.get("plugin"),
        )
    elif kind == "sample":
        user = record.get("user") or {}
        out["user"] = {
            key: user.get(key) for key in ("mapId", "areaText", "chests", "gil", "wins", "escapes")
        }
        out["party"] = [
            {key: member.get(key) for key in ("name", "lv", "hp")}
            for member in record.get("party") or []
        ]
        battle = record.get("battle") or {}
        out["battle"] = {
            "active": battle.get("active"),
            "boss": battle.get("boss"),
            "enemies": [
                {key: enemy.get(key) for key in ("name", "book")}
                for enemy in battle.get("enemies") or []
            ],
        }
        if "boss" not in battle:
            out["battle"].pop("boss")
    elif kind == "dialog.play":
        out.update(ids=record.get("ids"), speaker=record.get("speaker"), lines=record.get("lines"))
    elif kind == "save.write":
        out.update(slot=record.get("slot"), result=record.get("result"))
    elif kind in ("steam.setProgress", "achievement.steamProgress"):
        out.update(api=record.get("api"), value=record.get("value"))
    elif kind == "bestiary.register":
        out.update(monster=record.get("monster"))
    return out


def sample_key(record: dict) -> tuple:
    user = record.get("user") or {}
    battle = record.get("battle") or {}
    return (
        user.get("mapId"),
        user.get("areaText"),
        user.get("chests"),
        user.get("wins"),
        user.get("escapes"),
        user.get("gil"),
        bool(battle.get("active")),
        battle.get("boss"),
        tuple(enemy.get("name") for enemy in battle.get("enemies") or []),
        tuple(
            (member.get("name"), member.get("lv"), member.get("hp"))
            for member in record.get("party") or []
        ),
        bool(user.get("saves")),
        user.get("saves"),
    )


def select(records: list[dict]) -> list[dict]:
    chosen = []
    previous = None
    force = False
    for record in records:
        kind = record.get("type")
        if kind == "sample":
            key = sample_key(record)
            if previous is None or key != previous or force:
                chosen.append(slim(record))
                previous = key
            force = False
        elif kind in KEEP:
            chosen.append(slim(record))
            force = kind == "dialog.play"
    return chosen


def main() -> None:
    runs = []
    for name in FILES:
        path = REPO / ".deps" / "ff5" / "probe" / name
        records = select(load(path))
        builder = Builder(run=path.stem.removeprefix("probe-"))
        for record in records:
            builder.feed(record)
        full = Builder(run=path.stem.removeprefix("probe-"))
        for record in load(path):
            full.feed(record)
        assert builder.entries == full.entries, f"{name}: filtered records changed the entries"
        runs.append(
            {
                "name": path.stem.removeprefix("probe-"),
                "records": records,
                "entries": builder.entries,
            }
        )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"runs": runs}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(runs)} runs, {sum(len(run['records']) for run in runs)} records -> {OUT}")


if __name__ == "__main__":
    main()
