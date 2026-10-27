"""Text views of the game state for people and for the model: the probe's newest sample
with the events since the last look, items and entities."""

import json
import re

from ffpr_agent import laptop as lp
from ffpr_agent.pilot import PILOT
from ffpr_agent.skills.gambit import statuses
from ffpr_common.games import by_key

CURSOR = PILOT / "state-cursor.json"


TAIL_BYTES = 96 * 1024


# "Nothing" placeholders the item list carries for empty equipment slots.
PLACEHOLDER_ITEMS = {"空手", "无"}


ICON_TAG = re.compile(r"<IC_[A-Z_]+>")


def describe_items(items: dict) -> str:
    lines = []
    for kind, label in (("normal", "道具"), ("important", "贵重物品")):
        names = []
        for item in items.get(kind) or []:
            name = ICON_TAG.sub("", item.get("name") or "").strip()
            if name and name not in PLACEHOLDER_ITEMS:
                names.append(f"{name}×{item['count']}")
        lines.append(f"{label}:{'、'.join(names) or '无'}")
    return "\n".join(lines)


def describe_entities(found: dict) -> str:
    """One line per entity: kind, cell, and what it leads to or holds."""
    lines = [f"共 {found['total']} 个实体,列出 {len(found['entities'])} 个:"]
    for e in found["entities"]:
        cell = e.get("cell") or e.get("tile")
        extra = []
        if "toMap" in e:
            extra.append(f"通往地图 {e['toMap']}")
        if "content" in e:
            extra.append(f"内容 {e['content']}×{e['num']}")
        if "npc" in e:
            extra.append(f"NPC {e['npc']}")
        if not e.get("active", True):
            extra.append("未激活")
        lines.append(f"  {e['kind']} @ {cell} {e.get('name') or ''} {' '.join(extra)}".rstrip())
    return "\n".join(lines)


def named_objects(found: dict) -> dict:
    """Plain and animated entities worth a look: active ones with a name, like the canal's gate
    doors (トルナ運河の開錠_右扉) or the crystal shards (クリスタルのかけら); the generic props
    (【汎用】...), speech bubbles and nameless ones are left out."""
    kept = [
        e
        for e in found.get("entities") or []
        if e.get("active", True)
        and e.get("name")
        and not e["name"].startswith("【汎用】")
        and "吹き出し" not in e["name"]  # speech bubbles
    ]
    return {**found, "total": len(kept), "entities": kept}


def parse_tail(text: str) -> list[dict]:
    """JSON records from the tail of a probe file; the first line may be cut off."""
    records = []
    for line in text.splitlines()[1:]:
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


# The field's moveState (bridge sample): how the party moves now. Walking needs no note.
RIDES = {
    "LowFlying": "骑着飞龙(飞不过山;进城镇和迷宫要先降落,walk_to 入口会自动降落再走进去)",
    "HighFlying": "乘飞空艇",
    "Ship": "坐船",
    "Chocobo": "骑陆行鸟",
}


def marks(unit: dict) -> str:
    """Status conditions as 「[毒、石化]」 (bridge 0.6.3+ in battle, 0.6.5+ on the field)."""
    names = statuses(unit)
    return f"[{'、'.join(names)}]" if names else ""


def summarize(sample: dict | None, events: list[dict]) -> str:
    out = []
    if sample:
        scene = sample.get("scene") or {}
        user = sample.get("user") or {}
        field = sample.get("field") or {}
        battle = sample.get("battle") or {}
        area = user.get("areaText") or user.get("area") or ""
        cell = field.get("cell")
        where = f"格子 {cell[0]:g},{cell[1]:g}" if isinstance(cell, list) else "不在地图上"
        ride = RIDES.get(field.get("moveState") or "", "")
        out.append(
            f"{scene.get('name')}/{scene.get('state')} · 地图 {user.get('mapId')} {area} · {where}"
            + (f" · {ride}" if ride else "")
            + f" · {'战斗中' if battle.get('active') else '非战斗'} · 金钱 {user.get('gil')}"
        )
        dialog = sample.get("dialog") or {}
        if dialog.get("open"):
            speaker = f"【{dialog['speaker']}】" if dialog.get("speaker") else ""
            lines = " / ".join(x for x in dialog.get("lines") or [] if x)
            out.append(f"对话框打开 {speaker}{lines}")
        for kind, choice in (sample.get("choice") or {}).items():
            if isinstance(choice, dict) and choice.get("open"):
                options = choice.get("options") or choice.get("labels") or []
                cursor = choice.get("cursor")
                marked = [f"[{o}]" if i == cursor else o for i, o in enumerate(options)]
                out.append(f"选项({kind}):{' / '.join(marked)}")
        if battle.get("active"):
            for side, label in (("enemies", "敌人"), ("players", "我方")):
                units = battle.get(side) or []
                text = ",".join(
                    f"{u.get('name')} {u.get('hp')}/{u.get('maxHp')}{marks(u)}" for u in units
                )
                out.append(f"{label}:{text or '?'}")
        party = sample.get("party")
        if isinstance(party, list) and party:
            out.append(
                "队伍 "
                + ",".join(
                    f"{c.get('name')} Lv{c.get('lv')} {c.get('hp')}/{c.get('maxHp')}{marks(c)}"
                    for c in party
                )
            )
    for e in events:
        if e["type"] == "dialog.play":
            speaker = f"【{e['speaker']}】" if e.get("speaker") else ""
            text = " / ".join(x for x in e.get("lines") or [] if x)
            out.append(f"  + 对话 {','.join(e.get('ids') or [])[:40]} {speaker}{text}")
        elif e["type"] == "choice.open":
            out.append(f"  + 选项 {' / '.join(e.get('options') or [])}")
        elif e["type"] == "sysmsg":
            out.append(f"  + 系统消息 {e.get('text')}")
        elif e["type"] not in ("sample", "dialog.close", "hello"):
            body = {k: v for k, v in e.items() if k not in ("seq", "t", "frame", "type")}
            out.append(f"  + {e['type']} {json.dumps(body, ensure_ascii=False)}")
    return "\n".join(out)


def state_script(laptop: lp.Laptop, game: str) -> str:
    """PowerShell that prints the newest probe file's name, then its last TAIL_BYTES."""
    key = by_key(game).key
    return (
        f"Import-Module {lp.deployed_script(laptop, 'FfprCommon.psm1')} -Force\n"
        f"$src = Join-Path (Find-GameDir {key}) 'BepInEx\\ffpr'\n"
        "$f = Get-ChildItem $src -Filter 'probe-*.jsonl' | Sort-Object LastWriteTime -Descending |"
        " Select-Object -First 1\n"
        "$fs = [IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite')\n"
        f"$start = [Math]::Max(0, $fs.Length - {TAIL_BYTES})\n"
        "[void]$fs.Seek($start, 'Begin')\n"
        "$buf = New-Object byte[] ($fs.Length - $start)\n"
        "[void]$fs.Read($buf, 0, $buf.Length)\n"
        "$fs.Close()\n"
        "$f.Name\n"
        "[Text.Encoding]::UTF8.GetString($buf)"
    )


def parse_state(text: str, args=None) -> tuple[dict | None, list[dict]]:
    """The newest sample and the events since the last call (the cursor lives in CURSOR)."""
    name, _, tail = text.partition("\n")
    records = parse_tail(tail)
    cursor = json.loads(CURSOR.read_text()) if CURSOR.exists() else {}
    last_seq = cursor.get("seq", 0) if cursor.get("file") == name.strip() else 0
    samples = [r for r in records if r["type"] == "sample"]
    events = [r for r in records if r["seq"] > last_seq and r["type"] != "sample"]
    if records:
        PILOT.mkdir(parents=True, exist_ok=True)
        CURSOR.write_text(json.dumps({"file": name.strip(), "seq": records[-1]["seq"]}))
    return (samples[-1] if samples else None), events
