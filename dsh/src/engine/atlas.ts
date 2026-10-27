/**
 * The maps seen so far, with their exits and where each leads, kept across runs: in a maze
 * like the Ship Graveyard the player can tell the exits it has been through from the ones it
 * has not, instead of walking back into rooms it already searched (10-20, run 7). Ported from
 * ffpr_agent/ds/atlas.py; control plan §4.10.
 *
 * The game side records a map whenever the player is on it; the player reads it with the
 * `atlas` tool, and look_around marks each exit visited or not.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeError, isMissingFile } from "./errors.ts";
import { isRecord, records, text, type Json } from "./values.ts";

/** Map ids are strings at the file boundary; a Map keeps Python's insertion order. */
export class Atlas {
  readonly path: string | undefined;
  readonly maps = new Map<string, Json>();

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

  visited(mapId: unknown): boolean {
    return this.maps.has(String(mapId));
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
    const old = this.maps.get(key) ?? {};
    const entry: Json = { name: name || "", exits: [...exits], chests: [...chests] };
    if (Array.isArray(old.links) && old.links.length > 0) entry.links = old.links;
    if (sameJson(old, entry)) return;
    this.maps.set(key, entry);
    await this.save();
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
  ): Promise<void> {
    const key = String(mapId);
    let entry = this.maps.get(key);
    if (!entry) {
      entry = { name: "", exits: [], chests: [] };
      this.maps.set(key, entry);
    }
    const links = Array.isArray(entry.links) ? entry.links : [];
    if (!Array.isArray(entry.links)) entry.links = links;
    const link: Json = { from: [...start], to: [...end], how };
    if (!links.some((existing) => sameJson(existing, link))) {
      links.push(link);
      await this.save();
    }
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

  /** The walkable links found on a map (jumps, conveyor rides), one phrase each. */
  links(mapId: unknown): string {
    const entry = this.maps.get(String(mapId));
    return records(entry?.links)
      .map((link) => `在 ${tupleText(link.from)} ${String(link.how)} 到 ${tupleText(link.to)}`)
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

/** Python's tuple repr: [22, 15] prints as "(22, 15)". */
function tupleText(value: unknown): string {
  if (!Array.isArray(value)) return String(value);
  return `(${value.map((item) => String(item)).join(", ")})`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value) || "";
}
