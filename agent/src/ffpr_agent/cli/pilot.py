"""ffpr-pilot: play from the dev box with the skills, one command at a time."""

import argparse
import json
import statistics
import subprocess
import sys
import time

import httpx

from ffpr_agent import laptop as lp
from ffpr_agent.bridge import BridgeLink, LinkError
from ffpr_agent.nav import corners, render_cells
from ffpr_agent.pilot import fetch_shot, query, send, send_ssh, start_agent
from ffpr_agent.restart import restart
from ffpr_agent.skills.battle import fight
from ffpr_agent.skills.menu import cast, leave_menu, menu_state
from ffpr_agent.skills.move import navigate, open_at, plan
from ffpr_agent.skills.save import load_game, save_game
from ffpr_agent.skills.shop import buy
from ffpr_agent.view import describe_entities, describe_items, parse_state, state_script, summarize
from ffpr_common.games import by_key


def report(result: dict, shot: str | None = None) -> int:
    shown = {k: v for k, v in result.items() if k not in ("id", "time", "shot")}
    if shot:
        shown["shot"] = shot
    print(json.dumps(shown, ensure_ascii=False))
    return 0 if result.get("ok") else 1


def cmd_start(laptop: lp.Laptop, args) -> int:
    return report(start_agent(laptop, args.game, args.idle, args.keep_awake))


def cmd_link(laptop: lp.Laptop, args) -> int:
    """Check the LAN link and compare one state read over it with one over SSH."""
    link = BridgeLink.load(laptop)
    if link is None:
        print("没有配置局域网连接:先运行 ffpr-laptop link")
        return 1
    try:
        health = link.health()
    except (LinkError, httpx.HTTPError) as exc:
        print(f"连不上桥插件:{exc}")
        return 1
    hello = health.get("hello") or {}
    print(f"桥插件 {hello.get('plugin')},帧 {health.get('frame')},订阅 {health.get('clients')} 个")
    lan = []
    for _ in range(args.n):
        started = time.perf_counter()
        link.query("pos")
        lan.append((time.perf_counter() - started) * 1000)
    started = time.perf_counter()
    send_ssh(laptop, "pos")
    ssh = (time.perf_counter() - started) * 1000
    median = statistics.median(lan)
    print(f"读一次位置:局域网中位数 {median:.1f} ms(共 {args.n} 次),SSH {ssh:.0f} ms")
    return 0


def cmd_restart(laptop: lp.Laptop, args) -> int:
    ok, message = restart(laptop, by_key(args.game), args.slot, build=not args.no_build)
    print(message)
    return 0 if ok else 1


def cmd_status(laptop: lp.Laptop, args) -> int:
    return report(send(laptop, "status"))


def cmd_focus(laptop: lp.Laptop, args) -> int:
    return report(send(laptop, "focus"))


def cmd_keys(laptop: lp.Laptop, args) -> int:
    fields = {"keys": args.keys, "gap": args.gap}
    if args.shot:
        fields |= {"shot": True, "wait": args.wait, "maxWidth": args.max_width}
    result = send(laptop, "keys", _wait=120, **fields)
    return report(result, fetch_shot(laptop, result))


def cmd_shot(laptop: lp.Laptop, args) -> int:
    result = send(laptop, "shot", maxWidth=args.max_width)
    return report(result, fetch_shot(laptop, result))


def cmd_load(laptop: lp.Laptop, args) -> int:
    ok, message = load_game(laptop, args.slot)
    print(message)
    return 0 if ok else 1


def cmd_cast(laptop: lp.Laptop, args) -> int:
    ok, message = cast(laptop, args.caster, args.spell, args.target)
    print(message)
    return 0 if ok else 1


def cmd_menu(laptop: lp.Laptop, args) -> int:
    print(json.dumps(menu_state(laptop), ensure_ascii=False, indent=1))
    return 0


def cmd_buy(laptop: lp.Laptop, args) -> int:
    ok, message = buy(laptop, args.product, args.count)
    print(message)
    return 0 if ok else 1


def cmd_fight(laptop: lp.Laptop, args) -> int:
    plan = json.loads(args.plan) if args.plan else {}
    result = fight(laptop, plan, args.timeout)
    print(json.dumps({k: v for k, v in result.items() if k != "turns"}, ensure_ascii=False))
    return 0 if result.get("ok") else 1


def cmd_save(laptop: lp.Laptop, args) -> int:
    ok, message = save_game(laptop, args.slot)
    print(message)
    return 0 if ok else 1


def cmd_items(laptop: lp.Laptop, args) -> int:
    print(describe_items(query(laptop, "items").get("items") or {}))
    return 0


def cmd_pos(laptop: lp.Laptop, args) -> int:
    return report(send(laptop, "pos"))


def cmd_walk(laptop: lp.Laptop, args) -> int:
    timeout_ms = int(args.timeout * 1000)
    return report(
        send(laptop, "walk", _wait=args.timeout + 10, to=[args.x, args.y], timeout=timeout_ms)
    )


def cmd_battle(laptop: lp.Laptop, args) -> int:
    fields = {"timeout": int(args.timeout * 1000), "every": args.every}
    return report(send(laptop, "battle", _wait=args.timeout + 10, **fields))


def cmd_story(laptop: lp.Laptop, args) -> int:
    fields = {"pageMs": int(args.page * 1000), "timeout": int(args.timeout * 1000)}
    return report(send(laptop, "story", _wait=args.timeout + 10, **fields))


def cmd_wait(laptop: lp.Laptop, args) -> int:
    timeout_ms = int(args.timeout * 1000)
    return report(send(laptop, "wait", _wait=args.timeout + 10, timeout=timeout_ms))


def cmd_cells(laptop: lp.Laptop, args) -> int:
    result = send(laptop, "cells", r=args.r)
    if not result.get("ok") or not result.get("cells"):
        return report(result)
    print(render_cells(result["cells"]))
    return 0


def cmd_leave(laptop: lp.Laptop, args) -> int:
    print(leave_menu(laptop))
    return 0


def cmd_open(laptop: lp.Laptop, args) -> int:
    print(open_at(laptop, (args.x, args.y)))
    return 0


def cmd_route(laptop: lp.Laptop, args) -> int:
    if args.plan:
        here, path = plan(laptop, (args.x, args.y), args.ship)
        print(f"从 {here}:路线 {max(len(path) - 1, 0)} 格,拐点 {corners(path)}")
        return 0
    reached, message = navigate(laptop, (args.x, args.y), args.ship)
    print(message)
    return 0 if reached else 1


def cmd_entities(laptop: lp.Laptop, args) -> int:
    result = send(laptop, "entities", kind=args.kind or "", max=args.max)
    if not result.get("ok") or not result.get("entities"):
        return report(result)
    print(describe_entities(result["entities"]))
    return 0


def cmd_stop(laptop: lp.Laptop, args) -> int:
    return report(send(laptop, "quit", _wait=10))


def cmd_state(laptop: lp.Laptop, args) -> int:
    text = lp.run_ps(laptop, state_script(laptop, args.game), capture=True).stdout
    sample, events = parse_state(text)
    if args.json:
        print(json.dumps({"sample": sample, "events": events}, ensure_ascii=False))
    else:
        print(summarize(sample, events[-args.events :] if args.events else []))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="从开发机试玩:按键、截图、看状态")
    parser.add_argument("--game", default="ff5")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("start", help="在你的桌面上启动试玩助手")
    p.add_argument("--idle", type=int, default=30, help="闲置多少分钟后自动退出")
    p.add_argument(
        "--keep-awake", action="store_true", help="助手运行期间请求 Windows 保持屏幕常亮"
    )
    p.set_defaults(func=cmd_start)
    p = sub.add_parser("link", help="检查局域网直连,并和 SSH 比较延迟")
    p.add_argument("-n", type=int, default=20, help="局域网读几次")
    p.set_defaults(func=cmd_link)

    p = sub.add_parser("restart", help="重启游戏、装上最新桥插件、启动助手、读档")
    p.add_argument("--slot", type=int, default=3)
    p.add_argument("--no-build", action="store_true", help="不重新编译桥插件")
    p.set_defaults(func=cmd_restart)
    sub.add_parser("leave", help="退出商店和菜单,回到地图").set_defaults(func=cmd_leave)
    sub.add_parser("status", help="游戏是否在前台").set_defaults(func=cmd_status)
    sub.add_parser("focus", help="尝试把游戏窗口切到前台").set_defaults(func=cmd_focus)
    sub.add_parser("stop", help="让试玩助手退出").set_defaults(func=cmd_stop)

    p = sub.add_parser("keys", help="按键,例如 Down*3 Enter Up:600")
    p.add_argument("keys", nargs="+")
    p.add_argument("--gap", type=int, default=120, help="两次按键之间的毫秒数")
    p.add_argument("--shot", action="store_true", help="按完截图")
    p.add_argument("--wait", type=int, default=300, help="按完等多久再截图(毫秒)")
    p.add_argument("--max-width", type=int, default=1280)
    p.set_defaults(func=cmd_keys)

    sub.add_parser("pos", help="桥插件看到的地图、格子、朝向").set_defaults(func=cmd_pos)

    p = sub.add_parser("walk", help="闭环走到某一格(需要桥插件 v0.2)")
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)
    p.add_argument("--timeout", type=float, default=15, help="秒")
    p.set_defaults(func=cmd_walk)

    p = sub.add_parser("battle", help="普通战斗:在笔记本本地连按 Enter(攻击、翻结算),回到地图就停")
    p.add_argument("--every", type=int, default=300, help="两次 Enter 之间的毫秒数")
    p.add_argument("--timeout", type=float, default=180, help="秒")
    p.set_defaults(func=cmd_battle)

    p = sub.add_parser("story", help="按阅读速度翻剧情对话,遇到选项或战斗就停")
    p.add_argument("--page", type=float, default=3, help="每页停留秒数")
    p.add_argument("--timeout", type=float, default=600, help="秒")
    p.set_defaults(func=cmd_story)

    p = sub.add_parser("wait", help="等到可以自由行动(对话、战斗、事件结束)")
    p.add_argument("--timeout", type=float, default=120, help="秒")
    p.set_defaults(func=cmd_wait)

    p = sub.add_parser("route", help="在世界地图上寻路并走过去(途中遇敌自动战斗)")
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)
    p.add_argument("--ship", action="store_true", help="坐船:只走海")
    p.add_argument("--plan", action="store_true", help="只打印路线,不走")
    p.set_defaults(func=cmd_route)

    p = sub.add_parser("save", help="从菜单存档到指定存档位(逐步核对,需要桥插件 0.3.0)")
    p.add_argument("--slot", type=int, default=3)
    p.set_defaults(func=cmd_save)
    sub.add_parser("items", help="背包里的道具和贵重物品").set_defaults(func=cmd_items)

    p = sub.add_parser("buy", help="在打开的商店里买东西(需要桥插件 0.4.0)")
    p.add_argument("product")
    p.add_argument("--count", type=int, default=1)
    p.set_defaults(func=cmd_buy)

    p = sub.add_parser("cast", help="在地图上从菜单用魔法(需要桥插件 0.4.1)")
    p.add_argument("caster", help="施法的人")
    p.add_argument("spell", help="魔法名,如 治疗")
    p.add_argument("--target", help="对谁用,默认施法者自己")
    p.set_defaults(func=cmd_cast)
    sub.add_parser("menu", help="桥插件读到的菜单状态(需要 0.4.1)").set_defaults(func=cmd_menu)

    p = sub.add_parser("fight", help="按计划打一场战斗(需要桥插件 0.4.0)")
    p.add_argument("--plan", help='JSON,如 {"法利斯": "黑魔法:闪雷", "蕾娜": "白魔法:治疗"}')
    p.add_argument("--timeout", type=float, default=300)
    p.set_defaults(func=cmd_fight)

    p = sub.add_parser("load", help="在标题画面读取指定存档位(需要桥插件 0.3.0)")
    p.add_argument("--slot", type=int, default=3)
    p.set_defaults(func=cmd_load)

    p = sub.add_parser("open", help="走到某个宝箱/NPC/物体旁边,面向它按确认并翻对话")
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)
    p.set_defaults(func=cmd_open)

    p = sub.add_parser("entities", help="当前地图的实体:入口(通往哪张地图)、宝箱、NPC")
    p.add_argument("--kind", help="按类型过滤,如 GotoMap、TresureBox、Npc")
    p.add_argument("--max", type=int, default=200)
    p.set_defaults(func=cmd_entities)

    p = sub.add_parser("cells", help="玩家周围格子的属性值")
    p.add_argument("--r", type=int, default=8, help="半径")
    p.set_defaults(func=cmd_cells)

    p = sub.add_parser("shot", help="截一张游戏画面")
    p.add_argument("--max-width", type=int, default=1280)
    p.set_defaults(func=cmd_shot)

    p = sub.add_parser("state", help="探针看到的最新状态,以及上次查看后的新事件")
    p.add_argument("--events", type=int, default=20, help="最多显示几条新事件")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_state)
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    try:
        return args.func(lp.Laptop.load(), args)
    except (lp.ConfigError, LookupError, TimeoutError) as exc:
        print(f"错误:{exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"错误:远程命令失败,退出码 {exc.returncode}", file=sys.stderr)
        return exc.returncode or 1
