"""Export skills/move.py results for the TypeScript port's comparison tests."""

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

from ffpr_agent.skills import move  # noqa: E402


def route_case():
    route = {
        "from": [16, 23],
        "cells": [
            [16, -128, 249],
            [16, -144, 249],
            [16, -160, 249],
            [0, -160, 249],
            [0, -144, 249],
            [0, -128, 249],
            [-16, -128, 249],
            [-32, -128, 249],
        ],
    }
    return {
        "points": [list(cell) for cell in move.route_cells(route)],
        "empty": [list(cell) for cell in move.route_cells({"from": [1, 1], "cells": []})],
    }


def landing_case():
    attr = [
        [4, 19, 7, 10],
        [19, 19, 7, 7],
        [4, 4, 7, 6],
    ]
    cells = {"origin": [0, 0], "center": [3, 0], "attr": attr}
    return {
        "near": [list(cell) for cell in move.landing_spots(cells, (3, 0))],
        "anywhere": [list(cell) for cell in move.landing_spots(cells, None)],
    }


def plan_case():
    cells = {
        "origin": [0, 0],
        "center": [1, 1],
        "attr": [
            [19, 19, 19, 19, 19],
            [19, 16, 16, 16, 19],
            [19, 19, 19, 16, 19],
            [3, 3, 3, 16, 3],
        ],
    }

    def send(laptop, op, _wait=30, **fields):
        assert op == "cells"
        return {"cells": cells}

    def query(laptop, q, **fields):
        assert q == "sample"
        return {"sample": {"field": {"moveState": None}}}

    def run():
        here, path = move.plan(None, (3, 3), True)
        return {"here": list(here), "path": [list(cell) for cell in path]}

    return run, send, query


def land_here_case():
    move.drake = None
    samples = ["LowFlying", "Ground", "Ground"]

    def send(laptop, op, _wait=30, **fields):
        if op == "keys":
            return {"ok": True}
        if op == "pos":
            return {"pos": {"cell": [5, 6]}}
        raise AssertionError(f"unexpected op {op}")

    def query(laptop, q, **fields):
        assert q == "sample"
        return {"sample": {"field": {"moveState": samples.pop(0)}}}

    def run():
        ok = move.land_here(None)
        return {"ok": ok, "drake": list(move.drake) if move.drake else None}

    return run, send, query


def grid(center):
    origin = [center[0] - 2, center[1] - 2]
    return {
        "origin": origin,
        "center": list(center),
        "attr": [[16, 16, 16, 16, 16] for _ in range(5)],
    }


def navigate_case():
    current = [[0, 0]]
    said = []

    def send(laptop, op, _wait=30, **fields):
        if op == "pos":
            return {"pos": {"map": 1, "cell": list(current[0])}}
        if op == "cells":
            return {"cells": grid(current[0])}
        if op == "walk":
            current[0] = list(fields["to"])
            return {"ok": True, "pos": {"map": 1, "cell": list(current[0])}}
        raise AssertionError(f"unexpected op {op}")

    def query(laptop, q, **fields):
        assert q == "sample"
        return {"sample": {"field": {"moveState": None}}}

    def run():
        out = move.navigate(None, (10, 0), True, say=said.append)
        return {"out": list(out), "said": said}

    return run, send, query


def blocked_case():
    cells = {"origin": [17, 18], "center": [17, 19], "attr": [[16], [16], [16]]}
    said = []

    def send(laptop, op, _wait=30, **fields):
        if op == "pos":
            return {"pos": {"map": 210, "cell": [17, 19]}}
        if op == "cells":
            return {"cells": cells}
        if op == "walk":
            return {"ok": False, "error": "blocked", "pos": {"cell": [17, 19]}}
        raise AssertionError(f"unexpected op {op}")

    def query(laptop, q, **fields):
        assert q == "sample"
        return {"sample": {"field": {"moveState": None}}}

    def run():
        out = move.navigate(None, (17, 17), True, say=said.append)
        return {"out": list(out), "said": said}

    return run, send, query


def occupied_case():
    def send(laptop, op, _wait=30, **fields):
        assert op == "entities"
        kind = fields["kind"]
        if kind in ("TresureBox", "Npc"):
            return {"entities": {"entities": [{"cell": [1, 2], "active": True}]}}
        if kind == "GotoMap":
            return {"entities": {"entities": [{"cell": [3, 4]}]}}
        return {"entities": {"entities": [{"cell": [5, 6], "active": False}]}}

    def run():
        return [list(cell) for cell in sorted(move.occupied_cells(None))]

    return run, send, lambda *a, **k: {}


def main():
    cases = []
    run, send, query = plan_case()
    cases.append(skills.case("plan over terrain", [move], run, send, query))
    run, send, query = land_here_case()
    cases.append(skills.case("the drake lands", [move], run, send, query))
    run, send, query = navigate_case()
    cases.append(skills.case("navigate goes on past the planning window", [move], run, send, query))
    run, send, query = blocked_case()
    cases.append(skills.case("a blocked step closes that step", [move], run, send, query))
    run, send, query = occupied_case()
    cases.append(skills.case("occupied cells keep props off", [move], run, send, query))
    skills.save(
        "move",
        {"route": route_case(), "landing": landing_case(), "cases": cases},
    )


if __name__ == "__main__":
    main()
