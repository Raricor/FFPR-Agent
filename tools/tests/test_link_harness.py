"""The LAN link end to end on the dev box: the bridge's real socket code (Outbox.cs, Link.cs)
in tools/link_harness, with ffpr_agent's client talking to it. Skipped without the .NET SDK."""

import json
import shutil
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest
from websockets.sync.client import connect

from ffpr_agent import laptop as lp
from ffpr_agent import pilot
from ffpr_agent.bridge import BridgeLink, LinkError

HARNESS = Path(__file__).resolve().parent.parent / "link_harness"
DOTNET = shutil.which("dotnet") or str(Path.home() / ".dotnet" / "dotnet")
TOKEN = "t" * 40

pytestmark = pytest.mark.skipif(not Path(DOTNET).exists(), reason="没有 .NET SDK")


def own_address() -> str:
    """This machine's LAN-facing address (the bridge refuses to listen on loopback)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect(("192.0.2.1", 9))  # no packet is sent for UDP connect
        return s.getsockname()[0]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def harness_dll():
    subprocess.run(
        [DOTNET, "build", str(HARNESS), "-c", "Release", "-nologo", "-v:q"],
        check=True,
        capture_output=True,
    )
    return HARNESS / "bin" / "Release" / "net8.0" / "LinkHarness.dll"


def start(harness_dll, tmp_path, allow: list[str], port: int | None = None):
    address, port = own_address(), port or free_port()
    link_file = tmp_path / f"link-{port}.json"
    link_file.write_text(json.dumps({"listen": address, "allow": allow, "token": TOKEN}))
    probe = tmp_path / f"probe-{port}.jsonl"
    proc = subprocess.Popen(
        [DOTNET, str(harness_dll), str(port), str(link_file), str(probe)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout.readline().strip() == "ready"
    for _ in range(50):  # the listeners start on their own threads
        with socket.socket() as s:
            if s.connect_ex((address, port)) == 0:
                break
        time.sleep(0.05)
    return proc, f"http://{address}:{port}", port


@pytest.fixture
def bridge(harness_dll, tmp_path):
    proc, url, port = start(harness_dll, tmp_path, [own_address()])
    yield url, port
    proc.stdin.close()
    proc.wait(timeout=5)


def test_health_needs_the_token(bridge):
    url, _ = bridge
    ok = httpx.get(f"{url}/v1/health", headers={"Authorization": f"Bearer {TOKEN}"})
    assert ok.status_code == 200 and ok.json()["hello"]["plugin"] == "harness"
    assert httpx.get(f"{url}/v1/health").status_code == 401
    wrong = httpx.get(f"{url}/v1/health", headers={"Authorization": "Bearer " + "x" * 40})
    assert wrong.status_code == 401


def test_query_command_and_stream(bridge):
    url, _ = bridge
    link = BridgeLink(url, TOKEN)
    reply = link.query("cells", r=3)
    assert reply["ok"] and reply["cells"]["r"] == 3
    assert link.query("pos")["re"] != reply["re"]  # each query has its own id
    assert link.command("keys", keys=["Down*2", "Enter"])["sent"] == 2
    records = link.stream()
    assert next(records)["type"] == "hello"
    assert next(records)["type"] == "sample"
    link.close()


def test_pilot_send_uses_the_link_and_falls_back(bridge, monkeypatch):
    url, _ = bridge
    laptop = lp.Laptop(host="unused", user="unused", key=Path("unused"))
    calls = []
    monkeypatch.setattr(pilot, "send_ssh", lambda *a, **k: calls.append(a[1]) or {"ok": True})
    monkeypatch.setattr(pilot, "TIMING", Path("/dev/null"))
    pilot.use_link(laptop, BridgeLink(url, TOKEN))
    assert pilot.send(laptop, "pos") == {"ok": True, "pos": {"id": 1, "op": "pos"}}
    assert pilot.query(laptop, "menu")["menu"]["op"] == "menu"
    assert pilot.send(laptop, "keys", keys=["Enter"]) == {"ok": True, "sent": 1}
    assert pilot.send(laptop, "status")["focused"] is True  # no SSH for the per-step check
    assert pilot.send(laptop, "walk", to=[1, 2]) == {"ok": True}  # the pilot agent's job
    assert calls == ["walk"]

    pilot.use_link(laptop, BridgeLink("http://127.0.0.1:9", TOKEN, connect_timeout=0.5))
    assert pilot.send(laptop, "pos") == {"ok": True}  # link down: SSH answered
    assert pilot.link_for(laptop) is None  # and the link rests for a while
    pilot.use_link(laptop, None)


def test_clients_not_allowed_are_cut_off(harness_dll, tmp_path):
    proc, url, _ = start(harness_dll, tmp_path, ["10.9.9.9"])
    try:
        with pytest.raises(LinkError):
            BridgeLink(url, TOKEN, connect_timeout=1).query("pos")
        with pytest.raises(httpx.HTTPError):
            httpx.get(f"{url}/v1/health", headers={"Authorization": f"Bearer {TOKEN}"})
    finally:
        proc.stdin.close()
        proc.wait(timeout=5)


def test_loopback_still_works_without_a_token(bridge):
    _, port = bridge
    with connect(f"ws://127.0.0.1:{port}/query") as ws:
        assert json.loads(ws.recv(timeout=2))["type"] == "hello"
        ws.send(json.dumps({"id": 7, "op": "pos"}))
        assert json.loads(ws.recv(timeout=2))["re"] == 7


def test_a_taken_loopback_port_is_retried(harness_dll, tmp_path):
    # 10-20: VS Code's port forwarding held 127.0.0.1:47800 on the laptop before the game started.
    port = free_port()
    squatter = socket.socket()
    squatter.bind(("127.0.0.1", port))
    squatter.listen()
    proc, url, _ = start(harness_dll, tmp_path, [own_address()], port)
    try:
        assert BridgeLink(url, TOKEN).query("pos")["ok"]  # the LAN side is not held up
        squatter.close()
        for _ in range(80):
            try:
                with connect(f"ws://127.0.0.1:{port}/query", open_timeout=1) as ws:
                    assert json.loads(ws.recv(timeout=2))["type"] == "hello"
                    break
            except OSError:
                time.sleep(0.1)
        else:
            pytest.fail("回环端口让出来以后,桥插件没有接上")
    finally:
        proc.stdin.close()
        proc.wait(timeout=5)
