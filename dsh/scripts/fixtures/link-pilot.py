"""Export through_link mappings for src/engine/link-pilot.ts from the Python implementation."""

import json
import sys
from pathlib import Path

# scripts/fixtures/secrets.py would otherwise shadow the stdlib module httpx imports.
sys.path = [entry for entry in sys.path if Path(entry).resolve() != Path(__file__).parent]
from ffpr_agent import pilot  # noqa: E402 (after the sys.path fix above)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "test" / "fixtures" / "link-pilot.json"


class FakeLink:
    def __init__(self, reply):
        self.reply = reply
        self.calls = []

    def command(self, op, timeout=None, **fields):
        self.calls.append({"method": "command", "op": op, "timeout": timeout, "fields": fields})
        return self.reply

    def query(self, op, **fields):
        self.calls.append({"method": "query", "op": op, "fields": fields})
        return self.reply


cases = [
    {
        "name": "keys keeps ok, sent and error",
        "op": "keys",
        "fields": {"keys": ["Down*2", "Enter"], "gap": 80, "ignored": True},
        "wait": 12.5,
        "reply": {"ok": True, "sent": 5, "error": None, "extra": "drop me"},
    },
    {
        "name": "keys applies the default gap",
        "op": "keys",
        "fields": {"keys": ["Enter"]},
        "wait": 30,
        "reply": {"ok": True},
    },
    {
        "name": "status says the game is running and keeps the bridge fields",
        "op": "status",
        "fields": {},
        "wait": 10,
        "reply": {"ok": True, "focused": True, "locked": False, "foreground": "FFPR", "extra": 1},
    },
    {
        "name": "bridge wraps the reply from a pass-through query",
        "op": "bridge",
        "fields": {"q": "pos", "fresh": True},
        "wait": 30,
        "reply": {"ok": True, "map": 238},
    },
    {
        "name": "bridge turns a failed reply into bridge_error",
        "op": "bridge",
        "fields": {"q": "pos"},
        "wait": 30,
        "reply": {"ok": False},
    },
    {
        "name": "cells asks for the default radius",
        "op": "cells",
        "fields": {},
        "wait": 30,
        "reply": {"ok": True, "cells": [[1, 2]], "extra": 1},
    },
    {
        "name": "cells keeps the caller's radius",
        "op": "cells",
        "fields": {"r": 12},
        "wait": 30,
        "reply": {"ok": True, "cells": []},
    },
    {
        "name": "entities asks for the default limit",
        "op": "entities",
        "fields": {},
        "wait": 30,
        "reply": {"ok": True, "entities": [], "total": 0},
    },
    {
        "name": "entities keeps the caller's limit",
        "op": "entities",
        "fields": {"max": 5},
        "wait": 30,
        "reply": {"ok": True, "entities": [{"kind": "npc"}]},
    },
    {
        "name": "pos passes fields and reads pos",
        "op": "pos",
        "fields": {},
        "wait": 30,
        "reply": {"ok": True, "pos": {"map": 238, "state": "Field"}},
    },
    {
        "name": "pos turns a failed reply into bridge_error",
        "op": "pos",
        "fields": {},
        "wait": 30,
        "reply": {"ok": False, "error": "not ready"},
    },
    {
        "name": "route passes fields to the bridge query",
        "op": "route",
        "fields": {"from": [1, 2], "to": [3, 4]},
        "wait": 30,
        "reply": {"ok": True, "route": {"path": [[1, 2]]}},
    },
]

out = []
for case in cases:
    link = FakeLink(case["reply"])
    result = pilot.through_link(link, case["op"], case["fields"], case["wait"])
    out.append(
        {
            "name": case["name"],
            "op": case["op"],
            "fields": case["fields"],
            "wait": case["wait"],
            "reply": case["reply"],
            "calls": link.calls,
            "expected": result,
        }
    )

OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"wrote {OUT}")
