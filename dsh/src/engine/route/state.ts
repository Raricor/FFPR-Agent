/**
 * Progress of one route execution (task 87): the plan being followed, the waypoints still to
 * do, the ids already completed and the index of the next leg. The stage layer writes the
 * file after every waypoint so a restart can call `resumeRoute` and keep walking.
 *
 * The file is a plain JSON snapshot; the executor is the only writer. The reader validates
 * every field because a stale or hand-edited file must fail with a Chinese message instead of
 * making the executor walk a half-formed plan.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeError, isMissingFile } from "../errors.ts";
import type { Cell } from "../nav.ts";
import { isRecord, list, num, text } from "../values.ts";
import type {
  GrindUntil,
  RouteLeg,
  RoutePlan,
  RoutePoint,
  RouteTotal,
  UnreachableWaypoint,
  Waypoint,
  WaypointBook,
  WaypointKind,
} from "./types.ts";

export const ROUTE_PROGRESS_VERSION = 1;

const WAYPOINT_KINDS: ReadonlySet<string> = new Set([
  "chest",
  "grind",
  "shop",
  "inn",
  "save",
  "boss",
  "move",
  "story",
  "handoff",
]);

/** One executable snapshot. `next` indexes `plan.legs`; `waypoints` is what is left. */
export interface RouteProgress {
  readonly version: typeof ROUTE_PROGRESS_VERSION;
  readonly plan: RoutePlan;
  readonly waypoints: readonly Waypoint[];
  readonly completed: readonly string[];
  readonly next: number;
  /** Task 89: the run's final destination when it is not one of the waypoints. */
  readonly end?: Waypoint | null;
  readonly updatedAt: string;
}

export function isWaypointKind(value: string): value is WaypointKind {
  return WAYPOINT_KINDS.has(value);
}

function integer(value: unknown, where: string): number {
  const parsed = num(value);
  if (parsed === undefined || !Number.isInteger(parsed)) {
    throw new Error(`${where} 不是整数`);
  }
  return parsed;
}

function stringOf(value: unknown, where: string): string {
  const parsed = text(value);
  if (parsed === undefined) throw new Error(`${where} 不是字符串`);
  return parsed;
}

function numberOf(value: unknown, where: string): number {
  const parsed = num(value);
  if (parsed === undefined) throw new Error(`${where} 不是数字`);
  return parsed;
}

function cellOf(value: unknown, where: string): Cell {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${where} 不是 [x,y]`);
  }
  return [integer(value[0], `${where}[0]`), integer(value[1], `${where}[1]`)];
}

function nullableCell(value: unknown, where: string): Cell | null {
  return value === null ? null : cellOf(value, where);
}

function pointOf(value: unknown, where: string): RoutePoint {
  if (!isRecord(value)) throw new Error(`${where} 不是对象`);
  return {
    map: integer(value.map, `${where}.map`),
    cell: nullableCell(value.cell, `${where}.cell`),
  };
}

function kindOf(value: unknown, where: string, allowEnd: true): WaypointKind | "end";
function kindOf(value: unknown, where: string, allowEnd: false): WaypointKind;
function kindOf(value: unknown, where: string, allowEnd: boolean): WaypointKind | "end" {
  const parsed = text(value);
  if (allowEnd && parsed === "end") return "end";
  if (parsed !== undefined && isWaypointKind(parsed)) return parsed;
  throw new Error(`${where} 的 kind 不认识`);
}

function untilOf(value: unknown, where: string): GrindUntil {
  if (!isRecord(value)) throw new Error(`${where}.until 不是对象`);
  const list = (raw: unknown, name: string, allowNumbers: boolean): (string | number)[] => {
    const entries = Array.isArray(raw) ? raw : [];
    if (entries.length === 0) throw new Error(`${where}.until.${name} 不能是空数组`);
    return entries.map((entry, index) => {
      if (typeof entry === "string" && entry.trim() !== "") return entry.trim();
      if (allowNumbers && typeof entry === "number" && Number.isFinite(entry)) {
        return Math.trunc(entry);
      }
      throw new Error(`${where}.until.${name}[${index}] 不是名字或数字`);
    });
  };
  const bestiary =
    value.bestiary === undefined ? undefined : list(value.bestiary, "bestiary", true);
  const blueMagic =
    value.blueMagic === undefined
      ? undefined
      : list(value.blueMagic, "blueMagic", false).map((name) => String(name));
  const battles =
    value.battles === undefined ? undefined : integer(value.battles, `${where}.until.battles`);
  const minutes =
    value.minutes === undefined ? undefined : numberOf(value.minutes, `${where}.until.minutes`);
  if (
    bestiary === undefined &&
    blueMagic === undefined &&
    battles === undefined &&
    minutes === undefined
  ) {
    throw new Error(`${where}.until 至少要有一项`);
  }
  return {
    ...(bestiary === undefined ? {} : { bestiary }),
    ...(blueMagic === undefined ? {} : { blueMagic }),
    ...(battles === undefined ? {} : { battles }),
    ...(minutes === undefined ? {} : { minutes }),
  };
}

function bookOf(value: unknown, where: string): WaypointBook {
  if (!isRecord(value)) throw new Error(`${where}.book 不是对象`);
  const part = value.part === undefined ? undefined : integer(value.part, `${where}.book.part`);
  const parts = value.parts === undefined ? undefined : integer(value.parts, `${where}.book.parts`);
  const indexes = list(value.indexes).map((entry, index) =>
    integer(entry, `${where}.book.indexes[${index}]`),
  );
  const item = value.item === null ? null : text(value.item);
  return {
    section: stringOf(value.section, `${where}.book.section`),
    index: integer(value.index, `${where}.book.index`),
    kind: stringOf(value.kind, `${where}.book.kind`),
    text: stringOf(value.text, `${where}.book.text`),
    where: value.where === null ? null : stringOf(value.where, `${where}.book.where`),
    ...(part === undefined ? {} : { part }),
    ...(parts === undefined ? {} : { parts }),
    ...(value.autoStory === true ? { autoStory: true } : {}),
    ...(indexes.length === 0 ? {} : { indexes }),
    ...(item === undefined ? {} : { item }),
  };
}

function waypointOf(value: unknown, where: string): Waypoint {
  if (!isRecord(value)) throw new Error(`${where} 不是对象`);
  const after =
    value.after === undefined
      ? undefined
      : list(value.after).map((entry, index) => stringOf(entry, `${where}.after[${index}]`));
  const minutes = value.minutes === undefined ? undefined : num(value.minutes);
  if (value.minutes !== undefined && minutes === undefined) {
    throw new Error(`${where}.minutes 不是数字`);
  }
  const until = value.until === undefined ? undefined : untilOf(value.until, where);
  const reach = text(value.reach);
  if (reach !== undefined && reach !== "cell" && reach !== "map") {
    throw new Error(`${where}.reach 只能是 cell 或 map`);
  }
  return {
    id: stringOf(value.id, `${where}.id`),
    kind: kindOf(value.kind, where, false),
    map: integer(value.map, `${where}.map`),
    cell: nullableCell(value.cell, `${where}.cell`),
    label: stringOf(value.label, `${where}.label`),
    ...(after === undefined ? {} : { after }),
    ...(minutes === undefined ? {} : { minutes }),
    ...(until === undefined ? {} : { until }),
    ...(value.optional === undefined ? {} : { optional: value.optional === true }),
    ...(reach === undefined ? {} : { reach }),
    ...(value.book === undefined ? {} : { book: bookOf(value.book, where) }),
  };
}

function legOf(value: unknown, where: string): RouteLeg {
  if (!isRecord(value)) throw new Error(`${where} 不是对象`);
  const maps = list(value.maps).map((entry, index) => integer(entry, `${where}.maps[${index}]`));
  return {
    from: pointOf(value.from, `${where}.from`),
    waypoint: stringOf(value.waypoint, `${where}.waypoint`),
    kind: kindOf(value.kind, where, true),
    label: stringOf(value.label, `${where}.label`),
    map: integer(value.map, `${where}.map`),
    cell: nullableCell(value.cell, `${where}.cell`),
    ...(value.until === undefined ? {} : { until: untilOf(value.until, where) }),
    maps,
    hops: integer(value.hops, `${where}.hops`),
    cells: numberOf(value.cells, `${where}.cells`),
    minutes: numberOf(value.minutes, `${where}.minutes`),
  };
}

function unreachableOf(value: unknown, where: string): UnreachableWaypoint {
  if (!isRecord(value)) throw new Error(`${where} 不是对象`);
  return {
    id: stringOf(value.id, `${where}.id`),
    kind: kindOf(value.kind, where, false),
    map: integer(value.map, `${where}.map`),
    cell: nullableCell(value.cell, `${where}.cell`),
    label: stringOf(value.label, `${where}.label`),
    reason: stringOf(value.reason, `${where}.reason`),
  };
}

function totalOf(value: unknown, where: string): RouteTotal {
  if (!isRecord(value)) throw new Error(`${where} 不是对象`);
  return {
    cells: numberOf(value.cells, `${where}.cells`),
    hops: integer(value.hops, `${where}.hops`),
    minutes: numberOf(value.minutes, `${where}.minutes`),
  };
}

function planOf(value: unknown): RoutePlan {
  if (!isRecord(value)) throw new Error("plan 不是对象");
  return {
    legs: list(value.legs).map((entry, index) => legOf(entry, `plan.legs[${index}]`)),
    unreachable: list(value.unreachable).map((entry, index) =>
      unreachableOf(entry, `plan.unreachable[${index}]`),
    ),
    warnings: list(value.warnings).map((entry, index) =>
      stringOf(entry, `plan.warnings[${index}]`),
    ),
    total: totalOf(value.total, "plan.total"),
  };
}

function progressOf(value: unknown, file: string): RouteProgress {
  if (!isRecord(value)) throw new Error(`进度文件 ${file} 不是 JSON 对象`);
  if (value.version !== ROUTE_PROGRESS_VERSION) {
    throw new Error(`进度文件 ${file} 的版本不是 ${ROUTE_PROGRESS_VERSION}`);
  }
  const plan = planOf(value.plan);
  const next = integer(value.next, "next");
  if (next < 0 || next > plan.legs.length) {
    throw new Error(`进度文件 ${file} 的 next ${next} 超出 ${plan.legs.length} 段`);
  }
  return {
    version: ROUTE_PROGRESS_VERSION,
    plan,
    waypoints: list(value.waypoints).map((entry, index) =>
      waypointOf(entry, `waypoints[${index}]`),
    ),
    completed: list(value.completed).map((entry, index) => stringOf(entry, `completed[${index}]`)),
    next,
    ...(value.end === undefined || value.end === null ? {} : { end: waypointOf(value.end, "end") }),
    updatedAt: stringOf(value.updatedAt, "updatedAt"),
  };
}

/** Read and validate one progress snapshot; a missing file is an error, not an empty run. */
export async function readProgress(file: string): Promise<RouteProgress> {
  let body: string;
  try {
    body = await readFile(file, { encoding: "utf8" });
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`没有路线进度文件 ${file}`, { cause: error });
    }
    throw new Error(`读不了路线进度 ${file}:${describeError(error)}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`读不懂路线进度 ${file}:${describeError(error)}`, {
      cause: error,
    });
  }
  return progressOf(parsed, file);
}

/** Replace the progress file atomically, creating its directory when needed. */
export async function writeProgress(file: string, progress: RouteProgress): Promise<void> {
  const body = `${JSON.stringify(progress, null, 2)}\n`;
  const temporary = `${file}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(temporary, body, { encoding: "utf8" });
  await rename(temporary, file);
}
