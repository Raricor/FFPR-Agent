"""ffpr-ach: command line for the achievement recorder."""

import argparse
import contextlib
import logging
import sqlite3
import sys
import unicodedata
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path

import httpx

from ffpr_ach import db, report
from ffpr_ach.steam import SteamClient, SteamError
from ffpr_ach.sync import sync_game
from ffpr_common import games, paths, redact
from ffpr_common.secrets import Secrets

Clock = Callable[[], datetime]


def _width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def _table(rows: list[list[str]], right: frozenset[int] = frozenset()) -> str:
    widths = [max(_width(r[i]) for r in rows) for i in range(len(rows[0]))]
    out = []
    for row in rows:
        cells = []
        for i, cell in enumerate(row):
            gap = " " * (widths[i] - _width(cell))
            cells.append(gap + cell if i in right else cell + gap)
        out.append("  ".join(cells).rstrip())
    return "\n".join(out)


def _client(http: httpx.Client | None, key: str | None, steam_id: str | None) -> SteamClient:
    if http is None:
        return SteamClient.create(key, steam_id)
    return SteamClient(http, key, steam_id)


def _report_path(data: Path) -> Path:
    return data / "achievements.md"


def cmd_sync(args, conn, data, http, now) -> int:
    secrets = Secrets.load(args.secrets)
    key = secrets.get("STEAM_WEB_API_KEY")
    steam_id = None if args.no_player else secrets.get("STEAM_ID64")
    redactor = redact.Redactor()
    redactor.add(key)
    redact.install(redactor)

    client = _client(http, key, steam_id)
    targets = [games.by_key(k) for k in args.game] if args.game else list(games.GAMES)
    failed = False
    for game in targets:
        result = sync_game(conn, client, game, now(), include_player=not args.no_player)
        line = f"{game.label}:成就定义 {result.total} 个"
        if not args.no_player and result.player_error is None:
            line += f",已解锁 {result.unlocked} 个,本次新增 {len(result.new_unlocks)} 个"
        print(line)
        for warning in result.warnings:
            print(f"  注意:{warning}")
        if result.player_error:
            print(f"  {result.player_error}")
            failed = True
    report.write(conn, _report_path(data), now())
    print(f"报告已更新:{_report_path(data)}")
    return 1 if failed else 0


def cmd_status(args, conn, data, http, now) -> int:
    rows = [["作品", "已解锁", "总数", "完成度", "上次同步"]]
    unlocked_all = 0
    for game in games.GAMES:
        s = db.game_summary(conn, game.app_id)
        total = s["total"] or game.achievement_count
        unlocked_all += s["unlocked"]
        synced = (
            datetime.fromisoformat(s["synced_at"]).astimezone().strftime("%Y-%m-%d %H:%M")
            if s["synced_at"]
            else "未同步"
        )
        rows.append(
            [game.label, str(s["unlocked"]), str(total), f"{s['unlocked'] / total:.1%}", synced]
        )
    total_all = games.TOTAL_ACHIEVEMENTS
    rows.append(["合计", str(unlocked_all), str(total_all), f"{unlocked_all / total_all:.1%}", ""])
    print(_table(rows, right=frozenset({1, 2, 3})))
    return 0


def cmd_show(args, conn, data, http, now) -> int:
    game = games.by_key(args.game)
    rows = db.game_rows(conn, game.app_id)
    if not rows:
        print(f"{game.label} 还没有同步过,请先运行 ffpr-ach sync --game {game.key}")
        return 1
    s = db.game_summary(conn, game.app_id)
    print(f"{game.label} {game.title}({s['unlocked']}/{s['total']})")
    table = [["", "成就", "类别", "解锁时间", "说明"]]
    for r in rows:
        mark = "✓" if r["unlocked"] else "·"
        name = r["name_zh"] or r["name_en"] or r["api_name"]
        desc = r["desc_zh"] or r["desc_en"] or ("(隐藏,Steam 未提供说明)" if r["hidden"] else "")
        when = (
            datetime.fromisoformat(r["unlocked_at"]).astimezone().strftime("%Y-%m-%d %H:%M")
            if r["unlocked_at"]
            else ""
        )
        table.append([mark, name, r["category"], when, desc])
    print(_table(table))
    return 0


def cmd_report(args, conn, data, http, now) -> int:
    path = args.out or _report_path(data)
    report.write(conn, path, now())
    print(f"报告已生成:{path}")
    return 0


def cmd_verify_counts(args, conn, data, http, now) -> int:
    client = _client(http, None, None)
    rows = [["作品", "登记", "Steam", ""]]
    ok = True
    for game in games.GAMES:
        actual = len(client.public_achievement_names(game.app_id))
        match = actual == game.achievement_count
        ok &= match
        rows.append(
            [game.label, str(game.achievement_count), str(actual), "一致" if match else "不一致"]
        )
    print(_table(rows, right=frozenset({1, 2})))
    return 0 if ok else 1


COMMANDS = {
    "sync": cmd_sync,
    "status": cmd_status,
    "show": cmd_show,
    "report": cmd_report,
    "verify-counts": cmd_verify_counts,
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ffpr-ach", description="FFPR-Agent 成就记录器")
    parser.add_argument("--data-dir", type=Path, help="数据目录,默认按操作系统决定")
    parser.add_argument("--secrets", type=Path, help="secrets.env 的路径")
    parser.add_argument("-v", "--verbose", action="store_true", help="输出调试日志")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("sync", help="从 Steam 同步成就定义和解锁状态")
    p.add_argument("--game", action="append", help="只同步指定作品,可以重复,例如 --game ff5")
    p.add_argument("--no-player", action="store_true", help="只同步成就定义,不读解锁状态")
    sub.add_parser("status", help="六作汇总")
    p = sub.add_parser("show", help="某一作的逐条状态")
    p.add_argument("game", help="作品,例如 ff5")
    p = sub.add_parser("report", help="重新生成 achievements.md")
    p.add_argument("--out", type=Path, help="输出路径,默认放在数据目录")
    sub.add_parser("verify-counts", help="不需要 key,核对六作的成就数量")
    return parser


def _setup_output(verbose: bool) -> None:
    # Windows consoles default to a legacy code page; all output here is UTF-8.
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(AttributeError, ValueError):
            stream.reconfigure(encoding="utf-8")
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.WARNING, format="%(levelname)s %(message)s"
    )
    # httpx logs full URLs, and the Steam key is a query parameter.
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)


def main(
    argv: Sequence[str] | None = None,
    *,
    http: httpx.Client | None = None,
    now: Clock = lambda: datetime.now(UTC),
) -> int:
    args = _parser().parse_args(argv)
    _setup_output(args.verbose)
    data = args.data_dir or paths.data_dir()
    conn: sqlite3.Connection = db.connect(data / "achievements.db")
    try:
        return COMMANDS[args.cmd](args, conn, data, http, now)
    except (SteamError, LookupError) as exc:  # LookupError covers MissingSecret and UnknownGame
        print(f"错误:{exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
