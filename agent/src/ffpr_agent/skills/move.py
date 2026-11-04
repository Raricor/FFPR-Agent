"""Walking: closed-loop legs on the laptop, planned here, re-planned when blocked; and
stepping up to a chest, NPC or counter to interact with it."""

import time
from itertools import pairwise

from ffpr_agent import laptop as lp
from ffpr_agent.nav import (
    _search,
    corners,
    has_terrain,
    layered_grid,
    layered_path,
    path_toward,
    terrain_rule,
)
from ffpr_agent.pilot import query, send
from ffpr_agent.skills import battle


def walk_leg(laptop: lp.Laptop, x: int, y: int, say) -> dict:
    """Walk to a cell. Battles on the way are fought by the local battle skill; doors and
    other gimmicks that briefly take control are waited out."""
    for _ in range(10):
        result = send(laptop, "walk", _wait=40, to=[x, y], timeout=30000)
        pos = result.get("pos") or {}
        if result.get("ok"):
            return result
        if pos.get("battle") or pos.get("state") == "Battle":
            say(f"  途中遇敌,{battle.regular(laptop, say)}")
        elif pos.get("state") == "Gimmick" or "Gimmick" in str(result.get("error")):
            send(laptop, "wait", _wait=40, timeout=30000)
        else:
            return result
    return result


def occupied_cells(laptop: lp.Laptop) -> set[tuple[int, int]]:
    """Cells to keep off: chests, NPCs and shop counters (RelayInteraction: talking to it
    talks to the keeper behind), none of them in the collision data, and entrances, since
    crossing stairs or a door on the way swaps the map. The caller removes the goal."""
    cells: set[tuple[int, int]] = set()
    for kind in ("TresureBox", "Npc", "RelayInteraction", "GotoMap"):
        found = send(laptop, "entities", kind=kind, max=200).get("entities") or {}
        for e in found.get("entities") or []:
            if e.get("active", True) and e.get("cell"):
                cells.add(tuple(e["cell"]))
    return cells


def plan(laptop: lp.Laptop, goal: tuple[int, int], by_ship: bool, cut=frozenset()):
    """(start cell, path including start) toward goal on the current map, or (None, []) while a
    map is still loading. `cut`: steps (from, to) found blocked on the way."""
    cells = send(laptop, "cells", r=24).get("cells")
    if not cells:
        return None, []
    cut = frozenset(cut)
    if has_terrain(cells):
        rule = terrain_rule(by_ship, flying(laptop))
        return tuple(cells["center"]), path_toward(cells, goal, rule, cut)
    collision = send(laptop, "collision").get("collision") or {}
    grid = layered_grid(collision, occupied_cells(laptop) - {goal})
    if grid is None:
        return tuple(cells["center"]), []
    return tuple(grid["center"]), layered_path(grid, goal, cut)


def route_cells(route: dict) -> list[tuple[int, int]]:
    """The game's route (bridge `route`) as cells. Its points are local pixel positions, 16 a
    cell, y growing upwards; the first is where the player stands (`from`), which gives the
    offset to cells."""
    points, start = route.get("cells") or [], route.get("from")
    if not points or not start:
        return []
    ox = start[0] - round(points[0][0] / 16)
    oy = start[1] + round(points[0][1] / 16)
    return [(round(x / 16) + ox, oy - round(y / 16)) for x, y, *_ in points]


FLYING = {"LowFlying", "HighFlying", "Flying"}


def flying(laptop: lp.Laptop) -> bool:
    """On the wind drake (the field's moveState reads LowFlying, 10-21)."""
    field = (query(laptop, "sample").get("sample") or {}).get("field") or {}
    return field.get("moveState") in FLYING


LANDABLE = {3, 4}  # grass and plains; the drake does not land on forest, desert or hills


# Where the wind drake was last left: it stays on the cell it landed on, and standing there
# with Enter boards it again (10-21). The player keeps it across runs (ds/game.py).
drake: tuple[int, int] | None = None


def land_here(laptop: lp.Laptop) -> bool:
    global drake
    send(laptop, "keys", keys=["Enter"], gap=200)
    # The landing plays out over a second or two before the move state changes (10-21).
    deadline = time.monotonic() + 4
    while flying(laptop) and time.monotonic() < deadline:
        time.sleep(0.3)
    if flying(laptop):
        return False
    drake = tuple(send(laptop, "pos")["pos"].get("cell") or ()) or None
    return True


def board(laptop: lp.Laptop, say=print) -> tuple[bool, str]:
    """Walk back to where the drake was left and get on (Enter on its cell)."""
    if flying(laptop):
        return True, "已经骑在飞龙上了"
    if drake is None:
        return False, "不知道飞龙停在哪(还没在这次运行里降落过)"
    reached, message = navigate(laptop, drake, False, say)
    if not reached:
        return False, f"走不到飞龙那里 {drake}:{message}"
    send(laptop, "keys", keys=["Enter"], gap=200)
    deadline = time.monotonic() + 4
    while not flying(laptop) and time.monotonic() < deadline:
        time.sleep(0.3)
    return (True, f"骑上了飞龙,在 {drake}") if flying(laptop) else (False, "按了确认没骑上")


def land(laptop: lp.Laptop, near: tuple[int, int] | None = None, say=print) -> tuple[bool, str]:
    """Bring the wind drake down and step off. It lands on grass and plains only (10-21: it
    would not land on the forest by Walse's gate, and the player never learned where it
    could), so when the cell below will not do, fly to the nearest one that will. With `near`
    (an entrance to walk into) only cells that connect to it on foot count, nearest by walk
    (10-21: a landing west of Tycoon was cut off from the castle by mountains)."""
    if not flying(laptop):
        return False, "现在没有在飞"
    cells = send(laptop, "cells", r=8).get("cells") or {}
    here = tuple(cells.get("center") or ())
    spots = landing_spots(cells, near)
    if near is None and here in spots:
        spots = [here, *[s for s in spots if s != here]]
    for spot in spots[:4]:
        if spot != here:
            reached, _ = navigate(laptop, spot, False, say)
            if not reached:
                continue
        if land_here(laptop):
            pos = send(laptop, "pos")["pos"]
            return True, f"降落了,在 {pos.get('cell')}"
        here = tuple(send(laptop, "pos")["pos"].get("cell") or here)
    where = f"能走到 {near} 的" if near else ""
    return False, f"附近 8 格内找不到{where}平原或草地可以降落,飞到开阔的平地上再试"


def landing_spots(cells: dict, near: tuple[int, int] | None) -> list[tuple[int, int]]:
    """Grass and plains in view: those connected on foot to `near`, nearest by walk first, or
    all of them nearest to the player first."""
    x0, y0 = cells.get("origin") or (0, 0)
    open_ground = {
        (x0 + i, y0 + j)
        for j, row in enumerate(cells.get("attr") or [])
        for i, v in enumerate(row)
        if v in LANDABLE
    }
    if near is None:
        here = tuple(cells.get("center") or (0, 0))
        return sorted(open_ground, key=lambda c: abs(c[0] - here[0]) + abs(c[1] - here[1]))
    # Breadth-first from the entrance on foot: the order of the search is the walking distance.
    walked = _search(dict(cells, center=list(near)), (-1, -1), terrain_rule(False))
    return [c for c in walked if c in open_ground]


def fly_in(laptop: lp.Laptop, goal: tuple[int, int], say=print) -> tuple[bool, str]:
    """On the drake, to a town or dungeon entrance: fly near it, land on the closest open
    ground, and walk in (the drake cannot enter; flying onto the entrance does nothing)."""
    navigate(laptop, goal, False, say)  # flying: the view then centres on the entrance
    ok, text = land(laptop, near=goal, say=say)
    if not ok:
        return False, text
    say(f"  {text},走过去")
    return navigate(laptop, goal, False, say)


def on_world_map(laptop: lp.Laptop) -> bool:
    cells = send(laptop, "cells", r=2).get("cells")
    return bool(cells) and has_terrain(cells)


def game_route(laptop: lp.Laptop, goal: tuple[int, int]) -> list[tuple[int, int]]:
    """The game's own route to goal, or [] when it has none. It knows stairs inside a map,
    which the collision grid shows as walls (10-20, the Ship Graveyard's map 215)."""
    route = send(laptop, "route", to=list(goal), collision=True).get("route") or {}
    path = route_cells(route)
    return path if len(path) >= 2 and path[-1] == goal else []


def navigate(laptop: lp.Laptop, goal: tuple[int, int], by_ship: bool, say=print, legs: int = 8):
    """Route to goal and walk it, replanning when something gets in the way. World maps use
    the terrain codes; towns and dungeons use the map's collision grid (bridge 0.2.5+).
    Returns (reached, message)."""
    how = "船" if by_ship else "步行"
    start_map = send(laptop, "pos")["pos"].get("map")
    # Steps that turned out blocked though the map data says open (a closed gate, an object
    # the collision data lacks, a side a cell cannot be entered from): the next plan goes
    # around that step instead of into it again; the cell stays usable from other sides.
    cut: set[tuple[tuple[int, int], tuple[int, int]]] = set()
    for _ in range(legs):
        pos = send(laptop, "pos")["pos"]
        if pos.get("map") != start_map:
            # Walked onto an entrance or stairs: the goal's coordinates belonged to the old map.
            send(laptop, "wait", _wait=40, timeout=30000)
            now = send(laptop, "pos")["pos"]
            return True, f"进入了地图 {now.get('map')},现在在 {now.get('cell')}"
        here, path = plan(laptop, goal, by_ship, cut)
        if here is None:
            send(laptop, "wait", _wait=40, timeout=30000)
            continue
        if here == goal:
            return True, f"到达 {goal}"
        if not by_ship and not on_world_map(laptop):
            # Indoors the game's own search comes first: it knows heights, stairs and which
            # side a cell can be entered from (control plan §4.9). Ours is the fallback, and
            # also when the game's route takes a step that already failed.
            theirs = game_route(laptop, goal)
            steps = set(pairwise(theirs))
            if theirs and theirs[0] == here and not steps & cut:
                path = theirs
        if len(path) < 2:
            return False, f"在 {here} {how}走不过去,这里已是离 {goal} 最近的地方"
        say(f"  {here} → {path[-1]}:{len(path) - 1} 格")
        for x, y in corners(path):
            result = walk_leg(laptop, x, y, say)
            if result.get("ok"):
                continue
            pos = result.get("pos") or {}
            # Stepping onto an entrance swaps the map: that is arriving, not failing.
            if pos.get("state") in ("ChangeMap", "FieldReady") or "ChangeMap" in str(
                result.get("error")
            ):
                send(laptop, "wait", _wait=40, timeout=30000)
                now = send(laptop, "pos")["pos"]
                return True, f"进入了地图 {now.get('map')},现在在 {now.get('cell')}"
            if result.get("error") == "blocked":
                stuck = tuple(pos.get("cell") or ())
                ahead = path[path.index(stuck) + 1] if stuck in path[:-1] else None
                if ahead is not None:
                    cut.add((stuck, ahead))
                say(
                    f"  在 {pos.get('cell')} 被挡住"
                    + (f"(到 {ahead} 这一步走不过去)" if ahead else "")
                )
                break
            return False, f"停在 {pos.get('cell')}:{result.get('error')}"
        # A goal beyond the planning window: this leg ended at the nearest cell in view, and
        # the next plan, from there, sees further. One that gets no closer stops above.
    return False, f"走了 {legs} 段还没到 {goal}"


FACING = {(0, -1): "Up", (0, 1): "Down", (-1, 0): "Left", (1, 0): "Right"}


def open_at(laptop: lp.Laptop, target: tuple[int, int], say=print) -> str:
    """Stand next to a chest, NPC or object, face it, press Enter and page the dialog.
    Shopkeepers and innkeepers stand behind a counter: when no neighbouring cell can be
    reached, talk across one cell from two cells away, the way the games allow."""
    here, _ = plan(laptop, target, False)
    if here is None:
        return "地图还在切换,稍后再试"
    best = None
    taken = occupied_cells(laptop) - {here}  # plan() lets its goal through; a spot must not be
    for distance in (1, 2):
        for (dx, dy), _key in FACING.items():
            spot = (target[0] - dx * distance, target[1] - dy * distance)
            if spot in taken:
                continue
            _, path = plan(laptop, spot, False)
            reachable = spot == here or (path and path[-1] == spot)
            if reachable and (best is None or len(path) < len(best[1])):
                best = (spot, path, (dx, dy))
        if best is not None:
            break
    if best is None:
        return f"{target} 四周两格内都走不到"
    spot, _, direction = best
    if spot != here:
        reached, message = navigate(laptop, spot, False, say)
        if not reached:
            return f"走不到 {target} 旁边:{message}"
    keys = [f"{FACING[direction]}:60", "Enter"]
    result = send(laptop, "keys", keys=keys, gap=250)
    if not result.get("ok"):
        return f"没按成:{result.get('error')}"
    story = send(laptop, "story", _wait=620, pageMs=2500, timeout=600000)
    return f"站在 {spot} 面朝{FACING[direction]}按了确认,之后翻了 {story.get('pages')} 页对话"
