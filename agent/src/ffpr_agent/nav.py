"""Path finding on what the bridge reads: terrain codes on the world map, the collision
grid indoors. Pure functions; the skills in skills/move.py walk the paths."""

from collections import deque


def render_cells(cells: dict) -> str:
    """Attribute grid with the player marked @; columns and rows labelled with cell numbers."""
    x0, y0 = cells["origin"]
    cx, cy = cells["center"]
    rows = cells["attr"]
    width = max(len(str(v)) for row in rows for v in row if v is not None)
    width = max(width, len(str(x0 + len(rows[0]) - 1)))
    out = [" " * 5 + " ".join(f"{x0 + i:>{width}}" for i in range(len(rows[0])))]
    for j, row in enumerate(rows):
        cells_text = []
        for i, v in enumerate(row):
            mark = "@" if (x0 + i, y0 + j) == (cx, cy) else ("?" if v is None else str(v))
            cells_text.append(f"{mark:>{width}}")
        out.append(f"{y0 + j:>4} " + " ".join(cells_text))
    return "\n".join(out)


# World-map cell attributes (FF5 map 1): what a ship and a walking party can cross.
SEA = {16}


BLOCKED_ON_FOOT = {16, 19, 27}


MOUNTAINS = {19, 27}


def passable(value: int | None, by_ship: bool) -> bool:
    if value is None:
        return False
    return value in SEA if by_ship else value not in BLOCKED_ON_FOOT


def terrain_rule(by_ship: bool, flying: bool = False):
    """Which world-map cells can be crossed: by ship the sea, on foot the land, and on the wind
    drake everything but mountains (it flies low: sea, forest and hills yes, the mountains 19
    and 27 no, 10-21). Landing is a separate step."""
    if flying:
        return lambda value: value is not None and value not in MOUNTAINS
    return lambda value: passable(value, by_ship)


def floor_rule(value: int | None) -> bool:
    """Collision grids: 0 is floor, anything else a wall or an occupied cell."""
    return value == 0


Edge = tuple[tuple[int, int], tuple[int, int]]


def _search(cells: dict, goal: tuple[int, int], rule, cut: frozenset[Edge] = frozenset()) -> dict:
    """Breadth-first search from the player; returns each reached cell's predecessor. `cut`
    holds steps (from, to) found blocked on the way: passing from one cell to the next is not
    always possible in both directions or from every side, so a failed step closes that step
    only, not the cell (10-20)."""
    x0, y0 = cells["origin"]
    rows = cells["attr"]
    start = tuple(cells["center"])

    def ok(x: int, y: int) -> bool:
        j, i = y - y0, x - x0
        if not (0 <= j < len(rows) and 0 <= i < len(rows[0])):
            return False
        return (x, y) == goal or rule(rows[j][i])

    # Stairs are climbed up or down only: no stepping onto or off them sideways (Carwen,
    # 10-20: (23,22) → (24,22) onto a stair cell failed).
    stairs = cells.get("stairs") or set()
    previous: dict[tuple[int, int], tuple[int, int] | None] = {start: None}
    queue = deque([start])
    while queue:
        cell = queue.popleft()
        if cell == goal:
            break
        x, y = cell
        for nxt in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            sideways = nxt[1] == y and (cell in stairs or nxt in stairs)
            if nxt not in previous and (cell, nxt) not in cut and not sideways and ok(*nxt):
                previous[nxt] = cell
                queue.append(nxt)
    return previous


def _trace(previous: dict, end: tuple[int, int]) -> list[tuple[int, int]]:
    path = [end]
    while previous[path[-1]] is not None:
        path.append(previous[path[-1]])
    return path[::-1]


def find_path(cells: dict, goal: tuple[int, int], by_ship: bool) -> list[tuple[int, int]] | None:
    """Shortest 4-way path from the player to goal over the cell grid, or None.

    The start cell is always allowed (a ship sits on its own cell; a party may stand on a
    town entrance), and so is the goal, which may be an entrance or a shore cell.
    """
    previous = _search(cells, goal, terrain_rule(by_ship))
    return _trace(previous, goal) if goal in previous else None


def path_toward(
    cells: dict, goal: tuple[int, int], rule, cut: frozenset[Edge] = frozenset()
) -> list[tuple[int, int]]:
    """The path to goal or, when it is out of reach or out of view, to the reachable cell
    nearest to it. `rule` says which cell values can be crossed; `cut` closes single steps."""
    previous = _search(cells, goal, rule, cut)
    if goal in previous:
        return _trace(previous, goal)
    best = min(previous, key=lambda c: abs(c[0] - goal[0]) + abs(c[1] - goal[1]))
    return _trace(previous, best)


def corners(path: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """The cells where the path turns, plus its end: one closed-loop walk per straight run."""
    out = []
    for i in range(1, len(path)):
        if i == len(path) - 1:
            out.append(path[i])
            continue
        before = (path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
        after = (path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1])
        if before != after:
            out.append(path[i])
    return out


def has_terrain(cells: dict) -> bool:
    """World maps carry terrain codes; towns and dungeons read as all zeros."""
    return any(v for row in cells["attr"] for v in row)


STAIRS = set("35")  # stair cells (Ship Graveyard 215, Carwen's terraces), seen 10-20


def indoor_grid(collision: dict, blocked: set[tuple[int, int]]) -> dict | None:
    """Every collision layer of a town or dungeon merged into one cell grid like the world
    map's: a cell is open when any layer has it open (0) or as stairs (3, 5), else a wall.
    Occupied cells (chests, NPCs) are walls; `stairs` lists the stair cells.

    Maps have heights (Carwen: BottomCollision for the street, GroundCollision for the
    terraces with the shops), joined by stairs. One layer alone showed the shops as walls
    (10-20). The union can join two heights where no stairs do; a step that fails is cut
    on the way, and the game's own route search is asked first (skills/move.py)."""
    layers = [layer["rows"] for layer in collision.get("layers") or [] if layer.get("rows")]
    here = collision.get("playerCell")
    if not layers or not here:
        return None
    height, width = len(layers[0]), len(layers[0][0])
    attr = [[1] * width for _ in range(height)]
    stairs: set[tuple[int, int]] = set()
    for rows in layers:
        for y in range(min(height, len(rows))):
            for x, ch in enumerate(rows[y][:width]):
                if ch not in "1#":
                    attr[y][x] = 0
                if ch in STAIRS:
                    stairs.add((x, y))
    for x, y in blocked:
        if 0 <= y < height and 0 <= x < width and (x, y) != tuple(here):
            attr[y][x] = 1
    return {"origin": [0, 0], "center": list(here), "attr": attr, "stairs": stairs}


# The route searcher's height (the z of its cells) for each collision layer, by name: the
# street of Carwen is BottomCollision at 0, its terraces GroundCollision at 1 (10-20); a
# single-layer map is GroundCollision at 1 (Ship Graveyard).
LAYER_Z = {"BottomCollision": 0, "GroundCollision": 1, "UpperCollision": 2, "TopCollision": 2}
Node = tuple[int, int, int]


def layered_grid(collision: dict, blocked: set[tuple[int, int]]) -> dict | None:
    """The collision layers kept apart (control plan §4.9): for each height, which cells are
    open (0) and which are stairs (3, 5); the player's height from the route searcher. Merging
    the heights made ways where there are none (10-21: Walse town and castle)."""
    layers = [layer for layer in collision.get("layers") or [] if layer.get("rows")]
    here = collision.get("playerCell")
    if not layers or not here:
        return None
    heights: dict[int, list[str]] = {}
    for i, layer in enumerate(layers):
        heights[LAYER_Z.get(layer.get("name") or "", i)] = layer["rows"]
    z = int(collision.get("searchLayer") or 0)
    if z not in heights:  # an unknown name: the player is on the only (or first) layer
        z = next(iter(heights))
    return {"heights": heights, "center": list(here), "z": z, "blocked": set(blocked)}


def _cell(grid: dict, x: int, y: int, z: int) -> str:
    rows = grid["heights"].get(z)
    if rows is None or not (0 <= y < len(rows) and 0 <= x < len(rows[y])):
        return "1"
    if (x, y) in grid["blocked"] and [x, y] != list(grid["center"]):
        return "1"
    return rows[y][x]


def layered_path(
    grid: dict, goal: tuple[int, int], cut: frozenset[Edge] = frozenset()
) -> list[tuple[int, int]]:
    """Breadth-first over (x, y, height). Within a height, open cells and stairs connect to
    their neighbours; a step up or down (never sideways) through a stair cell may change
    height. The goal counts on any height. Returns the cells of the path, or of the path to
    the reachable cell nearest the goal."""
    x, y = grid["center"]
    start: Node = (x, y, grid["z"])
    previous: dict[Node, Node | None] = {start: None}
    queue = deque([start])
    end = None
    while queue:
        node = queue.popleft()
        x, y, z = node
        if (x, y) == goal:
            end = node
            break
        here = _cell(grid, x, y, z)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if ((x, y), (nx, ny)) in cut:
                continue
            vertical = nx == x
            heights = grid["heights"] if vertical else [z]
            for nz in heights:
                there = _cell(grid, nx, ny, nz)
                if there not in OPEN and (nx, ny) != goal:
                    continue
                if nz != z and not (here in STAIRS or there in STAIRS):
                    continue  # a change of height only through stairs
                if not vertical and (here in STAIRS or there in STAIRS):
                    continue  # stairs are climbed up or down only
                nxt = (nx, ny, nz)
                if nxt not in previous:
                    previous[nxt] = node
                    queue.append(nxt)
    if end is None:
        end = min(previous, key=lambda n: abs(n[0] - goal[0]) + abs(n[1] - goal[1]))
    path = [end]
    while previous[path[-1]] is not None:
        path.append(previous[path[-1]])
    return [(n[0], n[1]) for n in reversed(path)]


OPEN = {"0", "3", "5"}


def layered_view(grid: dict) -> dict:
    """The layered grid drawn from where the player stands: per cell "." open on the player's
    height, ":" open only on another height (reached by stairs, or not at all), "=" stairs,
    "#" wall; as {"center", "rows"}."""
    heights = grid["heights"]
    z = grid["z"]
    height = max(len(rows) for rows in heights.values())
    width = max(len(row) for rows in heights.values() for row in rows)
    rows = []
    for y in range(height):
        line = []
        for x in range(width):
            own = _cell(grid, x, y, z)
            others = [_cell(grid, x, y, h) for h in heights if h != z]
            if own in STAIRS or any(c in STAIRS for c in others):
                line.append("=")
            elif own == "0":
                line.append(".")
            elif any(c == "0" for c in others):
                line.append(":")
            else:
                line.append("#")
        rows.append("".join(line))
    return {"center": grid["center"], "rows": rows}
