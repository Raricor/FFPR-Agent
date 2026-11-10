/**
 * The one stage plan kept per game (task 97, 11-10): `.deps/ds/stage-<game>.json`, as
 * `{target, plan, createdAt, status}`. The web restart and a new session read the same file,
 * so a plan written before lunch still gates the afternoon walk.
 *
 * The store holds one plan, not a history: a new destination replaces the previous unfinished
 * one. A completed plan stays readable (the sidebar and the next plan_stage can say so) but
 * does not gate movement.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeError, isMissingFile } from "../errors.ts";
import { isRecord, list, num, text } from "../values.ts";
import { readStagePlan } from "./plan.ts";
import type { StageBossTable, StagePlan, StageTarget } from "./types.ts";

export type StageStatus = "planned" | "departed" | "completed";

export interface StagePlanRecord {
  readonly target: StageTarget;
  readonly plan: StagePlan;
  readonly createdAt: string;
  readonly status: StageStatus;
  /**
   * Where the plan was written (a town map and its name). The turn-back refusal lists a way
   * back to it; older files may omit both.
   */
  readonly startMapId?: number | null;
  readonly startLabel?: string;
  /** Task 106: the boss table written when the plan was made. */
  readonly boss?: StageBossTable;
  /** Task 106: why no boss table was written; the plan still exists and can be walked. */
  readonly bossError?: string;
}

function targetOf(value: unknown): StageTarget {
  if (!isRecord(value)) throw new Error("阶段计划里的 target 不是对象");
  const mapId = num(value.mapId);
  const areaName = text(value.areaName);
  const label = text(value.label);
  return {
    mapId: mapId === undefined ? null : Math.trunc(mapId),
    areaName: areaName === undefined || areaName.trim() === "" ? null : areaName,
    label: label ?? areaName ?? (mapId === undefined ? "" : `地图 ${Math.trunc(mapId)}`),
  };
}

function statusOf(value: unknown): StageStatus {
  return value === "departed" || value === "completed" ? value : "planned";
}

function strings(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === "string" && item !== "");
}

function numbers(value: unknown): number[] {
  return list(value).flatMap((item) => {
    const number = num(item);
    return number === undefined ? [] : [Math.trunc(number)];
  });
}

function partiesOf(value: unknown): StageBossTable["party"] {
  if (!Array.isArray(value)) return undefined;
  const party = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const name = text(item.name) ?? "";
    const job = text(item.job) ?? "";
    const level = num(item.level);
    if (name === "" || level === undefined) return [];
    return [{ name, job, level: Math.trunc(level) }];
  });
  return party.length === 0 ? undefined : party;
}

/** Task 106: the boss table stored beside the plan; a malformed table drops the field only. */
export function readStageBoss(value: unknown): StageBossTable | null {
  if (!isRecord(value) || !isRecord(value.table)) return null;
  const names = strings(value.names);
  if (names.length === 0) return null;
  const mapId = num(value.mapId);
  const walkerNotes = text(value.walkerNotes);
  const askUp = text(value.askUp);
  const party = partiesOf(value.party);
  return {
    names,
    bookIds: numbers(value.bookIds),
    monsterIds: numbers(value.monsterIds),
    mapId: mapId === undefined ? null : Math.trunc(mapId),
    table: value.table,
    at: text(value.at) ?? new Date(0).toISOString(),
    result: text(value.result) ?? "出发前写好的首领表",
    ...(walkerNotes === undefined || walkerNotes === "" ? {} : { walkerNotes }),
    ...(askUp === undefined || askUp === "" ? {} : { askUp }),
    ...(party === undefined ? {} : { party }),
  };
}

/** Read the saved plan; a missing file is null, a malformed one is a Chinese error. */
export function readStageRecord(value: unknown): StagePlanRecord {
  if (!isRecord(value)) throw new Error("阶段计划文件不是 JSON 对象");
  const createdAt = text(value.createdAt) ?? new Date(0).toISOString();
  const startMapId = num(value.startMapId);
  const startLabel = text(value.startLabel);
  const boss = readStageBoss(value.boss);
  const bossError = text(value.bossError);
  return {
    target: targetOf(value.target),
    plan: readStagePlan(value.plan),
    createdAt,
    status: statusOf(value.status),
    ...(startMapId === undefined ? {} : { startMapId: Math.trunc(startMapId) }),
    ...(startLabel === undefined || startLabel.trim() === "" ? {} : { startLabel }),
    ...(boss === null ? {} : { boss }),
    ...(bossError === undefined || bossError === "" ? {} : { bossError }),
  };
}

export class StagePlanStore {
  readonly path: string | undefined;
  current: StagePlanRecord | null = null;

  constructor(path?: string) {
    this.path = path;
  }

  static async load(path?: string, signal?: AbortSignal): Promise<StagePlanStore> {
    const store = new StagePlanStore(path);
    if (path === undefined) return store;
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return store;
      signal?.throwIfAborted();
      throw new Error(`读不了阶段计划 ${path}:${describeError(error)}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂阶段计划 ${path}:${describeError(error)}`, { cause: error });
    }
    store.current = readStageRecord(parsed);
    return store;
  }

  /** Re-read the file after a scout restored it (task 105). */
  async reload(signal?: AbortSignal): Promise<void> {
    const fresh = await StagePlanStore.load(this.path, signal);
    this.current = fresh.current;
  }

  /** Write the plan; an unset path keeps it in memory (tests and previews). */
  async save(record: StagePlanRecord): Promise<void> {
    this.current = record;
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(this.path, JSON.stringify(record, null, 1), "utf8");
    } catch (error) {
      throw new Error(`写不了阶段计划 ${this.path}:${describeError(error)}`, { cause: error });
    }
  }

  /** Mark the saved plan so the departure check runs once, not before every step. */
  async setStatus(status: StageStatus): Promise<StagePlanRecord | null> {
    const current = this.current;
    if (current === null || current.status === status) return current;
    const next: StagePlanRecord = { ...current, status };
    await this.save(next);
    return next;
  }
}
