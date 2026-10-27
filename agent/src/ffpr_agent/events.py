"""Key events, live: the bridge's stream on the LAN link fed through the key-log Builder, kept
in windows the planning layers read (control plan §4.8).

    events = KeyEvents()
    events.seed(probe_file)                 # what happened before we started listening
    Watcher(link, events).start()           # then follow the stream on a background thread
    events.window(1)                        # strategy: the long window
    events.window(2)                        # tactics: the last minutes
    events.news()                           # entries new or grown since the last call

The watcher also keeps the newest sample and the last raw events, so the player can describe
the game without reading the probe file over SSH.
"""

import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from ffpr_agent.bridge import BridgeLink
from ffpr_agent.logs.key_log import LABEL, SHANGHAI, Builder, load


@dataclass(frozen=True)
class Window:
    types: frozenset[str]
    minutes: int
    limit: int
    story_chars: int  # how much of a scene's lines to show


WINDOWS = {
    # Strategy: where the story stands, who is in the party, what is done; hours back.
    1: Window(
        frozenset(
            {"run", "place", "party", "story", "bossfight", "boss", "defeat"}
            | {"item", "chest", "level", "save", "buy", "equip"}
        ),
        minutes=240,
        limit=30,
        story_chars=600,
    ),
    # Tactics: what just happened around the current sub-goal.
    2: Window(
        frozenset(
            {"place", "party", "story", "bossfight", "boss", "defeat"}
            | {"item", "chest", "level", "buy", "equip"}
        ),
        minutes=15,
        limit=12,
        story_chars=160,
    ),
}


def describe(entries: list[dict], story_chars: int = 160) -> str:
    """One line per entry, a story scene with as many of its lines as fit."""
    out = []
    for e in entries:
        text = e["text"]
        if e["type"] == "story":
            lines = (e.get("data") or {}).get("lines") or []
            text = shorten(lines, story_chars) or text
        progress = e.get("progress")
        tail = f"({progress})" if progress and progress not in ("—", "") else ""
        out.append(f"{e['ts'][11:16]} {LABEL.get(e['type'], e['type'])} {text}{tail}")
    return "\n".join(out)


def shorten(lines: list[str], chars: int) -> str:
    """A scene's first and last lines within `chars`: the start says where it is, the end
    usually says what to do next."""
    if sum(len(x) for x in lines) <= chars:
        return " / ".join(lines)
    head: list[str] = []
    tail: list[str] = []
    used, i, j = 0, 0, len(lines) - 1
    while i <= j:
        front = len(head) <= len(tail)
        line = lines[i] if front else lines[j]
        if used + len(line) > chars:
            break
        used += len(line)
        if front:
            head.append(line)
            i += 1
        else:
            tail.insert(0, line)
            j -= 1
    if not head:
        head = [lines[0][:chars]]
    return " / ".join([*head, "……", *tail])


def version(text: str | None) -> tuple[int, ...]:
    try:
        return tuple(int(x) for x in (text or "0").split("."))
    except ValueError:
        return (0,)


class KeyEvents:
    """Key entries across game runs, fed record by record (from probe files, then live)."""

    def __init__(self, now: Callable[[], datetime] = lambda: datetime.now(SHANGHAI)):
        self.now = now
        self.entries: list[dict] = []
        self.sample: dict | None = None
        self.sample_at = 0.0  # time.monotonic() of the newest sample
        self.recent: deque[dict] = deque(maxlen=50)  # raw records other than samples
        self._builder: Builder | None = None
        self._hello: str | None = None
        self._seq = 0
        self._told: dict[int, str] = {}  # id(entry) → the text news() last reported
        self.enemies: dict[int | None, set[str]] = {}  # map id → monsters met there
        self.books: dict[str, int] = {}  # monster name → bestiary number (the guides' key)
        self._numbers_shown = False  # this run's bridge sends the numbers the bestiary shows
        self._lock = threading.Lock()

    def seed(self, path: Path) -> None:
        for record in load(path):
            self.feed(record, live=False)

    def feed(self, record: dict, live: bool = True) -> None:
        with self._lock:
            if record.get("type") == "hello":
                # The stream resends the game's hello to every new connection: only a
                # different one (by its time) means the game started again.
                if record.get("t") == self._hello:
                    return
                self._hello = record.get("t")
                self._numbers_shown = version(record.get("plugin")) >= (0, 7, 2)
                previous, self._builder = self._builder, Builder(run=record.get("t", "")[:19])
                if previous is not None:  # a first visit is first across game starts too
                    self._builder.places = previous.places
                self._seq = 0
            seq = record.get("seq") or 0
            if self._builder is None or seq <= self._seq:
                return  # before the first hello, or already fed (seeded, then streamed)
            self._seq = seq
            if record.get("type") == "sample":
                self.sample = record
                self.sample_at = time.monotonic() if live else 0.0
                fight = record.get("battle") or {}
                if fight.get("active"):  # the monsters each map has shown (§4.10)
                    seen = self.enemies.setdefault((record.get("user") or {}).get("mapId"), set())
                    seen.update(e["name"] for e in fight.get("enemies") or [] if e.get("name"))
                    for e in fight.get("enemies") or []:
                        # Bridges before 0.7.2 sent the bestiary's entry id, not the number
                        # it shows (10-21): seeded probe files from them must not count.
                        if e.get("name") and e.get("book") and self._numbers_shown:
                            self.books[e["name"]] = e["book"]
            elif live:
                self.recent.append(record)
            before = len(self._builder.entries)
            self._builder.feed(record)
            self.entries += self._builder.entries[before:]

    def live_sample(self, max_age: float = 3.0) -> dict | None:
        """The newest streamed sample if it is fresh (the stream is up), else None."""
        with self._lock:
            fresh = self.sample_at and time.monotonic() - self.sample_at <= max_age
            return self.sample if fresh else None

    def note(self, kind: str, text: str) -> None:
        """A key entry the stream cannot show (a purchase, a change of equipment), told by the
        player's own tools, so the windows remember it after the conversation is trimmed
        (10-20: spells bought, forgotten, bought again)."""
        with self._lock:
            self.entries.append(
                {
                    "ts": self.now().isoformat(timespec="seconds"),
                    "run": "",
                    "key": True,
                    "type": kind,
                    "text": text,
                    "progress": "—",
                }
            )

    def take_recent(self, skip: frozenset[str] = frozenset({"pos.change"})) -> list[dict]:
        """Raw records streamed since the previous call (one reader: the player's view);
        position updates are left out, the view shows the position anyway."""
        with self._lock:
            taken = [r for r in self.recent if r.get("type") not in skip]
            self.recent.clear()
            return taken

    def last_save_minutes(self) -> float | None:
        """Minutes since the newest save entry, or None when there is none in view."""
        with self._lock:
            saves = [e for e in self.entries if e["type"] == "save"]
        if not saves:
            return None
        return (self.now() - datetime.fromisoformat(saves[-1]["ts"])).total_seconds() / 60

    def window(self, layer: int) -> str:
        """The layer's window of key events. Whoever reads it is up to date: news() starts
        from here."""
        spec = WINDOWS[layer]
        since = self.now() - timedelta(minutes=spec.minutes)
        with self._lock:
            picked = [
                e
                for e in self.entries
                if e["type"] in spec.types and datetime.fromisoformat(e["ts"]) >= since
            ][-spec.limit :]
            self._mark_told()
            return describe(picked, spec.story_chars)

    def news(self, layer: int = 2) -> str:
        """Entries added, or grown (a scene's lines, merged level-ups), since the last call."""
        spec = WINDOWS[layer]
        with self._lock:
            fresh = [
                e
                for e in self.entries
                if e["type"] in spec.types and self._told.get(id(e)) != e["text"]
            ]
            self._mark_told()
            return describe(fresh, spec.story_chars)

    def _mark_told(self) -> None:
        for e in self.entries:
            self._told[id(e)] = e["text"]


class Watcher:
    """Follows the bridge's stream on a daemon thread, reconnecting when the link drops."""

    def __init__(self, link: BridgeLink, events: KeyEvents, retry: float = 5.0):
        self.link = link
        self.events = events
        self.retry = retry
        self.error: str | None = None
        self._thread = threading.Thread(target=self._run, name="ffpr-watch", daemon=True)

    def start(self) -> "Watcher":
        self._thread.start()
        return self

    def _run(self) -> None:
        while True:
            try:
                for record in self.link.stream():
                    self.events.feed(record)
                    self.error = None
            except Exception as exc:  # a closed socket, a game restart: follow it again
                self.error = str(exc)
            time.sleep(self.retry)
