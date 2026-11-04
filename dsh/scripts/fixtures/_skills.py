"""Shared harness for the skills fixture exporters: scripted send/query replies, every call
recorded, and a fake clock so the wait loops finish without sleeping."""

import json
import sys
import time
from contextlib import contextmanager
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[2]
OUT = REPO / "test" / "fixtures"


def hide_fixtures_dir():
    """Drop this directory from sys.path: its secrets.py shadows the stdlib one, which
    websockets imports, and importing the Python skills pulls websockets in."""
    here = Path(__file__).resolve().parent
    sys.path[:] = [entry for entry in sys.path if Path(entry or ".").resolve() != here]


class Recorder:
    def __init__(self, send_reply, query_reply):
        self.send_reply = send_reply
        self.query_reply = query_reply
        self.calls = []
        self.transcript = []
        self.clock = 0.0

    def send(self, laptop, op, _wait=30, **fields):
        reply = self.send_reply(laptop, op, _wait=_wait, **fields)
        self.calls.append({"kind": "send", "op": op, "fields": fields, "wait": _wait})
        self.transcript.append({"kind": "send", "op": op, "reply": reply})
        return reply

    def query(self, laptop, q, **fields):
        reply = self.query_reply(laptop, q, **fields)
        self.calls.append({"kind": "query", "q": q, "fields": fields})
        self.transcript.append({"kind": "query", "q": q, "reply": reply})
        return reply

    def advance(self, seconds):
        self.clock += seconds * 1000

    def monotonic(self):
        return self.clock


@contextmanager
def fake_time(recorder):
    real_sleep, real_monotonic = time.sleep, time.monotonic
    time.sleep = recorder.advance
    time.monotonic = recorder.monotonic
    try:
        yield
    finally:
        time.sleep, time.monotonic = real_sleep, real_monotonic


@contextmanager
def patched(recorder, *modules):
    saved = []
    seen = set()
    for module in modules:
        if id(module) in seen:
            continue
        seen.add(id(module))
        for name in ("send", "query"):
            if hasattr(module, name):
                saved.append((module, name, getattr(module, name)))
                setattr(module, name, getattr(recorder, name))
    try:
        yield
    finally:
        for module, name, original in saved:
            setattr(module, name, original)


def case(name, modules, fn, send_reply, query_reply):
    recorder = Recorder(send_reply, query_reply)
    with patched(recorder, *modules), fake_time(recorder):
        out = fn()
    return {
        "name": name,
        "out": out,
        "calls": recorder.calls,
        "transcript": recorder.transcript,
    }


def save(module, data):
    directory = OUT / module
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{module}.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8"
    )
