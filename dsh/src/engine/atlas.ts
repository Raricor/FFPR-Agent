/**
 * The maps seen so far, with their exits and where each leads, kept across runs: in a maze
 * like the Ship Graveyard the player can tell the exits it has been through from the ones it
 * has not, instead of walking back into rooms it already searched (10-20, run 7). Ported from
 * ffpr_agent/ds/atlas.py; control plan §4.10.
 *
 * The structure is the game's own map and is kept across saves; whether a map was visited is
 * save-local (task 57): `visitedNow` holds the maps entered in this save, and AtlasSave keeps a
 * live copy plus save-count snapshots. The player reads both with the `atlas` tool, and
 * look_around marks each exit visited or not.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeError, isMissingFile } from "./errors.ts";
import type { Cell, ObservedMove } from "./nav.ts";
import { isRecord, num, records, text, type Json } from "./values.ts";

/** The "how" of a step the game refused; it is a hint, not a permanent wall (task 73). */
const BLOCKED_HOW = "走不过去";

/** A ride that changes the map without walking onto an exit: a lift, an elevator. */
export interface Ride {
  /** Where the party stood when it pressed. */
  readonly cell: Cell;
  /** The cell pressed (the interact target), kept so the edge can be read back. */
  readonly press: Cell;
  /** Up, Down, Left or Right. */
  readonly dir: string;
  /** The map the recorded ride led to. */
  readonly to: number;
  /** Where the party landed on that map. */
  readonly land: Cell;
  /** The floor it landed on, when the collision reply named one (task 75). */
  readonly landLayer?: number;
  readonly how: string;
}

/** Map ids are strings at the file boundary; a Map keeps Python's insertion order. */
export class Atlas {
  readonly path: string | undefined;
  readonly maps = new Map<string, Json>();
  /** Maps entered in the current save (task 57); the structure in `maps` outlives saves. */
  readonly visitedNow = new Set<string>();
  /** Called once for a map's first entry in this save; AtlasSave persists its live set. */
  onNewVisit?: (mapId: string) => Promise<void>;

  constructor(path?: string) {
    this.path = path;
  }

  /** Constructors cannot await, so loading is this separate step (Python loaded in __init__). */
  static async load(path?: string, signal?: AbortSignal): Promise<Atlas> {
    const atlas = new Atlas(path);
    if (path === undefined) return atlas;
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return atlas;
      signal?.throwIfAborted();
      throw new Error(`读不了地图记录 ${path}:${describeError(error)}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂地图记录 ${path}:${describeError(error)}`, { cause: error });
    }
    if (!isRecord(parsed)) throw new Error(`地图记录 ${path} 不是 JSON 对象`);
    for (const [mapId, entry] of Object.entries(parsed)) {
      if (!isRecord(entry)) throw new Error(`地图记录 ${path} 里的地图 ${mapId} 不是对象`);
      atlas.maps.set(mapId, entry);
    }
    return atlas;
  }

  /** Whether this map was entered in the current save, not merely recorded by an older one. */
  visited(mapId: unknown): boolean {
    return this.visitedNow.has(String(mapId));
  }

  /**
   * Record what the player sees on a map: exits as {"cell", "to", "name"}, chests as
   * {"cell", "name"}. Links found by walking (jumps) are kept.
   */
  async visit(
    mapId: unknown,
    name: string,
    exits: readonly Json[],
    chests: readonly Json[],
  ): Promise<void> {
    const key = String(mapId);
    const isNew = !this.visitedNow.has(key);
    this.visitedNow.add(key);
    const old = this.maps.get(key) ?? {};
    // Task 75: a landing learned by walking the exit survives the next look_around, which
    // rewrites the exit list from the entities each time.
    const previous = records(old.exits);
    const merged = exits.map((exit) => {
      if (!isRecord(exit)) return exit;
      const before = previous.find((candidate) => {
        if (!isRecord(candidate)) return false;
        return sameJson(candidate.cell, exit.cell) && num(candidate.to) === num(exit.to);
      });
      if (before?.land === undefined) return exit;
      return {
        ...exit,
        land: before.land,
        ...(before.landLayer !== undefined ? { landLayer: before.landLayer } : {}),
      };
    });
    const entry: Json = { name: name || "", exits: merged, chests: [...chests] };
    if (Array.isArray(old.links) && old.links.length > 0) entry.links = old.links;
    if (!sameJson(old, entry)) {
      this.maps.set(key, entry);
      await this.save();
    }
    if (isNew) await this.onNewVisit?.(key);
  }

  /**
   * A way between two cells that are not next to each other, found by doing it: a jump stone
   * (interact at one, land on the other). The grid cannot show these.
   */
  async link(
    mapId: unknown,
    start: readonly number[],
    end: readonly number[],
    how: string,
    detail: { readonly kind?: string; readonly toLayer?: number; readonly layer?: number } = {},
  ): Promise<void> {
    const key = String(mapId);
    let entry = this.maps.get(key);
    if (!entry) {
      entry = { name: "", exits: [], chests: [] };
      this.maps.set(key, entry);
    }
    const links = records(entry.links);
    entry.links = links;
    const link: Json = { from: [...start], to: [...end], how };
    if (detail.kind !== undefined) link.kind = detail.kind;
    if (detail.toLayer !== undefined) link.toLayer = detail.toLayer;
    if (detail.layer !== undefined) link.layer = detail.layer;
    if (how === BLOCKED_HOW) {
      // 11-09: a step blocked once may have been a temporary NPC, dialog or story block; keep
      // how often it was hit so the planner can tell a repeatable wall from a stale record.
      const existing = links.find((candidate) => sameStep(candidate, link));
      if (existing !== undefined) {
        existing.count = Math.trunc(num(existing.count) ?? 1) + 1;
        if (text(existing.at) === undefined) existing.at = new Date().toISOString();
        await this.save();
        return;
      }
      link.at = new Date().toISOString();
      link.count = 1;
    }
    if (!links.some((existing) => sameJson(existing, link))) {
      links.push(link);
      await this.save();
    }
  }

  /**
   * Forgets "走不过去" records a walk has proven wrong (task 73). A record without `at` or
   * `count` was written before task 73 and is matched by its step alone.
   */
  async forgetBlocked(mapId: unknown, steps: readonly ObservedMove[]): Promise<void> {
    if (steps.length === 0) return;
    const entry = this.maps.get(String(mapId));
    const links = records(entry?.links);
    if (entry === undefined || links.length === 0) return;
    const kept = links.filter((link) => !steps.some((step) => sameBlockedStep(link, step)));
    if (kept.length === links.length) return;
    entry.links = kept;
    await this.save();
  }

  /**
   * Task 75: where an exit dropped the party, so the next plan can tell which block of the
   * destination it can walk in. Keeps the exit's other fields; false when the exit is not in
   * the record yet (the next look_around adds it).
   */
  async landExit(
    mapId: unknown,
    exitCell: readonly number[],
    toMap: number,
    landing: readonly number[],
    layer?: number | null,
  ): Promise<boolean> {
    const entry = this.maps.get(String(mapId));
    if (entry === undefined) return false;
    const exit = records(entry.exits).find(
      (candidate) => sameJson(candidate.cell, exitCell) && num(candidate.to) === toMap,
    );
    if (exit === undefined) return false;
    const land = [...landing];
    const landLayer = layer === undefined || layer === null ? undefined : Math.trunc(layer);
    if (sameJson(exit.land, land) && (exit.landLayer ?? undefined) === landLayer) return false;
    exit.land = land;
    if (landLayer === undefined) delete exit.landLayer;
    else exit.landLayer = landLayer;
    await this.save();
    return true;
  }

  /**
   * A map change made by pressing something, not by stepping onto an exit: a lift. The edge
   * is kept in `links` (so a later `visit` keeps it and the Python atlas sees it too) but it
   * is not a same-map move; `moves` leaves it out.
   *
   * Identity is from + press + dir + destination, the landing cell may change when the game
   * puts the party down elsewhere; repeat rides update that one edge instead of adding more
   * (task 71).
   */
  async ride(
    mapId: unknown,
    from: readonly number[],
    press: readonly number[],
    dir: string,
    toMap: number,
    landing: readonly number[],
    how = "坐一趟",
    landLayer?: number | null,
  ): Promise<boolean> {
    const key = String(mapId);
    let entry = this.maps.get(key);
    if (!entry) {
      entry = { name: "", exits: [], chests: [] };
      this.maps.set(key, entry);
    }
    const links = records(entry.links);
    entry.links = links;
    const ride: Json = {
      from: [...from],
      to: [...landing],
      how,
      kind: "ride",
      press: [...press],
      dir,
      toMap,
    };
    if (landLayer !== undefined && landLayer !== null) ride.landLayer = Math.trunc(landLayer);
    const index = links.findIndex((existing) => sameRide(existing, ride));
    if (index >= 0 && sameJson(links[index], ride)) return false;
    if (index >= 0) links[index] = ride;
    else links.push(ride);
    await this.save();
    return true;
  }

  /** The ride edges recorded on a map, in the order they were found. */
  rides(mapId: unknown): Ride[] {
    const entry = this.maps.get(String(mapId));
    return records(entry?.links).flatMap((link): Ride[] => {
      if (text(link.kind) !== "ride") return [];
      const cell = cellTuple(link.from);
      const press = cellTuple(link.press);
      const land = cellTuple(link.to);
      const to = num(link.toMap);
      const dir = text(link.dir) ?? "";
      if (cell === null || press === null || land === null || to === undefined) return [];
      if (!["Up", "Down", "Left", "Right"].includes(dir)) return [];
      const landLayer = num(link.landLayer);
      return [
        {
          cell,
          press,
          dir,
          to: Math.trunc(to),
          land,
          ...(landLayer === undefined ? {} : { landLayer: Math.trunc(landLayer) }),
          how: text(link.how) ?? "坐一趟",
        },
      ];
    });
  }

  /**
   * Ways walked on a map: conveyors, falls and layer changes, as directed edges for the next
   * plan. Links from before task 44 only carry `how`; callers read it as the kind. Rides are
   * cross-map edges and must not become same-map moves (task 71).
   */
  moves(mapId: unknown): ObservedMove[] {
    const entry = this.maps.get(String(mapId));
    return records(entry?.links).flatMap((link): ObservedMove[] => {
      if (text(link.kind) === "ride") return [];
      const from = cellTuple(link.from);
      const to = cellTuple(link.to);
      if (from === null || to === null) return [];
      const how = text(link.how) ?? "";
      const move: ObservedMove = {
        from,
        to,
        how,
        ...(typeof link.kind === "string" ? { kind: link.kind } : {}),
        ...(typeof link.toLayer === "number" ? { toLayer: Math.trunc(link.toLayer) } : {}),
        ...(typeof link.layer === "number" ? { layer: Math.trunc(link.layer) } : {}),
        ...(how === BLOCKED_HOW ? { count: Math.max(1, Math.trunc(num(link.count) ?? 1)) } : {}),
        ...(how === BLOCKED_HOW && typeof link.at === "string" ? { at: link.at } : {}),
      };
      return [move];
    });
  }

  async save(): Promise<void> {
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true });
    const data: Record<string, Json> = {};
    for (const [mapId, entry] of this.maps) data[mapId] = entry;
    try {
      await writeFile(this.path, JSON.stringify(data, null, 1), "utf8");
    } catch (error) {
      throw new Error(`写不了地图记录 ${this.path}:${describeError(error)}`, { cause: error });
    }
  }

  mark(to: unknown): string {
    if (String(to) === "1") return "(世界地图)";
    return this.visited(to) ? "(去过)" : "(没去过)";
  }

  /** The walkable links found on a map (jumps, conveyor rides, lifts), one phrase each. */
  links(mapId: unknown): string {
    const entry = this.maps.get(String(mapId));
    return records(entry?.links)
      .map((link) => {
        if (text(link.kind) === "ride") {
          const dir = text(link.dir) ?? "?";
          return (
            `在 ${tupleText(link.from)} ${String(link.how)} 面朝${dir}` +
            ` 到 地图 ${String(link.toMap)} ${tupleText(link.to)}`
          );
        }
        return sameJson(link.from, link.to)
          ? `在 ${tupleText(link.from)} ${String(link.how)}`
          : `在 ${tupleText(link.from)} ${String(link.how)} 到 ${tupleText(link.to)}`;
      })
      .join("、");
  }

  /**
   * Every map seen, its exits with where they lead and whether that map was visited; the
   * current map first. World maps are left out (their exits are towns).
   */
  describe(around: unknown = null, limit = 30): string {
    const target = scalarText(around);
    const ids = [...this.maps.keys()].sort((left, right) => {
      const near = Number(left !== target) - Number(right !== target);
      return near !== 0 ? near : left < right ? -1 : left > right ? 1 : 0;
    });
    const lines: string[] = [];
    for (const mapId of ids.slice(0, limit)) {
      const entry = this.maps.get(mapId);
      if (!entry || mapId === "1") continue;
      const here = mapId === target ? "(你在这里)" : "";
      const exits = records(entry.exits)
        .map(
          (exit) =>
            `${tupleText(exit.cell)}→地图 ${String(exit.to)} ${text(exit.name) ?? ""}${this.mark(exit.to)}`,
        )
        .join("、");
      const chests = records(entry.chests)
        .map((chest) => `${tupleText(chest.cell)} ${text(chest.name) ?? ""}`)
        .join("、");
      lines.push(`地图 ${mapId} ${text(entry.name) ?? ""}${here}:出口 ${exits || "无"}`);
      if (chests) lines.push(`    宝箱 ${chests}`);
      const links = this.links(mapId);
      if (links) lines.push(`    走法 ${links}`);
    }
    return lines.join("\n") || "还没有记录任何地图";
  }
}

function cellTuple(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

/** Python's tuple repr: [22, 15] prints as "(22, 15)". */
function tupleText(value: unknown): string {
  if (!Array.isArray(value)) return String(value);
  return `(${value.map((item) => String(item)).join(", ")})`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Whether two links are the same step, ignoring the task 73 `at` and `count`. */
function sameStep(left: Json, right: Json): boolean {
  return (
    text(left.how) === BLOCKED_HOW &&
    text(right.how) === BLOCKED_HOW &&
    sameJson(left.from, right.from) &&
    sameJson(left.to, right.to) &&
    num(left.layer) === num(right.layer) &&
    text(left.kind) === text(right.kind) &&
    num(left.toLayer) === num(right.toLayer)
  );
}

/** Whether a stored link is the blocked step `step` the walk proved wrong. */
function sameBlockedStep(link: Json, step: ObservedMove): boolean {
  return (
    text(link.how) === BLOCKED_HOW &&
    sameJson(link.from, step.from) &&
    sameJson(link.to, step.to) &&
    num(link.layer) === step.layer &&
    text(link.kind) === step.kind &&
    num(link.toLayer) === step.toLayer
  );
}

/** Whether two links are the same ride (the landing cell is not part of the identity). */
function sameRide(left: Json, right: Json): boolean {
  return (
    text(left.kind) === "ride" &&
    text(right.kind) === "ride" &&
    sameJson(left.from, right.from) &&
    sameJson(left.press, right.press) &&
    text(left.dir) === text(right.dir) &&
    num(left.toMap) === num(right.toMap)
  );
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value) || "";
}
