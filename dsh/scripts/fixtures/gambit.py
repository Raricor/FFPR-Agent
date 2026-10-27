"""Export skills/gambit.py results for the TypeScript port's comparison tests."""

import dataclasses
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[2]
BASE = REPO.parent
sys.path.insert(0, str(BASE / "agent" / "src"))
sys.path.insert(0, str(BASE / "common" / "src"))

from ffpr_agent.skills import gambit  # noqa: E402

OUT = REPO / "test" / "fixtures" / "gambit"

PARTY = [
    {"name": "巴兹", "hp": 8, "maxHp": 197, "mp": 19, "jobName": "骑士"},
    {"name": "蕾娜", "hp": 60, "maxHp": 142, "mp": 16, "jobName": "白魔法师"},
    {"name": "加拉夫", "hp": 0, "maxHp": 215, "mp": 19, "jobName": "武僧"},
    {"name": "法利斯", "hp": 140, "maxHp": 140, "mp": 2, "jobName": "黑魔法师"},
]
CRAB = [{"name": "龙虾", "hp": 500, "maxHp": 650, "boss": 1}]


def situation(actor="蕾娜", turn=1, players=None, enemies=None, boss=True, items=None):
    return gambit.Situation(
        actor,
        players if players is not None else PARTY,
        enemies if enemies is not None else CRAB,
        turn,
        boss,
        items or {},
    )


def sit_data(actor="蕾娜", turn=1, players=None, enemies=None, boss=True, items=None):
    return {
        "actor": actor,
        "players": players if players is not None else PARTY,
        "enemies": enemies if enemies is not None else CRAB,
        "turn": turn,
        "boss": boss,
        "items": items or {},
    }


def make_situation(data):
    return gambit.Situation(
        data["actor"],
        data["players"],
        data["enemies"],
        data.get("turn", 1),
        data.get("boss", False),
        data.get("items", {}),
    )


def action_data(action):
    return dataclasses.asdict(action)


def save(name, data):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def main():
    rules = [
        {"if": "ally.dead >= 1", "do": "白魔法:复活", "target": "倒下的同伴"},
        {"if": "ally.hp_pct < 50", "do": "白魔法:治疗", "target": "hp 最低的同伴"},
        {"do": "攻击"},
    ]
    healthy = [dict(member, hp=member["maxHp"]) for member in PARTY]
    blind_players = [dict(member, hp=member["maxHp"]) for member in PARTY]
    blind_players[1]["status"] = ["Blind"]
    values_data = [
        "self.hp",
        "self.hp_pct",
        "self.mp",
        "ally.hp_pct",
        "ally.dead",
        "party.alive",
        "enemy.count",
        "enemy.boss",
        "enemy.hp_pct",
        "turn",
    ]

    situations = [
        sit_data("蕾娜"),
        sit_data("蕾娜", players=healthy),
        sit_data("法利斯", turn=4),
        sit_data(
            "蕾娜",
            players=PARTY,
            items={"不死鸟之尾": 1, "恢复药": 3},
        ),
    ]

    choose_cases = [
        {"rules": rules, "situation": sit_data("蕾娜"), "skip": []},
        {"rules": rules, "situation": sit_data("蕾娜"), "skip": [1]},
        {"rules": rules, "situation": sit_data("蕾娜", players=healthy), "skip": []},
        {
            "rules": [{"if": "turn > 3", "do": "黑魔法:闪雷"}],
            "situation": sit_data("法利斯"),
            "skip": [],
        },
        {
            "rules": gambit.default_table(PARTY)["蕾娜"],
            "situation": sit_data(
                "蕾娜",
                players=PARTY,
                items={"不死鸟之尾": 1, "恢复药": 3},
            ),
            "skip": [1],
        },
        {
            "rules": gambit.default_table(PARTY)["巴兹"],
            "situation": sit_data(
                "巴兹",
                players=blind_players,
                items={"眼药水": 2},
            ),
            "skip": [],
        },
        {
            "rules": gambit.default_table(PARTY)["巴兹"],
            "situation": sit_data(
                "巴兹",
                players=blind_players,
            ),
            "skip": [],
        },
    ]
    for case in choose_cases:
        case["action"] = action_data(
            gambit.choose(case["rules"], make_situation(case["situation"]), set(case["skip"]))
        )

    status_players = [dict(member) for member in PARTY]
    status_players[3]["status"] = ["麻痹"]
    poison_players = [dict(member) for member in PARTY]
    poison_players[0]["status"] = ["毒"]

    holds_cases = [
        {"condition": "ally.hp_pct < 50 and self.mp >= 4", "situation": sit_data("蕾娜")},
        {"condition": "ally.dead == 0", "situation": sit_data("蕾娜")},
        {"condition": "enemy.boss", "situation": sit_data("蕾娜")},
        {"condition": None, "situation": sit_data("蕾娜")},
        {
            "condition": "ally.status.麻痹 >= 1",
            "situation": sit_data("法利斯", players=status_players),
        },
        {"condition": "self.status.麻痹", "situation": sit_data("法利斯", players=status_players)},
        {"condition": "ally.status.石化", "situation": sit_data("法利斯", players=status_players)},
        {
            "condition": "ally.dead >= 1 and item.不死鸟之尾 > 0",
            "situation": sit_data("蕾娜", items={"不死鸟之尾": 1, "恢复药": 3}),
        },
        {
            "condition": "item.以太 > 0",
            "situation": sit_data("蕾娜", items={"不死鸟之尾": 1, "恢复药": 3}),
        },
    ]
    for case in holds_cases:
        case["out"] = gambit.holds(case["condition"], make_situation(case["situation"]))

    tables = [
        {"蕾娜": [{"if": "ally.hp_pct < 50", "do": "白魔法:治疗"}, {"do": "攻击"}]},
        {
            "蕾娜": [{"if": "ally.hp < 50", "do": "白魔法:治疗"}],
            "法利斯": [{"do": "黑魔法:闪雷", "target": "最强的敌人"}],
            "巴兹": "攻击",
        },
        gambit.default_table(PARTY),
        {"battle": {"巴兹": [{"do": "攻击"}]}},
        {},
        "not a table",
    ]

    parser_cases = [
        {"condition": "ally.hp_pct < 50"},
        {"condition": " ally.dead >= 1 AND self.mp >= 4 "},
        {"condition": "ally.dead >= 1 且 self.mp >= 4"},
        {"condition": "enemy.boss"},
        {"condition": "ally.hp_pct <= 33.5"},
        {"condition": "ally.hp"},
        {"condition": "ally.status.毒 >= 1"},
        {"condition": "self.status.黑暗"},
        {"condition": "item.恢复药 > 0"},
        {"condition": "ally..hp < 1"},
        {"condition": "ally.hp < "},
        {"condition": "ally.hp > abc"},
        {"condition": "ally.hp < 50 or self.mp > 1"},
    ]
    for case in parser_cases:
        try:
            case["clauses"] = [list(clause) for clause in gambit.parse(case["condition"])]
        except Exception as error:
            case["error"] = f"{type(error).__name__}: {error}"

    save(
        "gambit.json",
        {
            "vocabulary": [list(item) for item in gambit.VOCABULARY.items()],
            "targets": list(gambit.TARGETS.items()),
            "statusZh": list(gambit.STATUS_ZH.items()),
            "values": [
                {
                    "situation": data,
                    "values": {name: make_situation(data).value(name) for name in values_data},
                }
                for data in situations
            ],
            "statuses": [
                {
                    "unit": {"status": ["Poison", "", "Mineralization"]},
                    "out": gambit.statuses({"status": ["Poison", "", "Mineralization"]}),
                },
                {
                    "unit": {"status": ["Blind", "Silence"]},
                    "out": gambit.statuses({"status": ["Blind", "Silence"]}),
                },
                {"unit": {}, "out": gambit.statuses({})},
            ],
            "holds": holds_cases,
            "choose": choose_cases,
            "check": [{"table": table, "problems": gambit.check(table)} for table in tables],
            "normalize": [
                {"plan": {"巴兹": "攻击"}, "out": gambit.normalize({"巴兹": "攻击"})},
                {
                    "plan": {"battle": {"巴兹": [{"do": "攻击"}]}},
                    "out": gambit.normalize({"battle": {"巴兹": [{"do": "攻击"}]}}),
                },
                {
                    "plan": {"蕾娜": [{"do": "攻击"}], "法利斯": "防御"},
                    "out": gambit.normalize({"蕾娜": [{"do": "攻击"}], "法利斯": "防御"}),
                },
            ],
            "defaultTable": [
                {"party": PARTY, "out": gambit.default_table(PARTY)},
                {"party": [], "out": gambit.default_table([])},
            ],
            "abilityCandidates": [
                {"wanted": wanted, "out": gambit.ability_candidates(wanted)}
                for wanted in ("治疗+", "冰冻+", "最强", "解毒", "火炎+", "复活")
            ],
            "cures": {ailment: list(value) for ailment, value in gambit.CURES.items()},
            "families": {name: list(value) for name, value in gambit.FAMILIES.items()},
            "parse": parser_cases,
            "situations": situations,
            "rules": rules,
        },
    )


if __name__ == "__main__":
    main()
