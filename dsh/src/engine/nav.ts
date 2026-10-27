/**
 * Path finding on what the bridge reads: terrain codes on the world map, the collision grid
 * indoors. Pure functions; the skills in skills/move.ts walk the paths. Ported from
 * ffpr_agent/nav.py.
 */

export type Cell = readonly [number, number];
export type CellValue = number | null;
export type CellRule = (value: CellValue) => boolean;

/** A cell grid as the world map's cells reply, or one merged/layered collision grid. */
export interface CellGrid {
  readonly origin: Cell;
  readonly center: Cell;
  readonly attr: readonly (readonly CellValue[])[];
  /** Stair cells, keyed with cellKey; only indoor grids have them. */
  readonly stairs?: ReadonlySet<string>;
}

/** Integer-keyed heights keep the Python dict's insertion order, which BFS depends on. */
export interface LayeredGrid {
  readonly heights: ReadonlyMap<number, readonly string[]>;
  readonly center: Cell;
  readonly z: number;
  readonly blocked: ReadonlySet<string>;
}

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** The key for one step, which may be blocked on its own (10-20). */
export function edgeKey(from: Cell, to: Cell): string {
  return `${from[0]},${from[1]}>${to[0]},${to[1]}`;
}

const EMPTY_CELLS: ReadonlySet<string> = new Set();
const EMPTY_EDGES: ReadonlySet<string> = new Set();

/** Attribute grid with the player marked @; columns and rows labelled with cell numbers. */
export function renderCells(cells: CellGrid): string {
  const [x0, y0] = cells.origin;
  const [cx, cy] = cells.center;
  const rows = cells.attr;
  let width = 0;
  for (const row of rows) {
    for (const value of row) {
      if (value !== null) width = Math.max(width, String(value).length);
    }
  }
  width = Math.max(width, String(x0 + (rows[0]?.length ?? 1) - 1).length);
  const columns = rows[0]?.length ?? 0;
  const out = [
    " ".repeat(5) +
      Array.from({ length: columns }, (_, i) => String(x0 + i).padStart(width)).join(" "),
  ];
  for (let j = 0; j < rows.length; j++) {
    const row = rows[j] ?? [];
    const cellsText = row.map((value, i) => {
      const mark = x0 + i === cx && y0 + j === cy ? "@" : value === null ? "?" : String(value);
      return mark.padStart(width);
    });
    out.push(String(y0 + j).padStart(4) + " " + cellsText.join(" "));
  }
  return out.join("\n");
}

// World-map cell attributes (FF5 map 1): what a ship and a walking party can cross.
export const SEA: ReadonlySet<number> = new Set([16]);

export const BLOCKED_ON_FOOT: ReadonlySet<number> = new Set([16, 19, 27]);

export const MOUNTAINS: ReadonlySet<number> = new Set([19, 27]);

export function passable(value: CellValue, byShip: boolean): boolean {
  if (value === null) return false;
  return byShip ? SEA.has(value) : !BLOCKED_ON_FOOT.has(value);
}

/**
 * Which world-map cells can be crossed: by ship the sea, on foot the land, and on the wind
 * drake everything but mountains (it flies low: sea, forest and hills yes, the mountains 19
 * and 27 no, 10-21). Landing is a separate step.
 */
export function terrainRule(byShip: boolean, flying = false): CellRule {
  if (flying) return (value) => value !== null && !MOUNTAINS.has(value);
  return (value) => passable(value, byShip);
}

/** Collision grids: 0 is floor, anything else a wall or an occupied cell. */
export function floorRule(value: CellValue): boolean {
  return value === 0;
}

/**
 * Breadth-first search from the player; returns each reached cell's predecessor. `cut` holds
 * steps (from, to) found blocked on the way: passing from one cell to the next is not always
 * possible in both directions or from every side, so a failed step closes that step only, not
 * the cell (10-20).
 */
export function search(
  cells: CellGrid,
  goal: Cell,
  rule: CellRule,
  cut: ReadonlySet<string> = EMPTY_EDGES,
): Map<string, Cell | null> {
  const [x0, y0] = cells.origin;
  const rows = cells.attr;
  const start = cells.center;
  const [goalX, goalY] = goal;
  const previous = new Map<string, Cell | null>();
  const queue: Cell[] = [start];
  previous.set(cellKey(start[0], start[1]), null);
  const stairs = cells.stairs ?? EMPTY_CELLS;
  let head = 0;

  const ok = (x: number, y: number): boolean => {
    const j = y - y0;
    const i = x - x0;
    if (!(j >= 0 && j < rows.length && i >= 0 && i < (rows[0]?.length ?? 0))) return false;
    return (x === goalX && y === goalY) || rule(rows[j]?.[i] ?? null);
  };

  while (head < queue.length) {
    const cell = queue[head];
    head += 1;
    if (!cell) break;
    if (cell[0] === goalX && cell[1] === goalY) break;
    const [x, y] = cell;
    const neighbours: Cell[] = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const next of neighbours) {
      const [nx, ny] = next;
      // Stairs are climbed up or down only: no stepping onto or off them sideways (Carwen,
      // 10-20: (23,22) → (24,22) onto a stair cell failed).
      const sideways = ny === y && (stairs.has(cellKey(x, y)) || stairs.has(cellKey(nx, ny)));
      const key = cellKey(nx, ny);
      if (!previous.has(key) && !cut.has(edgeKey(cell, next)) && !sideways && ok(nx, ny)) {
        previous.set(key, cell);
        queue.push(next);
      }
    }
  }
  return previous;
}

function trace(previous: Map<string, Cell | null>, end: Cell): Cell[] {
  const path: Cell[] = [end];
  for (;;) {
    const cell = path[path.length - 1];
    if (!cell) break;
    const before = previous.get(cellKey(cell[0], cell[1]));
    if (before === null) break;
    if (before === undefined) throw new Error(`寻路结果里没有格子 (${cell[0]},${cell[1]})`);
    path.push(before);
  }
  return path.reverse();
}

function cellFromKey(key: string): Cell {
  const comma = key.indexOf(",");
  return [Number(key.slice(0, comma)), Number(key.slice(comma + 1))];
}

function nodeFromKey(key: string): Node {
  const [x, y, z] = key.split(",");
  return [Number(x), Number(y), Number(z)];
}

function manhattan(cell: Cell, goal: Cell): number {
  return Math.abs(cell[0] - goal[0]) + Math.abs(cell[1] - goal[1]);
}

function nodeManhattan(node: Node, goal: Cell): number {
  return Math.abs(node[0] - goal[0]) + Math.abs(node[1] - goal[1]);
}

/**
 * Shortest 4-way path from the player to goal over the cell grid, or null.
 *
 * The start cell is always allowed (a ship sits on its own cell; a party may stand on a town
 * entrance), and so is the goal, which may be an entrance or a shore cell.
 */
export function findPath(cells: CellGrid, goal: Cell, byShip: boolean): Cell[] | null {
  const previous = search(cells, goal, terrainRule(byShip));
  return previous.has(cellKey(goal[0], goal[1])) ? trace(previous, goal) : null;
}

/**
 * The path to goal or, when it is out of reach or out of view, to the reachable cell nearest
 * to it. `rule` says which cell values can be crossed; `cut` closes single steps.
 */
export function pathToward(
  cells: CellGrid,
  goal: Cell,
  rule: CellRule,
  cut: ReadonlySet<string> = EMPTY_EDGES,
): Cell[] {
  const previous = search(cells, goal, rule, cut);
  const goalKey = cellKey(goal[0], goal[1]);
  if (previous.has(goalKey)) return trace(previous, goal);
  let best = cells.center;
  let bestDistance = manhattan(best, goal);
  for (const key of previous.keys()) {
    const cell = cellFromKey(key);
    const distance = manhattan(cell, goal);
    if (distance < bestDistance) {
      best = cell;
      bestDistance = distance;
    }
  }
  return trace(previous, best);
}

/** The cells where the path turns, plus its end: one closed-loop walk per straight run. */
export function corners(path: readonly Cell[]): Cell[] {
  const out: Cell[] = [];
  for (let i = 1; i < path.length; i++) {
    const cell = path[i];
    const before = path[i - 1];
    if (!cell || !before) continue;
    if (i === path.length - 1) {
      out.push(cell);
      continue;
    }
    const after = path[i + 1];
    if (!after) continue;
    const beforeStep: Cell = [cell[0] - before[0], cell[1] - before[1]];
    const afterStep: Cell = [after[0] - cell[0], after[1] - cell[1]];
    if (beforeStep[0] !== afterStep[0] || beforeStep[1] !== afterStep[1]) out.push(cell);
  }
  return out;
}

/** World maps carry terrain codes; towns and dungeons read as all zeros. */
export function hasTerrain(cells: CellGrid): boolean {
  return cells.attr.some((row) => row.some((value) => Boolean(value)));
}

/** stair cells (Ship Graveyard 215, Carwen's terraces), seen 10-20 */
export const STAIRS: ReadonlySet<string> = new Set(["3", "5"]);

// The route searcher's height (the z of its cells) for each collision layer, by name: the
// street of Carwen is BottomCollision at 0, its terraces GroundCollision at 1 (10-20); a
// single-layer map is GroundCollision at 1 (Ship Graveyard).
export const LAYER_Z: ReadonlyMap<string, number> = new Map([
  ["BottomCollision", 0],
  ["GroundCollision", 1],
  ["UpperCollision", 2],
  ["TopCollision", 2],
]);

interface CollisionLayer {
  readonly name: string;
  readonly rows: string[];
}

interface CollisionData {
  readonly layers: CollisionLayer[];
  readonly here: Cell | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRows(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((row) => typeof row === "string")) {
    throw new Error("碰撞层的 rows 不是字符串数组");
  }
  return value;
}

function cellOrNull(value: unknown): Cell | null {
  if (!value) return null;
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number"
  ) {
    throw new Error("碰撞回复里的格子不是 [x, y]");
  }
  return [value[0], value[1]];
}

function collisionData(collision: unknown): CollisionData {
  if (!isRecord(collision)) throw new Error("碰撞回复不是对象");
  const layers: CollisionLayer[] = [];
  for (const layer of Array.isArray(collision.layers) ? collision.layers : []) {
    if (!isRecord(layer) || !layer.rows) continue;
    layers.push({
      name: typeof layer.name === "string" ? layer.name : "",
      rows: stringRows(layer.rows),
    });
  }
  return { layers, here: cellOrNull(collision.playerCell) };
}

function intOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

/**
 * Every collision layer of a town or dungeon merged into one cell grid like the world map's:
 * a cell is open when any layer has it open (0) or as stairs (3, 5), else a wall. Occupied
 * cells (chests, NPCs) are walls; `stairs` lists the stair cells.
 *
 * Maps have heights (Carwen: BottomCollision for the street, GroundCollision for the terraces
 * with the shops), joined by stairs. One layer alone showed the shops as walls (10-20). The
 * union can join two heights where no stairs do; a step that fails is cut on the way, and the
 * game's own route search is asked first (skills/move.ts).
 */
export function indoorGrid(collision: unknown, blocked: Iterable<Cell>): CellGrid | null {
  const { layers, here } = collisionData(collision);
  const first = layers[0];
  if (!first || !here) return null;
  const height = first.rows.length;
  const width = first.rows[0]?.length ?? 0;
  const attr: number[][] = Array.from({ length: height }, () => Array<number>(width).fill(1));
  const stairs = new Set<string>();
  for (const layer of layers) {
    for (let y = 0; y < Math.min(height, layer.rows.length); y++) {
      const row = layer.rows[y] ?? "";
      for (let x = 0; x < Math.min(width, row.length); x++) {
        const ch = row[x] ?? "";
        if (ch !== "1" && ch !== "#") {
          const target = attr[y];
          if (target) target[x] = 0;
        }
        if (STAIRS.has(ch)) stairs.add(cellKey(x, y));
      }
    }
  }
  for (const [x, y] of blocked) {
    if (y >= 0 && y < height && x >= 0 && x < width && (x !== here[0] || y !== here[1])) {
      const row = attr[y];
      if (row) row[x] = 1;
    }
  }
  return { origin: [0, 0], center: here, attr, stairs };
}

/**
 * The collision layers kept apart (control plan §4.9): for each height, which cells are open
 * (0) and which are stairs (3, 5); the player's height from the route searcher. Merging the
 * heights made ways where there are none (10-21: Walse town and castle).
 */
export function layeredGrid(collision: unknown, blocked: Iterable<Cell>): LayeredGrid | null {
  const { layers, here } = collisionData(collision);
  if (layers.length === 0 || !here) return null;
  const heights = new Map<number, readonly string[]>();
  layers.forEach((layer, index) => {
    heights.set(LAYER_Z.get(layer.name) ?? index, layer.rows);
  });
  let z = intOrZero(isRecord(collision) ? collision.searchLayer : undefined);
  if (!heights.has(z)) {
    const first = heights.keys().next();
    if (!first.done) z = first.value;
  }
  const blockedCells = new Set<string>();
  for (const [x, y] of blocked) blockedCells.add(cellKey(x, y));
  return { heights, center: here, z, blocked: blockedCells };
}

function cellAt(grid: LayeredGrid, x: number, y: number, z: number): string {
  const rows = grid.heights.get(z);
  if (!rows || !(y >= 0 && y < rows.length && x >= 0 && x < (rows[y]?.length ?? 0))) {
    return "1";
  }
  if (grid.blocked.has(cellKey(x, y)) && !(x === grid.center[0] && y === grid.center[1])) {
    return "1";
  }
  return rows[y]?.[x] ?? "1";
}

type Node = readonly [number, number, number];

function nodeKey(node: Node): string {
  return `${node[0]},${node[1]},${node[2]}`;
}

/**
 * Breadth-first over (x, y, height). Within a height, open cells and stairs connect to their
 * neighbours; a step up or down (never sideways) through a stair cell may change height. The
 * goal counts on any height. Returns the cells of the path, or of the path to the reachable
 * cell nearest the goal.
 */
export function layeredPath(
  grid: LayeredGrid,
  goal: Cell,
  cut: ReadonlySet<string> = EMPTY_EDGES,
  sidewaysStairs = false,
): Cell[] {
  const start: Node = [grid.center[0], grid.center[1], grid.z];
  const previous = new Map<string, Node | null>();
  previous.set(nodeKey(start), null);
  const queue: Node[] = [start];
  let head = 0;
  let end: Node | null = null;

  while (head < queue.length) {
    const node = queue[head];
    head += 1;
    if (!node) break;
    const [x, y, z] = node;
    if (x === goal[0] && y === goal[1]) {
      end = node;
      break;
    }
    const here = cellAt(grid, x, y, z);
    const neighbours: Cell[] = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const [nx, ny] of neighbours) {
      if (cut.has(edgeKey([x, y], [nx, ny]))) continue;
      const vertical = nx === x;
      const heights: Iterable<number> = vertical ? grid.heights.keys() : [z];
      for (const nz of heights) {
        const there = cellAt(grid, nx, ny, nz);
        if (!OPEN.has(there) && !(nx === goal[0] && ny === goal[1])) continue;
        if (nz !== z && !(STAIRS.has(here) || STAIRS.has(there))) {
          continue; // a change of height only through stairs
        }
        if (!sidewaysStairs && !vertical && (STAIRS.has(here) || STAIRS.has(there))) {
          continue; // stairs are climbed up or down only
        }
        const next: Node = [nx, ny, nz];
        const key = nodeKey(next);
        if (!previous.has(key)) {
          previous.set(key, node);
          queue.push(next);
        }
      }
    }
  }

  if (!end) {
    end = start;
    let bestDistance = nodeManhattan(end, goal);
    for (const key of previous.keys()) {
      const node = nodeFromKey(key);
      const distance = nodeManhattan(node, goal);
      if (distance < bestDistance) {
        end = node;
        bestDistance = distance;
      }
    }
  }
  const path: Node[] = [end];
  for (;;) {
    const last = path[path.length - 1];
    if (!last) break;
    const before = previous.get(nodeKey(last));
    if (before === null) break;
    if (before === undefined) throw new Error("分层寻路结果里没有这个格子");
    path.push(before);
  }
  return path.reverse().map(([x, y]) => [x, y] as const);
}

export const OPEN: ReadonlySet<string> = new Set(["0", "3", "5"]);

/**
 * The layered grid drawn from where the player stands: per cell "." open on the player's
 * height, ":" open only on another height (reached by stairs, or not at all), "=" stairs,
 * "#" wall; as {"center", "rows"}.
 */
export function layeredView(grid: LayeredGrid): { center: Cell; rows: string[] } {
  let height = 0;
  let width = 0;
  for (const rows of grid.heights.values()) {
    height = Math.max(height, rows.length);
    for (const row of rows) width = Math.max(width, row.length);
  }
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    const line: string[] = [];
    for (let x = 0; x < width; x++) {
      const own = cellAt(grid, x, y, grid.z);
      const others: string[] = [];
      for (const other of grid.heights.keys()) {
        if (other !== grid.z) others.push(cellAt(grid, x, y, other));
      }
      if (STAIRS.has(own) || others.some((value) => STAIRS.has(value))) {
        line.push("=");
      } else if (own === "0") {
        line.push(".");
      } else if (others.some((value) => value === "0")) {
        line.push(":");
      } else {
        line.push("#");
      }
    }
    rows.push(line.join(""));
  }
  return { center: grid.center, rows };
}
