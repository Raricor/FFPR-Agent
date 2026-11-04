"""Export skills/save.py results for the TypeScript port's comparison tests."""

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[2]
BASE = REPO.parent
sys.path.insert(0, str(BASE / "agent" / "src"))
sys.path.insert(0, str(BASE / "common" / "src"))

spec = importlib.util.spec_from_file_location("_skills", HERE.parent / "_skills.py")
assert spec is not None and spec.loader is not None
skills = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skills)
skills.hide_fixtures_dir()

from ffpr_agent.skills import menu, save  # noqa: E402

SLOTS = [21, 22, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
COMMANDS = [{"id": "Items"}, {"id": "Save", "enabled": True}]


def highlighted_case():
    ui = {"open": True, "current": None, "cursor": 12, "slots": SLOTS}
    return [
        save.highlighted_slot(ui),
        save.highlighted_slot({"cursor": None, "current": 3, "slots": []}),
    ]


def move_to_slot_case():
    replies = [
        {"saveui": {"open": True, "cursor": 0, "slots": SLOTS}},
        {"saveui": {"open": True, "cursor": 4, "slots": SLOTS}},
    ]

    def query(laptop, q, **fields):
        assert q == "saveui"
        return replies.pop(0)

    def send(laptop, op, _wait=30, **fields):
        assert op == "keys" and fields["keys"] == ["Down*4"], fields
        return {"ok": True}

    def run():
        ui = {"open": True, "cursor": 0, "slots": SLOTS}
        out = save.move_to_slot(None, ui, 3)
        return {"ui": out}

    return run, send, query


def save_game_case():
    positions = [
        {"pos": {"state": "Player", "saves": 2}},
        {"pos": {"state": "Player", "saves": 3}},
    ]
    menus = [
        {"open": True, "commands": COMMANDS, "cursor": 1},
        {"open": True, "commands": COMMANDS, "cursor": 1},
    ]
    uis = [
        {"saveui": {"open": True, "cursor": 0, "slots": SLOTS}},
        {"saveui": {"open": True, "cursor": 0, "slots": SLOTS}},
        {"saveui": {"open": True, "cursor": 4, "slots": SLOTS}},
    ]

    def send(laptop, op, _wait=30, **fields):
        if op == "pos":
            return positions.pop(0)
        if op == "keys":
            return {"ok": True}
        if op == "leave":
            return {"ok": True, "presses": 1}
        raise AssertionError(f"unexpected op {op}")

    def query(laptop, q, **fields):
        if q == "menu":
            return {"menu": menus.pop(0)}
        if q == "saveui":
            return uis.pop(0)
        raise AssertionError(f"unexpected query {q}")

    def run():
        return list(save.save_game(None, 3))

    return run, send, query


def load_game_case():
    uis = [
        {"saveui": {"open": True, "cursor": 0, "slots": SLOTS}},
        {"saveui": {"open": True, "cursor": 4, "slots": SLOTS}},
    ]

    def send(laptop, op, _wait=30, **fields):
        if op == "keys":
            return {"ok": True}
        if op == "wait":
            return {"ok": True, "pos": {"map": 1, "cell": [20, 10]}}
        raise AssertionError(f"unexpected op {op}")

    def query(laptop, q, **fields):
        if q == "saveui":
            return uis.pop(0)
        raise AssertionError(f"unexpected query {q}")

    def run():
        return list(save.load_game(None, 3))

    return run, send, query


def main():
    cases = []
    for name, build in [
        ("move to slot by display order", move_to_slot_case),
        ("save to an empty slot", save_game_case),
        ("load from the title screen", load_game_case),
    ]:
        run, send, query = build()
        cases.append(skills.case(name, [save, menu], run, send, query))
    skills.save("save", {"highlighted": highlighted_case(), "cases": cases})


if __name__ == "__main__":
    main()
