/**
 * The `route` tool's input and bridge readings (task 89): turn the model's stops into the
 * ordered waypoints the executor wants, and read bridge 0.14.3's `timer`/`gameover` fields.
 *
 * Parsing is deliberately separate from Game: a bad stop is a Chinese tool error before a key
 * is pressed, and the target spelling stays the one `go` already accepts.
 */

import type { Atlas } from "../atlas.ts";
import type { Cell } from "../nav.ts";
import { findMap, mapName } from "../skills/travel.ts";
import { isRecord, num, text } from "../values.ts";
import type { RouteTimer } from "./execute.ts";
import type { GrindUntil, Waypoint, WaypointKind } from "./types.ts";

/** Task 89: estimated battle length for one road encounter, until Config overrides it. */
export const DEFAULT_ROUTE_BATTLE_SECONDS = 45;
/**
 * Task 89 estimate: one road encounter per this many walking cells. This is a rough figure
 * from the 11-10 escape (376 s of fighting across a long route), not a measurement; the timer
 * check only needs it to be conservative enough to skip a chest instead of missing the exit.
 */
export const ROUTE_ENCOUNTER_CELLS = 30;

export type RouteAction = "move" | "open" | "save" | "talk" | "grind";

export interface RouteStopInput {
  readonly to: unknown;
  readonly action: RouteAction;
  readonly optional: boolean;
  /** Task 100: only a grind stop has one. */
  readonly until?: GrindUntil;
}

/**
 * `go`'s coordinate spellings (task 58/66): [x, y] or "x,y", "x y", "[x, y]", "(x, y)".
 * Kept here so `route` and `go` accept exactly the same strings.
 */
export function targetCell(value: unknown): Cell | null {
  const cell = cellOf(value);
  if (cell !== null) return cell;
  if (typeof value !== "string") return null;
  const trimmed = value
    .trim()
    .replace(/^[[(]\s*/u, "")
    .replace(/\s*[\])]$/u, "");
  const match = /^(-?\d+)\s*(?:,|\s)\s*(-?\d+)$/u.exec(trimmed);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2])];
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

/** `"62:12,8"`, `"地图 62:12,8"`: a map id with a cell, the one spelling `go` does not take. */
function mapAndCell(value: string): { map: number; cell: Cell } | null {
  const match = /^(?:地图\s*)?(\d+)\s*:\s*(.+)$/u.exec(value.trim());
  if (match === null) return null;
  const map = Number(match[1]);
  const cell = targetCell(match[2]);
  if (!Number.isFinite(map) || cell === null) return null;
  return { map: Math.trunc(map), cell };
}

function actionOf(value: unknown, where: string): RouteAction {
  const action = text(value);
  if (action === undefined || action === "") return "move";
  if (action === "open" || action === "save" || action === "talk" || action === "grind") {
    return action;
  }
  throw new Error(`${where} 的 do 只能是 open、save、talk 或 grind`);
}

function nameList(value: unknown, where: string, allowNumbers: boolean): (string | number)[] {
  if (!Array.isArray(value)) throw new Error(`${where} 要写成数组`);
  if (value.length === 0) throw new Error(`${where} 不能是空数组`);
  return value.map((entry, index) => {
    if (typeof entry === "string" && entry.trim() !== "") return entry.trim();
    if (allowNumbers && typeof entry === "number" && Number.isFinite(entry)) {
      return Math.trunc(entry);
    }
    throw new Error(`${where}[${index}] 要写怪名、图鉴号或青魔法名`);
  });
}

/**
 * Task 100: `until` is the stop list of one grind. The route tool refuses an empty one here,
 * before the executor walks anywhere; the stage checker repeats the same rule.
 */
export function parseGrindUntil(value: unknown, where: string): GrindUntil {
  if (!isRecord(value)) throw new Error(`${where} 的 until 不是对象`);
  const bestiary =
    value.bestiary === undefined
      ? undefined
      : nameList(value.bestiary, `${where} 的 until.bestiary`, true);
  const blueMagic =
    value.blueMagic === undefined
      ? undefined
      : nameList(value.blueMagic, `${where} 的 until.blueMagic`, false).map((name) => String(name));
  const battles =
    value.battles === undefined
      ? undefined
      : typeof value.battles === "number" && Number.isInteger(value.battles) && value.battles > 0
        ? value.battles
        : (() => {
            throw new Error(`${where} 的 until.battles 要是正整数`);
          })();
  const minutes =
    value.minutes === undefined
      ? undefined
      : typeof value.minutes === "number" && Number.isFinite(value.minutes) && value.minutes > 0
        ? value.minutes
        : (() => {
            throw new Error(`${where} 的 until.minutes 要是正数`);
          })();
  if (
    bestiary === undefined &&
    blueMagic === undefined &&
    battles === undefined &&
    minutes === undefined
  ) {
    throw new Error(`${where} 的 until 至少要写 bestiary、blueMagic、battles、minutes 中的一项`);
  }
  return {
    ...(bestiary === undefined ? {} : { bestiary }),
    ...(blueMagic === undefined ? {} : { blueMagic }),
    ...(battles === undefined ? {} : { battles }),
    ...(minutes === undefined ? {} : { minutes }),
  };
}

/** One stops entry; `optional` defaults to true for an open (a chest) and false otherwise. */
export function parseRouteStop(value: unknown, where: string): RouteStopInput {
  if (!isRecord(value)) throw new Error(`${where} 不是对象`);
  if (value.to === undefined || value.to === null) throw new Error(`${where} 缺少 to`);
  const action = actionOf(value.do, where);
  if (value.optional !== undefined && typeof value.optional !== "boolean") {
    throw new Error(`${where} 的 optional 不是布尔值`);
  }
  const until =
    action === "grind"
      ? parseGrindUntil(value.until, where)
      : value.until === undefined
        ? undefined
        : (() => {
            throw new Error(`${where} 只有 do: grind 才能写 until`);
          })();
  return {
    to: value.to,
    action,
    optional: value.optional ?? action === "open",
    ...(until === undefined ? {} : { until }),
  };
}

/** `end` is a plain target like `go`'s `to`; it is never optional. */
export function parseRouteEnd(value: unknown): RouteStopInput | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" && typeof value !== "number" && !Array.isArray(value)) {
    throw new Error("end 要写地图号、地图名或坐标");
  }
  return { to: value, action: "move", optional: false };
}

/** Resolve one parsed stop to a waypoint; a bare cell means the map the party is on. */
export function resolveRouteStop(
  stop: RouteStopInput,
  id: string,
  startMap: number,
  atlas: Atlas,
  isEnd: boolean,
): Waypoint {
  const direct = typeof stop.to === "string" ? mapAndCell(stop.to) : null;
  const cell = direct?.cell ?? targetCell(stop.to);
  let map: number;
  if (direct !== null) {
    map = direct.map;
  } else if (cell !== null) {
    map = startMap;
  } else {
    const choice = findMap(atlas, stop.to);
    if (!choice.ok) throw new Error(choice.error);
    map = choice.mapId;
  }
  const kind: WaypointKind =
    stop.action === "open"
      ? "chest"
      : stop.action === "save"
        ? "save"
        : stop.action === "talk"
          ? "story"
          : stop.action === "grind"
            ? "grind"
            : "move";
  const place = mapName(atlas, map) || `地图 ${map}`;
  const label = isEnd
    ? `终点 ${place}${cell === null ? "" : ` ${cellText(cell)}`}`
    : labelOf(stop.action, place, cell);
  return {
    id,
    kind,
    map,
    cell,
    label,
    optional: isEnd ? false : stop.optional,
    ...(stop.until === undefined ? {} : { until: stop.until }),
    reach: stop.action === "open" || stop.action === "talk" ? "map" : "cell",
  };
}

function labelOf(action: RouteAction, place: string, cell: Cell | null): string {
  const at = cell === null ? place : `${place} ${cellText(cell)}`;
  if (action === "open") return `宝箱 ${at}`;
  if (action === "save") return `存档 ${at}`;
  if (action === "talk") return `调查 ${at}`;
  if (action === "grind") return `刷怪 ${at}`;
  return `移动 ${at}`;
}

function cellText(cell: Cell): string {
  return `(${cell[0]},${cell[1]})`;
}

/**
 * Bridge 0.14.3's timer object. An older bridge has no field at all, so this returns null and
 * every countdown check is skipped rather than guessing a deadline.
 */
export function parseRouteTimer(value: unknown): RouteTimer | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return null;
  const seconds = num(value.seconds);
  return {
    active: value.active === true,
    seconds: seconds === undefined || seconds < 0 ? null : seconds,
  };
}

/** `gameover.open` is a popup waiting for a key; report it and never press one. */
export function parseGameover(value: unknown): string | null {
  if (!isRecord(value) || value.open !== true) return null;
  const prompt = text(value.prompt);
  const named =
    prompt === "continue" ? "继续" : prompt === "to-title" ? "回到标题" : (prompt ?? "没有写按钮");
  const cursor = num(value.cursor);
  return (
    `游戏结束了，弹窗是「${named}」` +
    (cursor === undefined ? "" : `，光标在第 ${Math.trunc(cursor)} 项`) +
    ";没有按键"
  );
}
