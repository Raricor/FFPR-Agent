"""Export skills/menu.py results for the TypeScript port's comparison tests."""

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

from ffpr_agent.skills import menu  # noqa: E402

PARTY_BEFORE = [
    {"name": "巴兹", "hp": 8, "maxHp": 197, "mp": 10},
    {"name": "蕾娜", "hp": 60, "maxHp": 142, "mp": 16},
]
PARTY_AFTER = [
    {"name": "巴兹", "hp": 50, "maxHp": 197, "mp": 10},
    {"name": "蕾娜", "hp": 60, "maxHp": 142, "mp": 12},
]

CAST_MENUS = [
    {"open": True, "commands": [{"id": "Items"}, {"id": "Magic"}], "cursor": 1},
    {"open": True, "commands": [{"id": "Items"}, {"id": "Magic"}], "cursor": 1},
    {
        "state": "Magic",
        "magic": {
            "character": "蕾娜",
            "commands": [{"name": "白魔法", "enabled": True}],
            "commandCursor": 0,
        },
    },
    {
        "state": "Magic",
        "magic": {
            "character": "蕾娜",
            "commands": [{"name": "白魔法", "enabled": True}],
            "commandCursor": 0,
        },
    },
    {
        "state": "Magic",
        "magic": {
            "character": "蕾娜",
            "state": "MagicList",
            "abilities": [{"name": "治疗", "id": 10, "mp": 4, "usable": True}],
            "contentIds": [10],
            "abilityCursor": 0,
        },
    },
    {
        "state": "Magic",
        "magic": {
            "character": "蕾娜",
            "state": "MagicList",
            "abilities": [{"name": "治疗", "id": 10, "mp": 4, "usable": True}],
            "contentIds": [10],
            "abilityCursor": 0,
        },
    },
    {
        "state": "Magic",
        "magic": {
            "character": "蕾娜",
            "state": "MagicList",
            "targets": [{"name": "巴兹"}, {"name": "蕾娜"}],
            "targetMode": "One",
            "targetCursor": 0,
        },
    },
    {
        "state": "Magic",
        "magic": {
            "character": "蕾娜",
            "state": "MagicList",
            "targets": [{"name": "巴兹"}, {"name": "蕾娜"}],
            "targetMode": "One",
            "targetCursor": 0,
        },
    },
]

EQUIP_MENUS = [
    {"open": True, "commands": [{"id": "Items"}, {"id": "Equipment"}], "cursor": 1},
    {"open": True, "commands": [{"id": "Items"}, {"id": "Equipment"}], "cursor": 1},
    {"state": "Equipment", "partyCursor": 0},
    {"state": "Equipment", "partyCursor": 0},
    {
        "equipment": {
            "state": "Command",
            "commandCursor": 1,
            "slots": [{"item": "皮帽"}, {"item": "皮衣"}],
        }
    },
    {
        "equipment": {
            "state": "Command",
            "commandCursor": 1,
            "slots": [{"item": "皮帽"}, {"item": "皮衣"}],
        }
    },
    {
        "equipment": {
            "state": "Command",
            "commandCursor": 1,
            "slots": [{"item": "铁盔"}, {"item": "皮衣"}],
        }
    },
    {"equipment": {"state": "Member", "slots": [{"item": "铁盔"}, {"item": "皮衣"}]}},
]


def cast_case():
    menus = list(CAST_MENUS)
    samples = [PARTY_BEFORE, PARTY_AFTER]

    def send(laptop, op, _wait=30, **fields):
        if op == "pos":
            return {"pos": {"state": "Player", "cell": [10, 5]}}
        if op == "keys":
            return {"ok": True}
        if op == "leave":
            return {"ok": True, "presses": 2}
        raise AssertionError(f"unexpected op {op}")

    def query(laptop, q, **fields):
        if q == "sample":
            return {"sample": {"party": samples.pop(0)}}
        if q == "menu":
            return {"menu": menus.pop(0)}
        raise AssertionError(f"unexpected query {q}")

    def run():
        return list(menu.cast(None, "蕾娜", "治疗", "巴兹"))

    return run, send, query


def cast_missing_target():
    def send(laptop, op, _wait=30, **fields):
        if op == "pos":
            return {"pos": {"state": "Player"}}
        raise AssertionError(f"unexpected op {op}")

    def query(laptop, q, **fields):
        if q == "sample":
            return {"sample": {"party": PARTY_BEFORE}}
        raise AssertionError(f"unexpected query {q}")

    def run():
        return list(menu.cast(None, "蕾娜", "治疗", "加拉夫"))

    return run, send, query


def equip_case():
    menus = list(EQUIP_MENUS)
    samples = [[{"name": "巴兹", "hp": 100, "maxHp": 100, "mp": 10}]]

    def send(laptop, op, _wait=30, **fields):
        if op == "pos":
            return {"pos": {"state": "Player"}}
        if op == "keys":
            return {"ok": True}
        if op == "leave":
            return {"ok": True, "presses": 1}
        raise AssertionError(f"unexpected op {op}")

    def query(laptop, q, **fields):
        if q == "sample":
            return {"sample": {"party": samples.pop(0)}}
        if q == "menu":
            return {"menu": menus.pop(0)}
        raise AssertionError(f"unexpected query {q}")

    def run():
        return list(menu.optimize_equipment(None))

    return run, send, query


def leave_case():
    def send(laptop, op, _wait=30, **fields):
        if op == "leave":
            return {"ok": True, "presses": 3}
        raise AssertionError(f"unexpected op {op}")

    return (lambda: menu.leave_menu(None)), send, lambda *a, **k: {}


def leave_failure():
    def send(laptop, op, _wait=30, **fields):
        if op == "leave":
            return {"ok": False, "error": "没有可以退出的菜单", "pos": {"state": "Menu"}}
        raise AssertionError(f"unexpected op {op}")

    return (lambda: menu.leave_menu(None)), send, lambda *a, **k: {}


def main():
    cases = []
    for name, build in [
        ("cast from the field menu", cast_case),
        ("caster has no such target", cast_missing_target),
        ("strongest equipment for one member", equip_case),
        ("leave the menu", leave_case),
        ("leave fails", leave_failure),
    ]:
        run, send, query = build()
        cases.append(skills.case(name, [menu], run, send, query))
    skills.save("menu", {"cases": cases})


if __name__ == "__main__":
    main()
