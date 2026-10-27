"""Talk to the pilot agent on the laptop (deploy/laptop/pilot-agent.ps1): a command file
goes in, a result file comes out, one SSH round trip each. The agent presses keys only
while the game window is in front.

When the LAN link to the bridge is set up (bridge.py, bridge 0.5.0+), `send` answers state
reads and plain key presses over it instead, in milliseconds rather than about a second; the
pilot agent keeps the rest (walk, battle, story, screenshots, focus). If the link fails, the
call falls back to SSH and the link rests for a while. Every call's time goes to TIMING.
"""

import json
import os
import subprocess
import time
from datetime import UTC, datetime

from ffpr_agent import laptop as lp
from ffpr_agent.bridge import BridgeLink, LinkError
from ffpr_agent.repo import DEPS

PILOT = DEPS / "pilot"
SHOTS = PILOT / "shots"
TIMING = PILOT / "timing.jsonl"

# Pilot ops that are plain bridge queries (and plain key presses), so the link can answer them.
LINK_OPS = {"pos", "cells", "entities", "collision", "route", "bridge", "keys", "status"}
LINK_REST_SECONDS = 30

_links: dict[lp.Laptop, BridgeLink | None] = {}
_link_rest_until: dict[lp.Laptop, float] = {}


def agent_dir(laptop: lp.Laptop) -> str:
    return f"{laptop.root}/session/pilot"


def link_for(laptop: lp.Laptop) -> BridgeLink | None:
    """The LAN link, or None when it is not configured, switched off (FFPR_LINK=off) or
    resting after a failure."""
    if os.environ.get("FFPR_LINK") == "off":
        return None
    if time.monotonic() < _link_rest_until.get(laptop, 0):
        return None
    if laptop not in _links:
        _links[laptop] = BridgeLink.load(laptop)
    return _links[laptop]


def use_link(laptop: lp.Laptop, link: BridgeLink | None) -> None:
    """Set the link for a laptop (tests, or None to force SSH)."""
    _links[laptop] = link
    _link_rest_until.pop(laptop, None)


def send(laptop: lp.Laptop, op: str, _wait: float = 30, **fields) -> dict:
    """Run one pilot op: over the LAN link when it can answer it, otherwise through the pilot
    agent over SSH. Returns the same result shape either way."""
    started = time.perf_counter()
    result, via = None, "ssh"
    link = link_for(laptop) if op in LINK_OPS and not fields.get("shot") else None
    if link is not None:
        try:
            result, via = through_link(link, op, fields, _wait), "lan"
        except LinkError:
            _link_rest_until[laptop] = time.monotonic() + LINK_REST_SECONDS
    if result is None:
        result = send_ssh(laptop, op, _wait, **fields)
    record_time(op, via, started)
    return result


def through_link(link: BridgeLink, op: str, fields: dict, wait: float) -> dict:
    """A pilot op answered by the bridge, in the shape the pilot agent would return."""
    if op == "keys":
        reply = link.command("keys", keys=fields["keys"], gap=fields.get("gap", 120), timeout=wait)
        return {k: reply[k] for k in ("ok", "sent", "error") if k in reply}
    if op == "status":
        # The bridge's key thread checks the foreground the same way; it answering at all
        # means the game is running.
        reply = link.command("status", timeout=wait)
        kept = ("ok", "focused", "locked", "foreground", "error")
        return {"running": True, **{k: reply[k] for k in kept if k in reply}}
    if op == "bridge":
        rest = {k: v for k, v in fields.items() if k != "q"}
        reply = link.query(fields["q"], **rest)
        if not reply.get("ok"):
            return {"ok": False, "error": f"bridge_error:{reply.get('error')}"}
        return {"ok": True, "reply": reply}
    defaults = {"cells": {"r": 8}, "entities": {"max": 200}}
    reply = link.query(op, **(defaults.get(op, {}) | fields))
    if not reply.get("ok"):
        return {"ok": False, "error": f"bridge_error:{reply.get('error')}"}
    return {"ok": True, op: reply.get(op)}


def record_time(op: str, via: str, started: float) -> None:
    ms = round((time.perf_counter() - started) * 1000, 1)
    stamp = datetime.now(UTC).isoformat(timespec="milliseconds")
    try:
        TIMING.parent.mkdir(parents=True, exist_ok=True)
        with TIMING.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"t": stamp, "op": op, "via": via, "ms": ms}) + "\n")
    except OSError:
        pass  # timing is a diagnostic; never fail a game action over it


def send_ssh(laptop: lp.Laptop, op: str, _wait: float = 30, **fields) -> dict:
    """Drop a command file for the agent and wait for its result, in one SSH round trip."""
    cid = str(time.time_ns())
    body = json.dumps({"op": op, **fields}, ensure_ascii=False)
    script = (
        f"$dir = {lp.ps_quote(agent_dir(laptop))}\n"
        "if (-not (Test-Path (Join-Path $dir 'agent.json'))) {"
        " throw '试玩助手没有运行:先运行 ffpr-pilot start' }\n"
        f"$tmp = Join-Path $dir '{cid}.tmp'\n"
        "$utf8 = New-Object Text.UTF8Encoding $false\n"
        f"[IO.File]::WriteAllText($tmp, {lp.ps_quote(body)}, $utf8)\n"
        f"Move-Item $tmp (Join-Path $dir '{cid}.cmd.json')\n"
        f"$res = Join-Path $dir '{cid}.result.json'\n"
        f"$deadline = (Get-Date).AddSeconds({_wait})\n"
        "while (-not (Test-Path $res)) {\n"
        "  if ((Get-Date) -gt $deadline) { throw '等待试玩助手超时' }\n"
        "  Start-Sleep -Milliseconds 25\n"
        "}\n"
        "Get-Content $res -Raw -Encoding UTF8\n"
        "Remove-Item $res -Force"
    )
    return json.loads(lp.run_ps(laptop, script, capture=True).stdout.strip())


def query(laptop: lp.Laptop, q: str, **fields) -> dict:
    """Any bridge query through the agent's pass-through; returns the bridge's reply."""
    return send(laptop, "bridge", q=q, **fields).get("reply") or {}


def fetch_shot(laptop: lp.Laptop, result: dict) -> str | None:
    if not result.get("shot"):
        return None
    SHOTS.mkdir(parents=True, exist_ok=True)
    local = SHOTS / f"{result['id']}.png"
    remote = f"{laptop.target}:{agent_dir(laptop)}/{result['id']}.png"
    subprocess.run([*laptop.scp(), remote, str(local)], check=True, capture_output=True)
    return str(local)


def start_agent(laptop: lp.Laptop, game: str, idle: int = 30, keep_awake: bool = False) -> dict:
    """Start pilot-agent.ps1 on the desktop (hidden) and wait until it answers; returns its
    status. `keep_awake` asks Windows to keep the display on while it runs (opt-in)."""
    lp.run_ps(
        laptop,
        f"$dir = {lp.ps_quote(agent_dir(laptop))}\n"
        "New-Item -ItemType Directory -Force $dir | Out-Null\n"
        # Not -ErrorAction SilentlyContinue: a failed last statement makes powershell exit 1.
        "$agent = Join-Path $dir 'agent.json'\n"
        "if (Test-Path $agent) { Remove-Item $agent -Force }",
    )
    script = f"{laptop.root}/deploy/laptop/pilot-agent.ps1"
    command = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden"]
    command += ["-File", script, "-Game", game, "-IdleMinutes", str(idle)]
    if keep_awake:
        command.append("-KeepAwake")
    lp.run_in_session(laptop, lp.session_request("powershell.exe", command, None, False), 60)
    deadline = time.monotonic() + 30
    while True:
        try:
            # Ask the agent itself: `send` answers status from the bridge over the LAN link,
            # which is up without the agent (10-21: restart returned with no agent running).
            return send_ssh(laptop, "status", 10)
        except subprocess.CalledProcessError:
            if time.monotonic() > deadline:
                raise
            time.sleep(1)


def agent_running(laptop: lp.Laptop) -> bool:
    try:
        send_ssh(laptop, "status", 10)
        return True
    except subprocess.CalledProcessError:
        return False


def ensure_agent(laptop: lp.Laptop, game: str) -> bool:
    """Start the pilot agent unless it is running; True when it had to be started."""
    if agent_running(laptop):
        return False
    start_agent(laptop, game)
    return True
