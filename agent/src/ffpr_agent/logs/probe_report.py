"""Summarise a bridge probe log (JSON lines from bridge/ v0) for checking against a play session.

uv run ffpr-probe ff5            # newest file in .deps/ff5/probe
uv run ffpr-probe path/to/probe-*.jsonl
"""

import argparse
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

from ffpr_agent.repo import REPO

# Message-ID prefix -> dialog kind. Seen in FF5 1.2.0: E0001_00_071_a_01 (event script),
# N111_C00_201_01_01 (NPC), S9999_999_a_06 ("是锁着的"), T0001_01_01 ("宝箱中发现了").
ID_KIND = {"E": "剧情", "N": "NPC", "S": "系统", "T": "宝箱"}

# Fallback when no ID matched: the main-game state when the dialog opened (design doc §11.2).
DIALOG_KIND = {
    "Event": "剧情",
    "Message": "NPC",
    "Shop": "商店",
    "Battle": "战斗",
    "Player": "地图",
    "Gimmick": "机关",
}

COUNTERS = ("gil", "totalGil", "steps", "battles", "wins", "escapes", "kills", "chests", "saves")


def load(path: Path) -> list[dict]:
    records = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            # The game may be mid-write on the last line.
            print(f"(第 {n} 行不完整,跳过)", file=sys.stderr)
    return records


def clock(records: list[dict]):
    start = datetime.fromisoformat(records[0]["t"].replace("Z", "+00:00"))

    def at(record: dict) -> str:
        t = datetime.fromisoformat(record["t"].replace("Z", "+00:00"))
        seconds = int((t - start).total_seconds())
        return f"{seconds // 60:02d}:{seconds % 60:02d}"

    return at


def short(text: str | None, width: int = 40) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= width else text[: width - 1] + "…"


def first_line(lines) -> str:
    return next((x for x in lines or [] if x and x.strip()), "")


def section_errors(sample: dict) -> list[tuple[str, str]]:
    return [
        (k, v["error"]) for k, v in sample.items() if isinstance(v, dict) and set(v) == {"error"}
    ]


def dialog_kind(dialog: dict) -> str:
    for key in dialog.get("ids") or []:
        if key[:1] in ID_KIND and key[1:2].isdigit():
            return ID_KIND[key[:1]]
    return DIALOG_KIND.get(dialog.get("state"), dialog.get("state") or "?")


def timeline_key(sample: dict) -> tuple:
    """Scene, map and battle only: the main state flips Player/Event every few seconds."""
    scene = sample.get("scene") or {}
    user = sample.get("user") or {}
    battle = sample.get("battle") or {}
    area = user.get("areaText") or user.get("area")
    return (scene.get("name"), user.get("mapId"), area, bool(battle.get("active")))


def unique_events(records: list[dict]) -> list[dict]:
    """Achievement reports the game repeats unchanged (old probe logs did not filter them)."""
    seen: dict[tuple, str] = {}
    out = []
    for r in records:
        if not r["type"].startswith(("achievement.", "steam.", "bestiary.")):
            continue
        body = {k: v for k, v in r.items() if k not in ("seq", "t", "frame")}
        key = (r["type"], body.get("api"), body.get("kind"), body.get("condition"))
        value = json.dumps(body, ensure_ascii=False, sort_keys=True)
        if r["type"].startswith("bestiary.") or seen.get(key) != value:
            seen[key] = value
            out.append(r)
    return out


def render(records: list[dict], name: str) -> str:
    if not records:
        return f"{name}:没有记录"
    at = clock(records)
    out: list[str] = []
    samples = [r for r in records if r["type"] == "sample"]
    hello = next((r for r in records if r["type"] == "hello"), {})
    kinds = Counter(r["type"] for r in records)

    out.append(f"# 探针报告 · {name}")
    out.append(
        f"{hello.get('product', '?')} {hello.get('gameVersion', '?')}"
        f" · 插件 {hello.get('plugin', '?')}"
        f" · 时长 {at(records[-1])} · 记录 {len(records)} 条"
    )
    out.append("记录类型:" + ",".join(f"{k} {v}" for k, v in sorted(kinds.items())))
    dropped = max((s.get("dropped", 0) for s in samples), default=0)
    if dropped:
        out.append(f"注意:队列满丢了 {dropped} 条")

    out.append("\n## 时间线(场景 / 地图 / 战斗变化)")
    last = None
    for s in samples:
        key = timeline_key(s)
        if key != last:
            scene, map_id, area, battle = key
            where = f"地图 {map_id}" + (f" {area}" if area else "")
            out.append(f"{at(s)}  {scene}  {where}{'  战斗中' if battle else ''}")
            last = key
    states = Counter((s.get("scene") or {}).get("state") for s in samples)
    out.append("主状态分布(秒):" + ",".join(f"{k} {v}" for k, v in states.most_common() if k))

    dialogs = [r for r in records if r["type"] == "dialog.play"]
    out.append(f"\n## 对话({len(dialogs)} 次)")
    kinds_seen = Counter(dialog_kind(d) for d in dialogs)
    out.append("类别:" + ",".join(f"{k} {v}" for k, v in kinds_seen.most_common()))
    for d in dialogs:
        kind = dialog_kind(d)
        ids = d.get("ids") or []
        id_text = ",".join(ids[:3]) if ids else f"未配上 ID(候选 {len(d.get('lookups') or [])})"
        speaker = f"【{d['speaker']}】" if d.get("speaker") else ""
        out.append(f"{at(d)}  [{kind}] {speaker}{short(first_line(d.get('lines')))}  · {id_text}")

    choices = [r for r in records if r["type"] == "choice.open"]
    if choices:
        out.append(f"\n## 选项({len(choices)} 次)")
        for c in choices:
            options = " / ".join(short(o, 16) for o in c.get("options") or [])
            out.append(f"{at(c)}  {c.get('kind')} 默认 {c.get('default', '-')}:{options}")

    sysmsgs = [r for r in records if r["type"] == "sysmsg"]
    if sysmsgs:
        out.append(f"\n## 系统消息({len(sysmsgs)} 条)")
        for m in sysmsgs:
            out.append(f"{at(m)}  {m.get('id')}:{short(m.get('text'))}")

    raw = sum(r["type"].startswith(("achievement.", "steam.", "bestiary.")) for r in records)
    events = unique_events(records)
    if events:
        out.append(f"\n## 成就与图鉴(去掉重复后 {len(events)} 条,原始 {raw} 条)")
        for e in events:
            body = {k: v for k, v in e.items() if k not in ("seq", "t", "frame", "type")}
            out.append(f"{at(e)}  {e['type']}  {json.dumps(body, ensure_ascii=False)}")

    with_user = [s for s in samples if s.get("user") and "error" not in s["user"]]
    if with_user:
        first, final = with_user[0]["user"], with_user[-1]["user"]
        out.append("\n## 计数器(第一次 → 最后一次)")
        out.append(",".join(f"{k} {first.get(k)}→{final.get(k)}" for k in COUNTERS if k in final))
        out.append(f"Boost:{json.dumps(final.get('boost'), ensure_ascii=False)}")
    with_party = [s for s in samples if isinstance(s.get("party"), list) and s["party"]]
    if with_party:
        out.append("队伍(最后一次):")
        for c in with_party[-1]["party"]:
            out.append(
                f"  {c.get('name')} 职业 {c.get('job')} Lv{c.get('lv')}"
                f" HP {c.get('hp')}/{c.get('maxHp')} MP {c.get('mp')}/{c.get('maxMp')}"
            )

    errors = Counter(e for s in samples for e in section_errors(s))
    errors.update(
        ("事件 " + r["type"], r["error"]) for r in records if r["type"] != "sample" and "error" in r
    )
    out.append(f"\n## 读取错误({sum(errors.values())} 次)")
    for (section, message), count in errors.most_common():
        out.append(f"{section} × {count}:{message}")
    return "\n".join(out) + "\n"


def resolve(target: str) -> Path:
    path = Path(target)
    if path.exists():
        return path
    files = sorted((REPO / ".deps" / target / "probe").glob("probe-*.jsonl"))
    if not files:
        raise SystemExit(f"找不到 {target}:先运行 uv run ffpr-laptop probe-logs {target}")
    return files[-1]


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="汇总探针日志")
    parser.add_argument("target", help="作品(取 .deps/<作品>/probe 下最新的文件)或文件路径")
    args = parser.parse_args(argv)
    path = resolve(args.target)
    print(render(load(path), path.name), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
