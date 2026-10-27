"""Export nav.py results for the TypeScript port's comparison tests."""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[2]
BASE = REPO.parent
sys.path.insert(0, str(BASE / "agent" / "src"))
sys.path.insert(0, str(BASE / "common" / "src"))

from ffpr_agent import nav  # noqa: E402

OUT = REPO / "test" / "fixtures" / "nav"


def save(name, data):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def indoor_grid(collision, blocked):
    grid = nav.indoor_grid(collision, set(map(tuple, blocked)))
    if grid is None:
        return None
    return {
        "origin": grid["origin"],
        "center": grid["center"],
        "attr": grid["attr"],
        "stairs": sorted(f"{x},{y}" for x, y in grid["stairs"]),
    }


def layered_grid(collision, blocked):
    grid = nav.layered_grid(collision, set(map(tuple, blocked)))
    if grid is None:
        return None
    return {
        "heights": [[z, rows] for z, rows in grid["heights"].items()],
        "center": grid["center"],
        "z": grid["z"],
        "blocked": sorted(f"{x},{y}" for x, y in grid["blocked"]),
    }


def cells_view(grid):
    out = {"origin": grid["origin"], "center": grid["center"], "attr": grid["attr"]}
    if grid.get("stairs"):
        out["stairs"] = sorted(f"{x},{y}" for x, y in grid["stairs"])
    return out


def path_list(path):
    return None if path is None else [list(cell) for cell in path]


def world_fixture():
    files = {
        "map1": BASE / ".deps" / "pilot" / "cells-map1.json",
        "map1-b": BASE / ".deps" / "pilot" / "cells-map1-b.json",
    }
    cells = {name: json.loads(path.read_text(encoding="utf-8")) for name, path in files.items()}
    find_cases = [
        {"cells": "map1", "goal": [138, 89], "byShip": True},
        {"cells": "map1", "goal": [152, 92], "byShip": True},
        {"cells": "map1", "goal": [171, 101], "byShip": True},
        {"cells": "map1", "goal": [161, 120], "byShip": False},
        {"cells": "map1-b", "goal": [128, 88], "byShip": False},
        {"cells": "map1-b", "goal": [129, 80], "byShip": False},
        {"cells": "map1-b", "goal": [148, 89], "byShip": False},
        {"cells": "map1-b", "goal": [148, 89], "byShip": True},
    ]
    for case in find_cases:
        grid = cells[case["cells"]]
        path = nav.find_path(grid, tuple(case["goal"]), case["byShip"])
        case["path"] = path_list(path)
        case["corners"] = None if path is None else path_list(nav.corners(path))

    toward_cases = [
        {"cells": "map1", "goal": [161, 120], "rule": "ship"},
        {"cells": "map1", "goal": [161, 120], "rule": "flying"},
        {"cells": "map1-b", "goal": [148, 89], "rule": "foot"},
        {"cells": "map1-b", "goal": [129, 88], "rule": "flying"},
        {"cells": "map1-b", "goal": [129, 88], "rule": "ship"},
    ]
    rules = {
        "ship": nav.terrain_rule(by_ship=True),
        "foot": nav.terrain_rule(by_ship=False),
        "flying": nav.terrain_rule(by_ship=False, flying=True),
    }
    for case in toward_cases:
        grid = cells[case["cells"]]
        path = nav.path_toward(grid, tuple(case["goal"]), rules[case["rule"]])
        case["path"] = path_list(path)
        case["corners"] = path_list(nav.corners(path))

    has_terrain = {name: nav.has_terrain(grid) for name, grid in cells.items()}
    return {
        "cells": cells,
        "findPath": find_cases,
        "pathToward": toward_cases,
        "hasTerrain": has_terrain,
    }


def handmade_indoor():
    shrine = {
        "playerCell": [2, 1],
        "searchLayer": 1,
        "layers": [{"rows": ["#####", "#...#", "#.#.#", "#...#"]}],
    }
    shrine["layers"][0]["rows"] = [
        row.replace("#", "1").replace(".", "0") for row in shrine["layers"][0]["rows"]
    ]
    carwen = {
        "playerCell": [0, 2],
        "layers": [
            {"name": "BottomCollision", "rows": ["111", "111", "000"]},
            {"name": "GroundCollision", "rows": ["110", "113", "111"]},
        ],
    }
    stairs = {"origin": [0, 0], "center": [0, 1], "attr": [[0, 0, 0], [0, 0, 0], [0, 0, 0]]}
    stairs["stairs"] = {(1, 1)}
    return shrine, carwen, stairs


def indoor_fixture():
    shrine, carwen, stairs = handmade_indoor()
    real = json.loads((BASE / ".deps" / "pilot" / "collision-202.json").read_text(encoding="utf-8"))

    def case(collision, blocked, goals, name):
        raw = nav.indoor_grid(collision, set(map(tuple, blocked)))
        grid = indoor_grid(collision, blocked)
        paths = []
        for goal in goals:
            paths.append(
                {
                    "goal": goal,
                    "path": path_list(nav.path_toward(raw, tuple(goal), nav.floor_rule)),
                }
            )
        return {
            "name": name,
            "collision": collision,
            "blocked": blocked,
            "grid": grid,
            "paths": paths,
        }

    open_cells = [
        (x, y)
        for y, row in enumerate(indoor_grid(real, [])["attr"])
        for x, v in enumerate(row)
        if v == 0
    ]
    real_goal = max(open_cells, key=lambda c: abs(c[0] - 18) + abs(c[1] - 20))
    grid = indoor_grid(shrine, [[1, 1]])
    return {
        "cases": [
            case(
                shrine,
                [[1, 1]],
                [[1, 3], [0, 3]],
                "Wind Shrine 1F with a chest at (1,1)",
            ),
            case(
                real,
                [],
                [[1, 1], [real_goal[0], real_goal[1]]],
                "Wind Shrine map 202 collision reply",
            ),
        ],
        "carwen": {
            "collision": carwen,
            "grid": indoor_grid(carwen, []),
            "path": path_list(
                nav.path_toward(nav.indoor_grid(carwen, set()), (2, 0), nav.floor_rule)
            ),
        },
        "stairs": {
            "grid": cells_view(stairs),
            "around": path_list(nav.path_toward(stairs, (2, 1), nav.floor_rule)),
            "up": path_list(nav.path_toward({**stairs, "center": [1, 2]}, (1, 0), nav.floor_rule)),
        },
        "cut": {
            "grid": {
                "origin": [0, 0],
                "center": [0, 1],
                "attr": [[1, 1, 1], [0, 0, 0], [0, 0, 1]],
            },
            "first": path_list(
                nav.path_toward(
                    {"origin": [0, 0], "center": [0, 1], "attr": [[1, 1, 1], [0, 0, 0], [0, 0, 1]]},
                    (2, 1),
                    nav.floor_rule,
                )
            ),
            "cut": [["1,1", "2,1"]],
        },
        "shrine_goal": [2, 1],
        "shrine_grid_center": grid["center"],
    }


def layered_fixture():
    _, carwen, _ = handmade_indoor()
    real = json.loads((BASE / ".deps" / "pilot" / "collision-202.json").read_text(encoding="utf-8"))

    def case(collision, blocked, goals, name, view=True):
        raw = nav.layered_grid(collision, set(map(tuple, blocked)))
        grid = layered_grid(collision, blocked)
        paths = [
            {
                "goal": goal,
                "path": path_list(nav.layered_path(raw, tuple(goal))),
            }
            for goal in goals
        ]
        return {
            "name": name,
            "collision": collision,
            "blocked": blocked,
            "grid": grid,
            "paths": paths,
            "view": nav.layered_view(raw) if view else None,
        }

    no_stairs = {
        "playerCell": [0, 2],
        "searchLayer": 0,
        "layers": [
            {"name": "BottomCollision", "rows": ["111", "111", "000"]},
            {"name": "GroundCollision", "rows": ["000", "011", "111"]},
        ],
    }
    real_open = indoor_grid(real, [])["attr"]
    open_cells = [(x, y) for y, row in enumerate(real_open) for x, v in enumerate(row) if v == 0]
    real_goal = max(open_cells, key=lambda c: abs(c[0] - 18) + abs(c[1] - 20))
    cut_grid = nav.layered_grid(carwen, set())
    return {
        "cases": [
            case(
                carwen,
                [],
                [[0, 0]],
                "Carwen street and terrace joined by stairs",
            ),
            case(
                real,
                [],
                [[real_goal[0], real_goal[1]]],
                "Wind Shrine map 202 layered",
            ),
            case(
                no_stairs,
                [],
                [[0, 0]],
                "no stairs, no way up",
            ),
        ],
        "cut": {
            "collision": carwen,
            "path": case(carwen, [], [[0, 0]], "with a cut", view=False)["paths"][0]["path"],
            "cut": [["1,2", "2,2"]],
            "withCut": path_list(
                nav.layered_path(
                    nav.layered_grid(carwen, set()), (0, 0), frozenset({((1, 2), (2, 2))})
                )
            ),
        },
        "gridKeys": sorted(cut_grid["heights"].keys()),
    }


def main():
    world = world_fixture()
    save("world.json", world)
    indoor = indoor_fixture()
    save("indoor.json", indoor)
    layered = layered_fixture()
    save("layered.json", layered)
    save(
        "cells.json",
        {
            "cases": [
                {
                    "cells": {
                        "origin": [9, 4],
                        "center": [10, 5],
                        "attr": [[0, 1, 0], [3, 7, None]],
                    },
                    "text": nav.render_cells(
                        {"origin": [9, 4], "center": [10, 5], "attr": [[0, 1, 0], [3, 7, None]]}
                    ),
                },
                {
                    "cells": {
                        "origin": [-2, -1],
                        "center": [0, 0],
                        "attr": [[16, None, 3], [4, 7, 19]],
                    },
                    "text": nav.render_cells(
                        {"origin": [-2, -1], "center": [0, 0], "attr": [[16, None, 3], [4, 7, 19]]}
                    ),
                },
            ],
            "hasTerrain": world["hasTerrain"],
        },
    )


if __name__ == "__main__":
    main()
