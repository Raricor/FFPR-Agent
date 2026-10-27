"""The link to the Windows laptop: SSH with one dedicated key, PowerShell over
-EncodedCommand, programs started on the desktop through the logon-only scheduled task, and
the few operations other code builds on (deploy the scripts, install the bridge, launch a game).

Settings live in agent/laptop.env (copy agent/laptop.env.example). ffpr-laptop is the command
line for all of it.
"""

import base64
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from ffpr_agent.repo import DEPS, REPO
from ffpr_common.games import Game
from ffpr_common.secrets import parse_env_file

CONFIG = REPO / "agent" / "laptop.env"


SESSION_TASK = "FFPR-Agent-Session"


# Without this, PowerShell writes to the SSH pipe in the OEM code page and Chinese is garbled.
PS_PRELUDE = (
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; "
    "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'\n"
)


# With stderr on a pipe, powershell.exe serialises its error and warning streams as CLIXML.
_CLIXML_BLOCK = re.compile(r"(<Objs\b.*?</Objs>)", re.S)


_CLIXML_STRING = re.compile(r'<S S="(\w+)">(.*?)</S>', re.S)


_CLIXML_ESCAPE = re.compile(r"_x([0-9A-Fa-f]{4})_")


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Laptop:
    host: str
    user: str
    key: Path
    root: str = "C:/ffpr"
    # The account logged on to the desktop, which the session task runs as (MIFEITECH\yangwt).
    desktop_user: str | None = None
    # The LAN link to the bridge (control plan §5): its URL, and the address the laptop sees
    # the dev box connect from (the dev box runs in a container, so it is the host's address).
    bridge_url: str | None = None
    devbox_address: str | None = None

    @classmethod
    def load(cls, path: Path = CONFIG) -> "Laptop":
        if not path.exists():
            raise ConfigError(f"缺少 {path}:请复制 agent/laptop.env.example 并填写")
        values = parse_env_file(path.read_text(encoding="utf-8"))
        missing = [k for k in ("LAPTOP_HOST", "LAPTOP_USER") if not values.get(k)]
        if missing:
            raise ConfigError(f"{path} 里缺少 {', '.join(missing)}")
        key = values.get("LAPTOP_KEY") or "~/.ssh/ffpr_laptop_ed25519"
        return cls(
            host=values["LAPTOP_HOST"],
            user=values["LAPTOP_USER"],
            key=Path(key).expanduser(),
            root=values.get("LAPTOP_ROOT") or "C:/ffpr",
            desktop_user=values.get("LAPTOP_DESKTOP_USER") or None,
            bridge_url=values.get("BRIDGE_URL") or None,
            devbox_address=values.get("DEVBOX_ADDRESS") or None,
        )

    @property
    def target(self) -> str:
        return f"{self.user}@{self.host}"

    def ssh(self) -> list[str]:
        return ["ssh", *self._options(), self.target]

    def scp(self) -> list[str]:
        return ["scp", *self._options(), "-r"]

    def _options(self) -> list[str]:
        # IdentitiesOnly: never fall back to keys in a forwarded ssh-agent, only the dedicated key.
        # WarnWeakCrypto=no: Windows OpenSSH 9.5 offers no post-quantum key exchange, and the
        # warning about it would otherwise precede every command.
        # ControlMaster: reuse one connection for a few minutes; the pilot sends many commands.
        return [
            *("-i", str(self.key), "-o", "IdentitiesOnly=yes"),
            *("-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "WarnWeakCrypto=no"),
            *("-o", "ControlMaster=auto", "-o", "ControlPersist=300"),
            *("-o", f"ControlPath={Path.home() / '.ssh' / 'ffpr-cm-%C'}"),
        ]


def ps_quote(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def encode_ps(script: str) -> str:
    """Base64 of UTF-16LE, the format powershell -EncodedCommand expects. Avoids all quoting."""
    return base64.b64encode((PS_PRELUDE + script).encode("utf-16-le")).decode("ascii")


def decode_clixml(text: str) -> str:
    """Turn PowerShell's CLIXML stderr back into the text it would have printed."""
    if not text.startswith("#< CLIXML"):
        return text
    out = []
    for part in _CLIXML_BLOCK.split(text.removeprefix("#< CLIXML").lstrip("\r\n")):
        if not part.startswith("<Objs"):
            out.append(part)
            continue
        for stream, raw in _CLIXML_STRING.findall(part):
            value = _CLIXML_ESCAPE.sub(lambda m: chr(int(m[1], 16)), html.unescape(raw))
            out.append(("警告:" if stream.lower() == "warning" else "") + value)
    return "".join(out).replace("\r\n", "\n")


def run_ps(laptop: Laptop, script: str, *, check: bool = True, capture: bool = False):
    # The laptop's machine policy is AllSigned; Bypass for this process lets our unsigned
    # scripts run without changing the policy itself.
    cmd = [
        *laptop.ssh(),
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
    ]
    cmd += ["-EncodedCommand", encode_ps(script)]
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    result.stderr = decode_clixml(result.stderr)
    sys.stderr.write(result.stderr)
    if check and result.returncode:
        raise subprocess.CalledProcessError(result.returncode, cmd, result.stdout, result.stderr)
    return result


def deployed_script(laptop: Laptop, name: str) -> str:
    return ps_quote(f"{laptop.root}/deploy/laptop/{name}")


def session_request(file: str, args: list[str], cwd: str | None, wait: bool) -> dict:
    return {"id": uuid.uuid4().hex[:12], "file": file, "args": args, "cwd": cwd, "wait": wait}


def run_in_session(laptop: Laptop, request: dict, timeout: float) -> dict:
    """Run a program on the laptop's desktop through the logon-only scheduled task."""
    session = f"{laptop.root}/session"
    body = json.dumps(request, ensure_ascii=False)
    run_ps(
        laptop,
        f"New-Item -ItemType Directory -Force {ps_quote(session)} | Out-Null\n"
        f"[IO.File]::WriteAllText({ps_quote(session + '/request.json')}, {ps_quote(body)}, "
        "(New-Object Text.UTF8Encoding $false))\n"
        # schtasks.exe, not Start-ScheduledTask: CIM is denied to ffpr's network logon.
        f"schtasks.exe /run /tn {ps_quote(SESSION_TASK)} | Out-Null\n"
        "if ($LASTEXITCODE) { throw '触发计划任务失败:还没注册,或者没有授权给这个账号' }",
    )
    status_path = ps_quote(f"{session}/{request['id']}.status.json")
    deadline = time.monotonic() + timeout
    final = {"started", "done", "error"} if not request["wait"] else {"done", "error"}
    while time.monotonic() < deadline:
        out = run_ps(
            laptop,
            f"if (Test-Path {status_path}) {{ Get-Content {status_path} -Raw -Encoding UTF8 }}",
            capture=True,
        ).stdout.strip()
        if out:
            status = json.loads(out)
            if status.get("state") in final:
                return status
        time.sleep(2)
    raise TimeoutError("等待超时:笔记本上可能没有登录桌面,或者还没注册计划任务")


def secure_root_script(laptop: Laptop) -> str:
    """Create the root and limit it to SYSTEM, Administrators, us and the desktop user.

    The session task runs request.json as the desktop user, so nobody else may write here; the
    default C:\\ inheritance would let every local account (Codex sandboxes included) do so.
    """
    if not laptop.desktop_user:
        raise ConfigError(
            "laptop.env 里缺少 LAPTOP_DESKTOP_USER(你登录桌面的账号,如 MIFEITECH\\yangwt)"
        )
    return (
        f"$root = {ps_quote(laptop.root)}\n"
        "New-Item -ItemType Directory -Force $root | Out-Null\n"
        "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value\n"
        f"$desktop = ([Security.Principal.NTAccount]{ps_quote(laptop.desktop_user)})"
        ".Translate([Security.Principal.SecurityIdentifier]).Value\n"
        "& icacls.exe $root /inheritance:r /grant:r "
        "'*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "
        '"*${me}:(OI)(CI)F" "*${desktop}:(OI)(CI)M" | Out-Null\n'
        'if ($LASTEXITCODE) { throw "icacls 失败,退出码 $LASTEXITCODE" }'
    )


def dotnet() -> tuple[str, dict]:
    """The dotnet executable and environment; the SDK lives in ~/.dotnet on the dev box."""
    env = dict(os.environ)
    found = shutil.which("dotnet")
    if found:
        return found, env
    home = Path.home() / ".dotnet"
    env.setdefault("DOTNET_ROOT", str(home))
    return str(home / "dotnet"), env


def deploy(laptop: Laptop) -> None:
    """Copy deploy/laptop to the laptop's root, which only we and the desktop user may write."""
    run_ps(
        laptop,
        secure_root_script(laptop) + "\n"
        f"New-Item -ItemType Directory -Force {ps_quote(laptop.root + '/deploy')} | Out-Null",
    )
    subprocess.run(
        [*laptop.scp(), str(REPO / "deploy" / "laptop"), f"{laptop.target}:{laptop.root}/deploy/"],
        check=True,
    )


def launch(laptop: Laptop, game: Game, timeout: float = 60) -> str:
    """Ask Steam on the desktop to start the game; returns the session task's state."""
    request = session_request(f"steam://rungameid/{game.app_id}", [], None, False)
    return run_in_session(laptop, request, timeout).get("state")


def install_plugin(laptop: Laptop, game: Game, build: bool = True) -> str:
    """Build the bridge (unless `build` is false) and copy it into the game's BepInEx. The game
    must not be running: it holds the plugin file open."""
    if build:
        exe, env = dotnet()
        command = [exe, "build", str(REPO / "bridge"), "-c", "Release", f"-p:Game={game.key}"]
        subprocess.run([*command, "-nologo", "-v:q"], check=True, env=env)
    dll = REPO / "bridge" / "bin" / game.key / "Release" / "FfprBridge.dll"
    staging = f"{laptop.root}/staging/plugin"
    run_ps(laptop, f"New-Item -ItemType Directory -Force {ps_quote(staging)} | Out-Null")
    subprocess.run(
        [*laptop.scp(), str(dll), f"{laptop.target}:{staging}/FfprBridge.dll"], check=True
    )
    return run_ps(
        laptop,
        f"Import-Module {deployed_script(laptop, 'FfprCommon.psm1')} -Force\n"
        f"$dir = Find-GameDir {game.key}\n"
        "if (Test-GameRunning $dir) { throw '游戏正在运行:插件文件被占用,请先退出游戏' }\n"
        "$dest = Join-Path $dir 'BepInEx\\plugins\\FfprBridge'\n"
        "New-Item -ItemType Directory -Force $dest | Out-Null\n"
        f"Copy-Item {ps_quote(staging + '/FfprBridge.dll')} $dest -Force\n"
        "'已安装到 ' + $dest",
        capture=True,
    ).stdout.strip()


def fetch_probe_logs(laptop: Laptop, game: Game, last: int = 3) -> str:
    """Copy the newest `last` probe files to .deps/<game>/probe; returns their names and sizes."""
    staged = f"{laptop.root}/staging/probe-{game.key}"
    # The game keeps the newest file open for writing; File.Copy would hit a sharing violation,
    # so read with ReadWrite sharing.
    listing = run_ps(
        laptop,
        f"Import-Module {deployed_script(laptop, 'FfprCommon.psm1')} -Force\n"
        f"$src = Join-Path (Find-GameDir {game.key}) 'BepInEx\\ffpr'\n"
        f"$dst = {ps_quote(staged)}\n"
        "if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }\n"
        "New-Item -ItemType Directory -Force $dst | Out-Null\n"
        "$files = Get-ChildItem $src -Filter 'probe-*.jsonl' |"
        " Sort-Object LastWriteTime -Descending\n"
        f"foreach ($f in @($files | Select-Object -First {int(last)})) {{\n"
        "  $in = [IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite')\n"
        "  $out = [IO.File]::Create((Join-Path $dst $f.Name))\n"
        "  try { $in.CopyTo($out) } finally { $out.Close(); $in.Close() }\n"
        "  '{0}  {1:N0} KB' -f $f.Name, ($f.Length / 1KB)\n"
        "}",
        capture=True,
    ).stdout.strip()
    dest = DEPS / game.key / "probe"
    dest.mkdir(parents=True, exist_ok=True)
    subprocess.run([*laptop.scp(), f"{laptop.target}:{staged}/*", str(dest)], check=True)
    return listing
