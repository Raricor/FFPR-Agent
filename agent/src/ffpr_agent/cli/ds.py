"""ffpr-ds: let DeepSeek play, in rounds of one goal each.

    uv run ffpr-ds --goal "前往风之神殿" --hint "入口名是「風の神殿」" --until 06:00
    uv run ffpr-ds --restart 3 --until 06:00 --steps 80 --goal "拿运河钥匙" --goal "打败塞壬"

--restart SLOT waits until the laptop is unlocked (no model calls meanwhile), restarts the game
with the newest bridge and loads the slot before the first round.
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime

from ffpr_agent import laptop as lp
from ffpr_agent import pilot
from ffpr_agent.bridge import BridgeLink
from ffpr_agent.ds.client import ALLOWED_MODELS, DEFAULT_MODEL, EFFORTS, DeepSeek
from ffpr_agent.ds.game import Game
from ffpr_agent.ds.loop import NEXT_HINT, SHANGHAI, next_deadline, play_rounds, wait_until_ready
from ffpr_agent.ds.prompt import SYSTEM_PROMPT, TOOLS
from ffpr_agent.events import KeyEvents, Watcher
from ffpr_agent.repo import DEPS
from ffpr_agent.restart import restart
from ffpr_common import redact
from ffpr_common.games import by_key
from ffpr_common.secrets import Secrets

RUNS = DEPS / "ds"
SEED_FILES = 3  # probe files read for the events before this run (a few game starts back)


def follow_events(laptop: lp.Laptop, game: str) -> KeyEvents | None:
    """Key events for the planning windows: the last few probe files, then the bridge's stream
    on the LAN link. None without the link (the player then reads the probe file over SSH)."""
    link = BridgeLink.load(laptop)
    if link is None:
        print("没有配置局域网直连:不跟随事件流,重要事件窗口为空")
        return None
    events = KeyEvents()
    try:
        lp.fetch_probe_logs(laptop, by_key(game), SEED_FILES)
    except subprocess.CalledProcessError as exc:
        print(f"取探针日志失败,事件窗口只从现在开始:{exc}")
    for path in sorted((DEPS / game / "probe").glob("probe-*.jsonl"))[-SEED_FILES:]:
        events.seed(path)
    Watcher(link, events).start()
    print(f"跟随事件流;已有 {len(events.entries)} 条重要事件")
    return events


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="让 DeepSeek 玩")
    parser.add_argument("--goal", action="append", help="本轮目标;可以重复,一个目标一轮")
    parser.add_argument("--hint", default="", help="第一轮的已知信息")
    parser.add_argument("--next-hint", default=NEXT_HINT, help="之后各轮的已知信息")
    parser.add_argument("--model", default=DEFAULT_MODEL, choices=ALLOWED_MODELS)
    parser.add_argument("--steps", type=int, default=30, help="每轮最多调用几次模型")
    parser.add_argument(
        "--effort", default="high", choices=[*EFFORTS, "off"], help="思考强度,off 表示不思考"
    )
    parser.add_argument("--game", default="ff5")
    parser.add_argument("--until", help="北京时间 HH:MM 之后不再调用模型,如 06:00")
    parser.add_argument(
        "--restart",
        type=int,
        metavar="SLOT",
        help="先等笔记本解锁,重启游戏装上最新桥插件,读这个存档位",
    )
    parser.add_argument("--dry-run", action="store_true", help="只打印提示词和工具定义")
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    parser = build_parser()
    args = parser.parse_args(argv)
    goals = args.goal or []
    if args.dry_run:
        hint = f"\n已知信息:{args.hint}" if args.hint else ""
        print(SYSTEM_PROMPT.format(goal=goals[0] if goals else "(目标)", hint=hint))
        print(json.dumps([t["function"]["name"] for t in TOOLS], ensure_ascii=False))
        return 0
    if not goals:
        parser.error("至少要有一个 --goal")

    key = Secrets.load().get("DEEPSEEK_API_KEY")
    redactor = redact.Redactor()
    redactor.add(key)
    redact.install(redactor)

    laptop = lp.Laptop.load()
    RUNS.mkdir(parents=True, exist_ok=True)
    model = DeepSeek(key, args.model, effort=None if args.effort == "off" else args.effort)
    if pilot.ensure_agent(laptop, args.game):
        print("试玩助手没在运行,已启动")
    events = follow_events(laptop, args.game)
    game = Game(
        laptop,
        args.game,
        RUNS / f"notes-{args.game}.json",
        events,
        RUNS / f"atlas-{args.game}.json",
        RUNS / f"tactics-{args.game}.json",
    )
    deadline = next_deadline(args.until, datetime.now(SHANGHAI)) if args.until else None

    if args.restart is not None:
        if wait_until_ready(game, print, deadline):
            print("到截止时间笔记本也没解锁,不玩了")
            return 1
        ok, message = restart(laptop, by_key(args.game), args.restart)
        print(message)
        if not ok:
            return 1

    def open_log(goal: str, hint: str):
        path = RUNS / f"run-{datetime.now():%Y%m%d-%H%M%S}.jsonl"
        print(f"日志:{path}")

        def log(record: dict) -> None:
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")

        log({"goal": goal, "hint": hint, "model": args.model, "effort": args.effort})
        return log

    summaries = play_rounds(
        goals,
        args.hint,
        lambda m: model.chat(m, TOOLS),
        game,
        args.steps,
        open_log,
        deadline=deadline,
        next_hint=args.next_hint,
    )
    for i, summary in enumerate(summaries, start=1):
        print(f"第 {i} 轮结果:{summary}")
    return 0
