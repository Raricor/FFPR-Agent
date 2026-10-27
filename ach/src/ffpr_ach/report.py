"""achievements.md: the human-readable view of achievements.db (design §13.5)."""

import sqlite3
from datetime import datetime
from pathlib import Path

from ffpr_ach import db
from ffpr_common.games import GAMES, TOTAL_ACHIEVEMENTS


def _local(stamp: str | None, fmt: str = "%Y-%m-%d %H:%M") -> str:
    if not stamp:
        return "—"
    return datetime.fromisoformat(stamp).astimezone().strftime(fmt)


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ").strip() or "—"


def _percent(done: int, total: int) -> str:
    return f"{done / total:.1%}" if total else "—"


def render(conn: sqlite3.Connection, now: datetime) -> str:
    lines = [
        f"# 成就记录 · 更新于 {now.astimezone():%Y-%m-%d %H:%M}",
        "",
        "| 作品 | 已解锁 | 总数 | 完成度 | 上次同步 |",
        "| --- | --- | --- | --- | --- |",
    ]
    unlocked_all = 0
    for game in GAMES:
        s = db.game_summary(conn, game.app_id)
        total = s["total"] or game.achievement_count
        unlocked_all += s["unlocked"]
        synced = _local(s["synced_at"]) if s["synced_at"] else "未同步"
        lines.append(
            f"| {game.label} | {s['unlocked']} | {total} | {_percent(s['unlocked'], total)} "
            f"| {synced} |"
        )
    lines.append(
        f"| 合计 | {unlocked_all} | {TOTAL_ACHIEVEMENTS} "
        f"| {_percent(unlocked_all, TOTAL_ACHIEVEMENTS)} | |"
    )

    for game in GAMES:
        rows = db.game_rows(conn, game.app_id)
        if not rows:
            continue
        s = db.game_summary(conn, game.app_id)
        lines += [
            "",
            f"## {game.label} {game.title}({s['unlocked']}/{s['total']})",
            "",
        ]
        if s["player_error"]:
            lines += [f"> 读不到解锁状态:{s['player_error']}", ""]
        lines += [
            "| 状态 | 成就 | 说明 | 类别 | 当前存档进度 | 备注 |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for r in rows:
            status = f"已解锁 {_local(r['unlocked_at'])}" if r["unlocked"] else "未解锁"
            name = r["name_zh"] or r["name_en"] or r["api_name"]
            desc = r["desc_zh"] or r["desc_en"] or ("Steam 未提供说明" if r["hidden"] else "")
            note = "隐藏" if r["hidden"] else ""
            cells = [status, _cell(name), _cell(desc), r["category"], "—", _cell(note)]
            lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def write(conn: sqlite3.Connection, path: Path, now: datetime) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(render(conn, now), encoding="utf-8")
    tmp.replace(path)
