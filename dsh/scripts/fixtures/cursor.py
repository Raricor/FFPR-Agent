"""Export skills/cursor.py results for the TypeScript port's comparison tests."""

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
save = skills.save
skills.hide_fixtures_dir()

from ffpr_agent.skills import cursor  # noqa: E402


class FakeMenu:
    """A menu cursor over `count` entries laid out in rows of `columns`."""

    def __init__(self, count, columns=1, keys=("Up", "Down", "Left", "Right")):
        self.at, self.count, self.columns, self.keys = 0, count, columns, keys
        self.pressed = []

    def press(self, key):
        self.pressed.append(key)
        if key not in self.keys:
            return
        step = {"Down": self.columns, "Up": -self.columns, "Right": 1, "Left": -1}[key]
        self.at = (self.at + step) % self.count


def steer_case(name, menu, target):
    ok = cursor.steer(lambda: menu.at, menu.press, target)
    return {
        "name": name,
        "count": menu.count,
        "columns": menu.columns,
        "keys": list(menu.keys),
        "target": target,
        "out": ok,
        "pressed": menu.pressed,
        "at": menu.at,
    }


def main():
    names = ["攻击", "黑魔法", "道具", None]
    pick_cases = [
        {"names": names, "wanted": "攻击", "out": cursor.pick(names, "攻击")},
        {"names": names, "wanted": "魔法", "out": cursor.pick(names, "魔法")},
        {"names": ["火", "冰", "雷"], "wanted": "雷", "out": cursor.pick(["火", "冰", "雷"], "雷")},
        {"names": names, "wanted": "召唤", "out": cursor.pick(names, "召唤")},
    ]
    steer_cases = [
        steer_case("list", FakeMenu(8, keys=("Up", "Down")), 5),
        steer_case("row", FakeMenu(5, keys=("Left", "Right")), 3),
        steer_case("grid", FakeMenu(12, columns=2), 5),
        steer_case("stuck", FakeMenu(4, keys=()), 2),
    ]
    none_menu = FakeMenu(4, keys=())
    steer_cases.append(
        {
            "name": "unreadable",
            "count": none_menu.count,
            "columns": none_menu.columns,
            "keys": list(none_menu.keys),
            "target": 2,
            "out": cursor.steer(lambda: None, none_menu.press, 2),
            "pressed": none_menu.pressed,
            "at": none_menu.at,
        }
    )
    save("cursor", {"pick": pick_cases, "steer": steer_cases})


if __name__ == "__main__":
    main()
