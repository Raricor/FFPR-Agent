"""Export skills/shop.py results for the TypeScript port's comparison tests."""

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

from ffpr_agent.skills import cursor, shop  # noqa: E402

ROWS = [
    {"name": "巴兹", "canEquip": True, "up": True},
    {"name": "加拉夫", "canEquip": True, "up": False, "equipped": True},
    {"name": "蕾娜", "canEquip": False},
    {"name": "法利斯", "canEquip": True, "up": True},
]
PRODUCTS = [{"name": "<IC_HEAD>铁盔", "buy": 350, "type": "Armor"}]


def who_can_case():
    rows = [
        {"name": "巴兹", "canEquip": True, "up": True},
        {"name": "加拉夫", "canEquip": True, "equipped": True},
        {"name": "蕾娜", "canEquip": False},
        {"name": "法利斯", "canEquip": True, "down": True},
        {"name": "可露儿", "canEquip": True},
    ]
    return shop.who_can(rows)


def buy_case(rows):
    state = {"open": True, "state": "SelectProduct", "listCursor": 0, "products": PRODUCTS}
    trade = {"count": 1}
    last_key = [None]
    counted = [False]
    gil = [5000, 4300] if any(row.get("up") for row in rows) else [5000]

    def send(laptop, op, _wait=30, **fields):
        if op == "keys":
            last_key[0] = fields["keys"][0]
            counted[0] = False
            return {"ok": True}
        raise AssertionError(f"unexpected op {op}")

    def query(laptop, q, **fields):
        if q == "sample":
            return {"sample": {"user": {"gil": gil.pop(0)}}}
        if q == "shop":
            if last_key[0] == "Right" and not counted[0]:
                trade["count"] += 1
                counted[0] = True
            return {"shop": dict(state, party=rows, trade=dict(trade))}
        raise AssertionError(f"unexpected query {q}")

    def run():
        return list(shop.buy(None, "铁盔", 4))

    return run, send, query


def rows_state(bag, view):
    rows = [
        {"name": f"<IC_X>{name}", "focus": view["top"] + i == view["focus"]}
        for i, name in enumerate(bag[view["top"] : view["top"] + 4])
    ]
    return {"shop": {"rows": rows}}


def find_row_case(bag, item):
    view = {"top": 0, "focus": 0}

    def query(laptop, q, **fields):
        assert q == "shop"
        return rows_state(bag, view)

    def send(laptop, op, _wait=30, **fields):
        assert op == "keys"
        step = {"Down": 1, "Up": -1}[fields["keys"][0]]
        view["focus"] = max(0, min(len(bag) - 1, view["focus"] + step))
        view["top"] = min(max(view["top"], view["focus"] - 3), view["focus"])
        return {}

    def run():
        return shop.find_row(None, item)

    return run, send, query


def main():
    bag = ["恢复药", "帐篷", "皮帽", "皮衣", "宽刃剑", "铁盔", "青铜铠", "不死鸟之尾"]
    cases = []
    for name, rows in [
        ("buy only for members it helps", ROWS),
        (
            "nobody can use the gear",
            [
                {"name": "巴兹", "canEquip": True, "up": False},
                {"name": "加拉夫", "canEquip": True, "equipped": True},
                {"name": "蕾娜", "canEquip": False},
                {"name": "法利斯", "canEquip": True, "up": False},
            ],
        ),
    ]:
        run, send, query = buy_case(rows)
        cases.append(skills.case(name, [shop, cursor], run, send, query))
    for name, item in [
        ("scroll down to a late item", "青铜铠"),
        ("scroll back up for an early item", "帐篷"),
        ("item not in the bag", "没有的东西"),
    ]:
        run, send, query = find_row_case(list(bag), item)
        cases.append(skills.case(name, [shop], run, send, query))
    skills.save("shop", {"whoCan": who_can_case(), "cases": cases})


if __name__ == "__main__":
    main()
