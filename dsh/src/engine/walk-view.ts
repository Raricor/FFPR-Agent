/**
 * The walk view (task 61): the map under a planned walk, the route, and how far the party has
 * got. It is kept on that game's MoveState and read by the dsh page's GET /api/ffpr/walk; the
 * bridge's new `walk.*` pushes update it when they are there, and the `walkpath` reply does
 * otherwise (older bridges, a LAN fallback).
 *
 * The grid is the one the plan actually searched: the current collision layer indoors, or the
 * merged world-map terrain. The view crops it to the route's and goal's bounding box plus three
 * cells of margin, one character per cell, as the laptop's map page does.
 */

import { OPEN, cellKey } from "./nav.ts";
import type { Cell, CellGrid, LayeredGrid } from "./nav.ts";
import type { Reply } from "./pilot.ts";
import { num, record, text, truthy, type Json } from "./values.ts";

/** One straight run of the route, numbered from 1 like the bridge's own segment. */
export interface WalkSegment {
  readonly n: number;
  readonly of: number;
  readonly from: Cell;
  readonly to: Cell;
}

/** Text the page shows; computed here because the browser bundle only lays it out. */
export interface WalkDisplay {
  readonly mapText: string;
  readonly statusText: string;
  readonly segmentText: string;
  readonly progressText: string;
  readonly elapsedText: string;
}

export interface WalkView {
  readonly game: string;
  readonly seq: number | null;
  readonly map: number | null;
  readonly label: string;
  readonly goal: Cell;
  readonly path: readonly Cell[];
  readonly origin: Cell;
  readonly rows: readonly string[];
  /** How many steps have been walked: 0 at the start, path.length - 1 at the goal. */
  readonly index: number;
  readonly steps: number;
  readonly cell: Cell;
  readonly segment: WalkSegment;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly reason: string | null;
  /** Set by the route, not stored on MoveState; the elapsed time needs the request's clock. */
  readonly display?: WalkDisplay;
}

/** The planning grid before the route is cropped, kept per plan. */
export interface WalkBase {
  readonly game: string;
  readonly map: number | null;
  readonly origin: Cell;
  readonly rows: readonly string[];
}

function charAt(base: WalkBase, x: number, y: number): string {
  const row = base.rows[y - base.origin[1]];
  if (row === undefined) return " ";
  return row[x - base.origin[0]] ?? " ";
}

/** World-map terrain: sea, mountains, plains/grass, other passable land, unknown. */
function worldChar(value: number | null): string {
  if (value === null) return " ";
  if (value === 16) return "~";
  if (value === 19 || value === 27) return "^";
  if (value === 3 || value === 4) return '"';
  return ".";
}

export function worldBase(game: string, map: number | null, cells: CellGrid): WalkBase {
  return {
    game,
    map,
    origin: cells.origin,
    rows: cells.attr.map((row) => row.map((value) => worldChar(value ?? null)).join("")),
  };
}

/**
 * Indoor collision, current layer only: 0/2/3/4/5 are floor (the half-wall codes still stand
 * on walkable cells), anything else a wall; a chest/NPC cell is blocked too.
 */
export function indoorBase(game: string, map: number | null, grid: LayeredGrid): WalkBase {
  let height = 0;
  let width = 0;
  for (const rows of grid.heights.values()) {
    height = Math.max(height, rows.length);
    for (const row of rows) width = Math.max(width, row.length);
  }
  const own = grid.heights.get(grid.z) ?? [];
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    const line: string[] = [];
    for (let x = 0; x < width; x++) {
      const value = own[y]?.[x];
      if (value === undefined) {
        line.push(" ");
      } else if (grid.blocked.has(cellKey(x, y))) {
        line.push("#");
      } else if (OPEN.has(value)) {
        line.push(".");
      } else {
        line.push("#");
      }
    }
    rows.push(line.join(""));
  }
  return { game, map, origin: [0, 0], rows };
}

/** The route's and goal's bounding box plus three cells, read from the planning grid. */
export function cropWalk(
  base: WalkBase,
  path: readonly Cell[],
  goal: Cell,
): { origin: Cell; rows: string[] } {
  const cells: Cell[] = [...path, goal];
  let minX = goal[0];
  let maxX = goal[0];
  let minY = goal[1];
  let maxY = goal[1];
  for (const [x, y] of cells) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const origin: Cell = [minX - 3, minY - 3];
  const width = maxX - minX + 7;
  const height = maxY - minY + 7;
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    const line: string[] = [];
    for (let x = 0; x < width; x++) {
      line.push(charAt(base, origin[0] + x, origin[1] + y));
    }
    rows.push(line.join(""));
  }
  return { origin, rows };
}

function direction(from: Cell, to: Cell): string {
  return `${to[0] - from[0]},${to[1] - from[1]}`;
}

/** The straight runs of a four-way route, starting a new one at every turn. */
export function walkSegments(path: readonly Cell[]): { readonly from: Cell; readonly to: Cell }[] {
  if (path.length === 0) return [];
  const out: { from: Cell; to: Cell }[] = [];
  let from = path[0] ?? [0, 0];
  for (let i = 1; i < path.length; i++) {
    const before = path[i - 1];
    const cell = path[i];
    if (before === undefined || cell === undefined) continue;
    const next = path[i + 1];
    if (next === undefined || direction(before, cell) !== direction(cell, next)) {
      out.push({ from, to: cell });
      from = cell;
    }
  }
  return out;
}

/** Which segment each step (`path[i]` → `path[i+1]`) belongs to, 0-based. */
function stepSegments(path: readonly Cell[]): number[] {
  const out: number[] = [];
  let segment = 0;
  for (let i = 1; i < path.length; i++) {
    out.push(segment);
    const before = path[i - 1];
    const cell = path[i];
    if (before === undefined || cell === undefined) continue;
    const next = path[i + 1];
    if (next !== undefined && direction(before, cell) !== direction(cell, next)) segment += 1;
  }
  return out;
}

/**
 * The segment the party is on: `index → index+1` when it is still walking, the last segment
 * once it has arrived (the bridge numbers them the same way).
 */
export function segmentFor(path: readonly Cell[], index: number): WalkSegment {
  const segments = walkSegments(path);
  if (segments.length === 0) {
    const cell = path[0] ?? [0, 0];
    return { n: 1, of: 1, from: cell, to: cell };
  }
  const steps = Math.max(0, path.length - 1);
  const at = Math.max(0, Math.min(steps, index));
  const step = stepSegments(path)[at];
  const n = step === undefined ? segments.length : Math.min(segments.length, step + 1);
  const found = segments[n - 1] ?? segments[segments.length - 1];
  if (found === undefined) {
    const cell = path[0] ?? [0, 0];
    return { n: 1, of: 1, from: cell, to: cell };
  }
  return { n, of: segments.length, from: found.from, to: found.to };
}

export function beginWalk(
  base: WalkBase,
  path: readonly Cell[],
  goal: Cell,
  label: string,
  startedAt: string,
): WalkView {
  const crop = cropWalk(base, path, goal);
  const first = path[0] ?? goal;
  return {
    game: base.game,
    seq: null,
    map: base.map,
    label,
    goal,
    path: path.map((cell) => [cell[0], cell[1]] as const),
    origin: crop.origin,
    rows: crop.rows,
    index: 0,
    steps: Math.max(0, path.length - 1),
    cell: first,
    segment: segmentFor(path, 0),
    startedAt,
    endedAt: null,
    reason: null,
  };
}

export interface WalkPatch {
  readonly index?: number;
  readonly steps?: number;
  readonly cell?: Cell;
  readonly reason?: string | null;
  readonly endedAt?: string | null;
  readonly seq?: number | null;
}

export function updateWalk(view: WalkView, patch: WalkPatch): WalkView {
  const steps = patch.steps ?? view.steps;
  const rawIndex = patch.index ?? view.index;
  const index = Math.max(0, Math.min(steps, rawIndex));
  const cell = patch.cell ?? view.path[index] ?? view.cell;
  return {
    ...view,
    seq: patch.seq === undefined ? view.seq : patch.seq,
    index,
    steps,
    cell,
    segment: segmentFor(view.path, index),
    reason: patch.reason === undefined ? view.reason : patch.reason,
    endedAt: patch.endedAt === undefined ? view.endedAt : patch.endedAt,
  };
}

/** End a walk once, keeping a reason a bridge push already gave. */
export function finishWalk(view: WalkView, reason: string, endedAt: string): WalkView {
  if (view.endedAt !== null) return view;
  return updateWalk(view, { reason, endedAt });
}

/** A `walkpath` reply: the index and reason the old bridge returns instead of pushes. */
export function updateWalkFromReply(
  view: WalkView | null,
  reply: Reply,
  at: string,
): WalkView | null {
  if (view === null) return null;
  const index = num(reply.index);
  const steps = num(reply.steps);
  const cell = cellOf(record(reply.pos).cell);
  const reason = text(reply.reason) ?? (truthy(reply.ok) ? "arrived" : "stopped");
  return updateWalk(view, {
    ...(index === undefined ? {} : { index: Math.trunc(index) }),
    ...(steps === undefined ? {} : { steps: Math.trunc(steps) }),
    ...(cell === null ? {} : { cell }),
    reason,
    endedAt: at,
  });
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

function pathOf(value: unknown): Cell[] | null {
  if (!Array.isArray(value)) return null;
  const out: Cell[] = [];
  for (const item of value) {
    const cell = cellOf(item);
    if (cell === null) return null;
    out.push(cell);
  }
  return out;
}

function samePath(left: readonly Cell[], right: readonly Cell[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const cell = left[index];
    const other = right[index];
    if (cell === undefined || other === undefined) return false;
    if (cell[0] !== other[0] || cell[1] !== other[1]) return false;
  }
  return true;
}

/**
 * Apply one `walk.*` record. Its `walkSeq` is the bridge's walkpath number (the record's own
 * `seq` is the stream counter events.ts dedupes on; 11-05 review renamed the bridge field so it
 * no longer overwrote that counter). A different number is another walk (or a late push from
 * the last one) and is ignored; a `walk.start` may set the number when the view has none yet,
 * but only for the path this view planned.
 */
export function applyWalkPush(view: WalkView | null, push: Json, at: string): WalkView | null {
  if (view === null) return null;
  const type = text(push.type) ?? "";
  const seq = num(push.walkSeq);
  if (seq === undefined || !Number.isFinite(seq)) return view;
  const number = Math.trunc(seq);
  if (type === "walk.start") {
    if (view.seq !== null && view.seq !== number) return view;
    const path = pathOf(push.path);
    if (view.seq === null && path !== null && !samePath(path, view.path)) return view;
    const map = num(push.map);
    const goal = cellOf(push.goal);
    const label = text(push.label);
    const next = updateWalk(view, {
      seq: number,
      index: 0,
      steps: path === null ? view.steps : Math.max(0, path.length - 1),
      cell: path === null ? view.cell : (path[0] ?? view.cell),
      reason: null,
      endedAt: null,
    });
    return {
      ...next,
      ...(map === undefined ? {} : { map: Math.trunc(map) }),
      ...(goal === null ? {} : { goal }),
      ...(label === undefined ? {} : { label }),
      ...(path === null ? {} : { path }),
      segment: segmentFor(path ?? next.path, 0),
    };
  }
  if (view.seq === null || view.seq !== number) return view;
  if (type === "walk.progress") {
    if (view.endedAt !== null) return view;
    const index = num(push.index);
    const steps = num(push.steps);
    const cell = cellOf(push.cell);
    return updateWalk(view, {
      ...(index === undefined ? {} : { index: Math.trunc(index) }),
      ...(steps === undefined ? {} : { steps: Math.trunc(steps) }),
      ...(cell === null ? {} : { cell }),
    });
  }
  if (type === "walk.end") {
    if (view.endedAt !== null) return view;
    const index = num(push.index);
    const steps = num(push.steps);
    const cell = cellOf(push.cell);
    return updateWalk(view, {
      ...(index === undefined ? {} : { index: Math.trunc(index) }),
      ...(steps === undefined ? {} : { steps: Math.trunc(steps) }),
      ...(cell === null ? {} : { cell }),
      reason: text(push.reason) ?? "stopped",
      endedAt: at,
    });
  }
  return view;
}

function reasonText(reason: string | null): string {
  if (reason === null) return "停止";
  if (reason === "arrived") return "到达";
  if (reason === "battle") return "遇敌";
  if (reason === "dialog") return "对话";
  if (reason === "state:Event") return "剧情";
  if (reason.startsWith("state:")) return `状态(${reason.slice("state:".length)})`;
  if (reason === "map_changed") return "换图";
  if (reason === "blocked") return "被挡住";
  if (reason === "off_path") return "偏离路线";
  if (reason === "timeout") return "超时";
  if (reason === "stopped") return "停止";
  if (reason === "closed") return "连接断开";
  if (reason === "bad_path") return "路线无效";
  if (reason === "no_player") return "读不到人物";
  return reason;
}

function durationText(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${String(minutes % 60).padStart(2, "0")} 分`;
}

/**
 * The Chinese lines the walking block shows. The clock is passed in so a request computes the
 * elapsed time from its own "now" while a stopped walk keeps the end time.
 */
export function walkDisplay(view: WalkView, now = Date.now()): WalkDisplay {
  const started = Date.parse(view.startedAt);
  const ended = view.endedAt === null ? now : Date.parse(view.endedAt);
  const elapsed = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : 0;
  const walked = Math.max(0, Math.min(view.index, view.steps));
  const segment =
    view.segment.of <= 0
      ? "还没有路线"
      : `第 ${view.segment.n}/${view.segment.of} 段 ` +
        `(${view.segment.from[0]}, ${view.segment.from[1]})→` +
        `(${view.segment.to[0]}, ${view.segment.to[1]})`;
  return {
    mapText: view.map === null ? "地图未知" : `地图 ${view.map}`,
    statusText: view.endedAt === null ? "正在走" : reasonText(view.reason),
    segmentText: segment,
    progressText: `已走 ${walked} / ${view.steps} 格`,
    elapsedText: `已用 ${durationText(elapsed)}`,
  };
}
