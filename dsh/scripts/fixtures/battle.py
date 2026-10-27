"""Export skills/battle.py results for the TypeScript port's comparison tests."""

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

from ffpr_agent.skills import battle  # noqa: E402

PARTY = [
    {"name": "巴兹", "hp": 8, "maxHp": 197, "mp": 19},
    {"name": "蕾娜", "hp": 60, "maxHp": 142, "mp": 16},
    {"name": "加拉夫", "hp": 0, "maxHp": 215, "mp": 19},
    {"name": "法利斯", "hp": 140, "maxHp": 140, "mp": 2},
]
CRAB = [{"name": "龙虾", "hp": 500, "maxHp": 650, "boss": 1}]
ITEMS = {"items": {"normal": [{"name": "<IC_DRAG>恢复药", "count": 3}]}}


def party(*hps):
    return [{"name": name, "hp": hp, "maxHp": 100} for name, hp in zip("ABCD", hps, strict=False)]


def judge_case():
    samples = [
        party(0, 0, 0, 0),
        party(50, 0, 90, 90),
        party(30, 30, 30, 30),
        party(90, 80, 70, 60),
    ]

    def query(laptop, q, **fields):
        assert q == "sample"
        return {"sample": {"party": samples.pop(0)}}

    def run():
        return [list(battle.judge(None)) for _ in range(4)]

    return run, query


def situation_case():
    def query(laptop, q, **fields):
        assert q == "items"
        return ITEMS

    def run():
        menu = {"players": PARTY, "enemies": CRAB}
        bag = {"恢复药": 3}
        ordered = {"恢复药": 2}
        limited = battle.situation_of(None, menu, "蕾娜", 1, bag, ordered)
        plain = battle.situation_of(None, menu, "蕾娜", 2)
        held = battle.held_items(None)
        return {
            "limited": {
                "actor": limited.actor,
                "turn": limited.turn,
                "boss": limited.boss,
                "items": limited.items,
            },
            "plain": {
                "actor": plain.actor,
                "turn": plain.turn,
                "boss": plain.boss,
                "items": plain.items,
            },
            "held": held,
        }

    return run, query


def fallback_case():
    sample = {"sample": {"battle": {"players": PARTY, "enemies": CRAB}}}

    def query(laptop, q, **fields):
        if q == "items":
            return ITEMS
        if q == "sample":
            return sample
        raise AssertionError(f"unexpected query {q}")

    def run():
        situation = battle.situation_of(None, {}, "蕾娜", 1)
        return {
            "players": situation.players,
            "enemies": situation.enemies,
            "boss": situation.boss,
        }

    return run, query


def main():
    cases = []
    run, query = judge_case()
    cases.append(
        skills.case(
            "judge reads the party after a battle", [battle], run, lambda *a, **k: {}, query
        )
    )
    run, query = situation_case()
    cases.append(
        skills.case(
            "items ordered this battle count as used", [battle], run, lambda *a, **k: {}, query
        )
    )
    run, query = fallback_case()
    cases.append(
        skills.case(
            "older bridges read both sides from the sample",
            [battle],
            run,
            lambda *a, **k: {},
            query,
        )
    )
    menus = [
        {
            "actor": "巴兹",
            "commands": [{"name": "攻击"}],
            "menuState": "CommandSelecting",
            "target": {"state": "None"},
        },
        {"actor": "巴兹", "commands": [{"name": "攻击"}], "target": {"state": "Enemys"}},
        {"actor": "巴兹", "commands": [{"name": "攻击"}], "menuState": "Animation"},
        {"actor": None, "commands": [], "menuState": "Animation"},
        {"actor": "巴兹", "commands": [{"name": "攻击"}], "abilityState": "MagicList"},
        {"actor": "巴兹", "commands": [{"name": "攻击"}], "itemState": "UseSelect"},
    ]
    skills.save(
        "battle",
        {
            "cases": cases,
            "menus": [
                {
                    "menu": menu,
                    "ready": battle.ready(menu),
                    "targetOpen": battle.target_open(menu),
                    "listOpen": battle.list_open(menu),
                }
                for menu in menus
            ],
        },
    )


if __name__ == "__main__":
    main()
