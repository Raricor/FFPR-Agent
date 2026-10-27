"""Restart a game with the newest bridge and load a save: how every play session starts.

deploy the laptop scripts → stop the pilot agent → quit the game → install the bridge →
launch → wait for the title screen with that bridge version → start the pilot agent → load.
"""

import contextlib
import re
import subprocess

from ffpr_agent import laptop as lp
from ffpr_agent.pilot import send, start_agent
from ffpr_agent.repo import REPO
from ffpr_agent.skills.save import load_game
from ffpr_common.games import Game


def bridge_version() -> str:
    text = (REPO / "bridge" / "src" / "Plugin.cs").read_text(encoding="utf-8")
    return re.search(r'Version = "([0-9.]+)"', text).group(1)


def newest_probe(laptop: lp.Laptop, game: Game) -> str:
    """The newest probe file's name on the laptop ("" if none), so the wait below can tell the
    file of the new start from the old ones."""
    return lp.run_ps(
        laptop,
        f"Import-Module {lp.deployed_script(laptop, 'FfprCommon.psm1')} -Force\n"
        f"$dir = Join-Path (Find-GameDir {game.key}) 'BepInEx\\ffpr'\n"
        "$f = Get-ChildItem $dir -Filter 'probe-*.jsonl' -ErrorAction SilentlyContinue |"
        " Sort-Object Name | Select-Object -Last 1\n"
        "if ($f) { $f.Name }",
        capture=True,
    ).stdout.strip()


def quit_game(laptop: lp.Laptop, game: Game) -> None:
    """End the game on the desktop (it runs as the desktop user, so taskkill goes through the
    session task) and wait until the process is gone."""
    taskkill = lp.session_request(
        r"C:\Windows\System32\taskkill.exe", ["/im", f"{game.title}.exe"], None, True
    )
    lp.run_in_session(laptop, taskkill, 40)  # exits non-zero when the game was not running
    lp.run_ps(
        laptop,
        "foreach ($i in 1..20) {"
        f" if (-not (Get-Process {lp.ps_quote(game.title)} -ErrorAction SilentlyContinue))"
        " { return }; Start-Sleep 2 }\n"
        f"throw '{game.title} 仍在运行'",
    )


def restart(
    laptop: lp.Laptop, game: Game, slot: int = 3, build: bool = True, say=print
) -> tuple[bool, str]:
    say("部署笔记本脚本")
    lp.deploy(laptop)
    with contextlib.suppress(subprocess.CalledProcessError):  # the agent was not running
        send(laptop, "quit", _wait=10)
    say(f"退出 {game.label}")
    quit_game(laptop, game)
    say(lp.install_plugin(laptop, game, build))
    before = newest_probe(laptop, game)
    version = bridge_version()
    say(f"启动 {game.label},等桥插件 {version} 到达标题画面")
    lp.launch(laptop, game)
    title = lp.run_ps(
        laptop,
        f"& {lp.deployed_script(laptop, 'wait-title.ps1')} -Game {game.key} -Version {version}"
        f" -After {lp.ps_quote(before)}",
        capture=True,
    )
    say(title.stdout.strip())
    if not start_agent(laptop, game.key).get("focused"):
        send(laptop, "focus")
    status = send(laptop, "status")
    if status.get("locked"):
        # Keys cannot reach the game; never unlock remotely (10-21: the load list never came).
        return False, "笔记本锁屏了,按键进不了游戏:请在笔记本上解锁,再读档"
    return load_game(laptop, slot)
