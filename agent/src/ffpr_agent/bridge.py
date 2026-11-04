"""The LAN link to the bridge (control plan §5): HTTP and WebSocket straight to the game
process, no SSH and no PowerShell per call. Needs bridge 0.5.0+, `ffpr-laptop link` once
(token and C:\\ffpr\\bridge.json), and the firewall rule from allow-bridge-lan.ps1.

    link = BridgeLink.load(laptop)              # None when no BRIDGE_TOKEN is configured
    link.health()                               # GET /v1/health
    link.query("pos")                           # on a kept-open /v1/query socket
    link.command("keys", keys=["Down*2", "Enter"], gap=120)
    for record in link.stream(): ...            # every record the bridge writes

The address is BRIDGE_URL in agent/laptop.env (default http://<LAPTOP_HOST>:47800); the token
is BRIDGE_TOKEN in secrets.env.
"""

import itertools
import json
import threading
from collections.abc import Iterator

import httpx
from websockets.exceptions import WebSocketException
from websockets.sync.client import ClientConnection, connect

from ffpr_agent import laptop as lp
from ffpr_common.secrets import Secrets

DEFAULT_PORT = 47800


class LinkError(RuntimeError):
    pass


class BridgeLink:
    def __init__(self, url: str, token: str, timeout: float = 5.0, connect_timeout: float = 2.0):
        self.url = url.rstrip("/")
        self.timeout = timeout
        self.connect_timeout = connect_timeout
        self._headers = {"Authorization": f"Bearer {token}"}
        self._sockets: dict[str, ClientConnection] = {}
        self._ids = itertools.count(1)
        self._lock = threading.Lock()

    @classmethod
    def load(cls, laptop: lp.Laptop, secrets: Secrets | None = None) -> "BridgeLink | None":
        secrets = secrets or Secrets.load()
        if not secrets.has("BRIDGE_TOKEN"):
            return None
        url = laptop.bridge_url or f"http://{laptop.host}:{DEFAULT_PORT}"
        return cls(url, secrets.get("BRIDGE_TOKEN"))

    def health(self) -> dict:
        response = httpx.get(
            f"{self.url}/v1/health", headers=self._headers, timeout=self.connect_timeout
        )
        if response.status_code != 200:
            raise LinkError(f"/v1/health 返回 {response.status_code}")
        return response.json()

    def query(self, op: str, **fields) -> dict:
        """One bridge query; returns the bridge's reply (with "ok" and the op's data)."""
        return self._ask("/v1/query", op, fields)

    def command(self, op: str, timeout: float | None = None, **fields) -> dict:
        """One key command (keys, status, stop); returns when the bridge has finished it."""
        return self._ask("/v1/command", op, fields, timeout)

    def stream(self) -> Iterator[dict]:
        """Every record the bridge writes from now on (hello first), until the caller stops."""
        with self._connect("/v1/stream") as ws:
            for message in ws:
                yield json.loads(message)

    def close(self) -> None:
        with self._lock:
            for ws in self._sockets.values():
                ws.close()
            self._sockets.clear()

    def _ws_url(self, path: str) -> str:
        return "ws" + self.url.removeprefix("http") + path

    def _connect(self, path: str) -> ClientConnection:
        try:
            return connect(
                self._ws_url(path),
                additional_headers=self._headers,
                open_timeout=self.connect_timeout,
                max_size=16 * 1024 * 1024,
                compression=None,
            )
        except (OSError, WebSocketException, TimeoutError) as exc:
            raise LinkError(f"连不上 {self._ws_url(path)}:{exc}") from exc

    def _socket(self, path: str) -> ClientConnection:
        ws = self._sockets.get(path)
        if ws is None:
            # Kept open across calls, so entered by hand; close() and _ask() close it.
            ws = self._connect(path).__enter__()
            ws.recv(timeout=self.connect_timeout)  # the hello record
            self._sockets[path] = ws
        return ws

    def _ask(self, path: str, op: str, fields: dict, timeout: float | None = None) -> dict:
        with self._lock:
            for attempt in (1, 2):
                try:
                    return self._ask_once(path, op, fields, timeout or self.timeout)
                except (OSError, WebSocketException, TimeoutError) as exc:
                    # A dropped socket (game restarted, network blip): reconnect once.
                    stale = self._sockets.pop(path, None)
                    if stale is not None:
                        stale.close()
                    if attempt == 2:
                        raise LinkError(f"{path} {op} 失败:{exc}") from exc
        raise AssertionError("unreachable")

    def _ask_once(self, path: str, op: str, fields: dict, timeout: float) -> dict:
        ws = self._socket(path)
        rid = next(self._ids)
        ws.send(json.dumps({"id": rid, "op": op, **fields}, ensure_ascii=False))
        while True:
            reply = json.loads(ws.recv(timeout=timeout))
            # Replies to earlier, timed-out requests may still arrive; skip them.
            if reply.get("type") == "reply" and reply.get("re") == rid:
                return reply
