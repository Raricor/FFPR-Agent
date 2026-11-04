"""ffpr-laptop: operate the laptop over SSH (deploy, run PowerShell, start programs on the
desktop, install the bridge, fetch logs and assemblies)."""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from secrets import token_urlsafe

from ffpr_agent.laptop import (
    ConfigError,
    Laptop,
    deploy,
    deployed_script,
    fetch_probe_logs,
    install_plugin,
    launch,
    ps_quote,
    run_in_session,
    run_ps,
    session_request,
)
from ffpr_agent.repo import DEPS
from ffpr_common.games import by_key
from ffpr_common.paths import secrets_path
from ffpr_common.secrets import Secrets, store


def cmd_link(laptop: Laptop, args) -> int:
    """Set up the LAN link to the bridge (control plan §5): a token in secrets.env, and
    bridge.json on the laptop, which the bridge reads when the game starts."""
    if not laptop.devbox_address:
        raise ConfigError("agent/laptop.env 里缺少 DEVBOX_ADDRESS(笔记本看到的开发机地址)")
    if not args.new_token and Secrets.load().has("BRIDGE_TOKEN"):
        print("沿用 secrets.env 里的 BRIDGE_TOKEN")
    else:
        store(secrets_path(), "BRIDGE_TOKEN", token_urlsafe(32))
        print(f"新令牌已写进 {secrets_path()}")
    body = {
        "listen": args.listen or laptop.host,
        "allow": [laptop.devbox_address],
        "token": Secrets.load().get("BRIDGE_TOKEN"),
    }
    fd, local = tempfile.mkstemp(suffix=".json")  # readable only by us; removed right after
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(body, f)
        subprocess.run(
            [*laptop.scp(), local, f"{laptop.target}:{laptop.root}/bridge.json"], check=True
        )
    finally:
        os.remove(local)
    print(
        f"已写入 {laptop.root}/bridge.json:监听 {body['listen']},只允许 {laptop.devbox_address}。"
        "重启游戏后生效;防火墙规则用 deploy/laptop/allow-bridge-lan.ps1 加(要管理员)"
    )
    return 0


def cmd_ping(laptop: Laptop, args) -> int:
    run_ps(
        laptop,
        "$id = [Security.Principal.WindowsIdentity]::GetCurrent()\n"
        "$admin = ([Security.Principal.WindowsPrincipal]$id).IsInRole('Administrators')\n"
        "'PowerShell ' + $PSVersionTable.PSVersion.ToString()\n"
        "'用户 ' + $id.Name + $(if ($admin) { '(管理员)' } else { '(普通用户)' })",
    )
    return 0


def cmd_deploy(laptop: Laptop, args) -> int:
    deploy(laptop)
    print(f"已部署到 {laptop.root}/deploy/laptop")
    return 0


def cmd_ps(laptop: Laptop, args) -> int:
    return run_ps(laptop, args.command, check=False).returncode


def cmd_script(laptop: Laptop, args) -> int:
    line = f"& {deployed_script(laptop, args.name)} {' '.join(args.args)}"
    return run_ps(laptop, line, check=False).returncode


def cmd_session(laptop: Laptop, args) -> int:
    status = run_in_session(
        laptop, session_request(args.file, args.arg or [], args.cwd, args.wait), args.timeout
    )
    print(json.dumps(status, ensure_ascii=False))
    if status.get("state") == "error":
        return 1
    return status.get("exit_code") or 0


def cmd_launch(laptop: Laptop, args) -> int:
    game = by_key(args.game)
    state = launch(laptop, game, args.timeout)
    print(f"已请求启动 {game.label}:{state}")
    return 0 if state != "error" else 1


def cmd_fetch_assemblies(laptop: Laptop, args) -> int:
    game = by_key(args.game)
    result = run_ps(
        laptop,
        f"& {deployed_script(laptop, 'collect-assemblies.ps1')} -Game {game.key}",
        check=False,
    )
    if result.returncode != 0:
        print("笔记本上的收集脚本没有成功,见上面的提示", file=sys.stderr)
        return result.returncode
    dest = DEPS / game.key
    if dest.exists():
        shutil.rmtree(dest)
    DEPS.mkdir(exist_ok=True)
    subprocess.run(
        [*laptop.scp(), f"{laptop.target}:{laptop.root}/staging/{game.key}", str(DEPS)], check=True
    )
    print(f"已取回到 {dest}")
    return 0


def cmd_install_plugin(laptop: Laptop, args) -> int:
    print(install_plugin(laptop, by_key(args.game), build=not args.no_build))
    return 0


def cmd_probe_logs(laptop: Laptop, args) -> int:
    print(fetch_probe_logs(laptop, by_key(args.game), args.last))
    print(f"已取回到 {DEPS / args.game / 'probe'}")
    return 0


def cmd_logs(laptop: Laptop, args) -> int:
    game = by_key(args.game)
    staged = f"{laptop.root}/staging/{game.key}-LogOutput.log"
    run_ps(
        laptop,
        f"Import-Module {deployed_script(laptop, 'FfprCommon.psm1')} -Force\n"
        f"$log = Join-Path (Find-GameDir {game.key}) 'BepInEx\\LogOutput.log'\n"
        f"New-Item -ItemType Directory -Force {ps_quote(laptop.root + '/staging')} | Out-Null\n"
        f"Copy-Item $log {ps_quote(staged)} -Force",
    )
    DEPS.mkdir(exist_ok=True)
    dest = DEPS / f"{game.key}-LogOutput.log"
    subprocess.run([*laptop.scp(), f"{laptop.target}:{staged}", str(dest)], check=True)
    print(f"已取回到 {dest}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="通过 SSH 操作笔记本")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ping", help="检查 SSH 连接").set_defaults(func=cmd_ping)
    sub.add_parser("deploy", help="把 deploy/laptop 复制到笔记本").set_defaults(func=cmd_deploy)

    p = sub.add_parser("link", help="设置局域网直连桥插件:令牌和 bridge.json(重启游戏后生效)")
    p.add_argument("--listen", help="桥插件监听的地址,默认 LAPTOP_HOST")
    p.add_argument("--new-token", action="store_true", help="换一个新令牌")
    p.set_defaults(func=cmd_link)

    p = sub.add_parser("ps", help="在笔记本上执行一段 PowerShell")
    p.add_argument("command")
    p.set_defaults(func=cmd_ps)

    p = sub.add_parser("script", help="执行已部署的脚本")
    p.add_argument("name", help="例如 install-bepinex.ps1")
    p.add_argument("args", nargs=argparse.REMAINDER, help="传给脚本的参数")
    p.set_defaults(func=cmd_script)

    p = sub.add_parser("session", help="在你的桌面会话里运行程序")
    p.add_argument("file")
    p.add_argument("--arg", action="append", help="参数,可以重复")
    p.add_argument("--cwd")
    p.add_argument("--wait", action="store_true", help="等程序结束")
    p.add_argument("--timeout", type=float, default=60)
    p.set_defaults(func=cmd_session)

    p = sub.add_parser("launch", help="在笔记本桌面上启动游戏")
    p.add_argument("game")
    p.add_argument("--timeout", type=float, default=60)
    p.set_defaults(func=cmd_launch)

    for name, func, text in (
        ("fetch-assemblies", cmd_fetch_assemblies, "取回逆向需要的程序集到 .deps/<作品>"),
        ("logs", cmd_logs, "取回 BepInEx 的日志"),
    ):
        p = sub.add_parser(name, help=text)
        p.add_argument("game")
        p.set_defaults(func=func)

    p = sub.add_parser("install-plugin", help="编译桥插件并装进游戏(游戏需已退出)")
    p.add_argument("game")
    p.add_argument("--no-build", action="store_true", help="不重新编译,直接装上次的结果")
    p.set_defaults(func=cmd_install_plugin)

    p = sub.add_parser("probe-logs", help="取回探针日志到 .deps/<作品>/probe")
    p.add_argument("game")
    p.add_argument("--last", type=int, default=3, help="取最近几个文件")
    p.set_defaults(func=cmd_probe_logs)
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    try:
        return args.func(Laptop.load(), args)
    except (ConfigError, LookupError, TimeoutError) as exc:
        print(f"错误:{exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"错误:远程命令失败,退出码 {exc.returncode}", file=sys.stderr)
        return exc.returncode or 1
