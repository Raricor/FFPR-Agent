/**
 * The segment-plan file (task 137, 11-11): one current `SegmentPlan` and up to five history
 * versions per route-book section, kept in `.deps/ds/segment-plan-<game>.json`. The path is
 * supplied by the caller; this module only reads and writes it asynchronously.
 *
 * A missing file is an empty store. A malformed file raises a Chinese error instead of a
 * TypeError; a single bad plan inside an otherwise readable file is skipped and recorded in
 * `problems`, so one broken version does not lose the current plan.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeError, isMissingFile } from "../errors.ts";
import { DEPS } from "../paths.ts";
import { isRecord } from "../values.ts";
import type { SegmentPlan, SegmentProgress } from "./types.ts";

/** How many old versions each section keeps (the current one is also in the history). */
export const SEGMENT_PLAN_HISTORY_LIMIT = 5;

/** The default location task 139 will pass; the caller may pass any path instead. */
export function segmentPlanPath(game: string, deps = DEPS): string {
  return join(deps, "ds", `segment-plan-${game}.json`);
}

/** The live `SegmentProgress` file (tasks 145 writes, 147 reads). */
export function segmentProgressPath(game: string, deps = DEPS): string {
  return join(deps, "ds", `segment-progress-${game}.json`);
}

interface SegmentPlanFile {
  readonly game: string;
  readonly current: SegmentPlan | null;
  readonly history: Record<string, readonly SegmentPlan[]>;
}

function planOf(value: unknown): SegmentPlan | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.section !== "string" || value.section.trim() === "") return null;
  if (!Array.isArray(value.stations)) return null;
  if (!Array.isArray(value.battle) || !Array.isArray(value.bosses)) return null;
  if (!Array.isArray(value.turnBack)) return null;
  return value as unknown as SegmentPlan;
}

function historyOf(value: unknown, problems: string[]): Map<string, SegmentPlan[]> {
  const out = new Map<string, SegmentPlan[]>();
  if (value === undefined) return out;
  if (!isRecord(value)) {
    problems.push("段计划文件里的 history 不是对象,已忽略");
    return out;
  }
  for (const [section, raw] of Object.entries(value)) {
    if (!Array.isArray(raw)) {
      problems.push(`段计划文件里「${section}」的历史不是数组,已忽略`);
      continue;
    }
    const plans = raw.flatMap((entry, index) => {
      const plan = planOf(entry);
      if (plan === null) {
        problems.push(`段计划文件里「${section}」第 ${index + 1} 版格式不对,已跳过`);
        return [];
      }
      return [plan];
    });
    out.set(section, plans.slice(-SEGMENT_PLAN_HISTORY_LIMIT));
  }
  return out;
}

export class SegmentPlanStore {
  readonly game: string;
  readonly path: string | undefined;
  /** Non-fatal shape problems found while loading; empty for a clean file. */
  readonly problems: string[] = [];
  current: SegmentPlan | null = null;
  private readonly versions = new Map<string, SegmentPlan[]>();

  constructor(game: string, path?: string) {
    this.game = game;
    this.path = path;
  }

  static async load(game: string, path?: string, signal?: AbortSignal): Promise<SegmentPlanStore> {
    const store = new SegmentPlanStore(game, path);
    if (path === undefined) return store;
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return store;
      signal?.throwIfAborted();
      throw new Error(`读不了段计划 ${path}:${describeError(error)}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂段计划 ${path}:${describeError(error)}`, { cause: error });
    }
    if (!isRecord(parsed)) throw new Error(`段计划 ${path} 不是 JSON 对象`);
    if (parsed.current !== undefined && parsed.current !== null) {
      const current = planOf(parsed.current);
      if (current === null) {
        store.problems.push("段计划文件里的 current 格式不对,已忽略");
      } else {
        store.current = current;
      }
    }
    for (const [section, plans] of historyOf(parsed.history, store.problems)) {
      store.versions.set(section, plans);
    }
    return store;
  }

  /** All kept versions of one section, oldest first. */
  historyFor(section: string): readonly SegmentPlan[] {
    return [...(this.versions.get(section) ?? [])];
  }

  /** Make `plan` current and append it to its section's history, keeping five versions. */
  async save(plan: SegmentPlan): Promise<void> {
    this.current = plan;
    const versions = this.versions.get(plan.section) ?? [];
    this.versions.set(plan.section, [...versions, plan].slice(-SEGMENT_PLAN_HISTORY_LIMIT));
    await this.write();
  }

  private async write(): Promise<void> {
    if (this.path === undefined) return;
    const file: SegmentPlanFile = {
      game: this.game,
      current: this.current,
      history: Object.fromEntries(this.versions),
    };
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    } catch (error) {
      throw new Error(`写不了段计划 ${this.path}:${describeError(error)}`, { cause: error });
    }
  }
}

/** Read a plan file without constructing the store, for callers that only need the current. */
export async function readSegmentPlan(
  game: string,
  path?: string,
  signal?: AbortSignal,
): Promise<SegmentPlan | null> {
  const store = await SegmentPlanStore.load(game, path, signal);
  return store.current;
}

/**
 * The live progress file (task 145). A missing file is `null`; a malformed one raises a Chinese
 * error so the executor can warn and keep running. The caller may pass any path (tests use a
 * temporary directory); `undefined` means "not recording".
 */
export async function readSegmentProgress(
  path: string | undefined,
  signal?: AbortSignal,
): Promise<SegmentProgress | null> {
  if (path === undefined) return null;
  let body: string;
  try {
    body = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (isMissingFile(error)) return null;
    signal?.throwIfAborted();
    throw new Error(`读不了段进度 ${path}:${describeError(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`读不懂段进度 ${path}:${describeError(error)}`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`段进度 ${path} 不是 JSON 对象`);
  if (typeof parsed.section !== "string" || typeof parsed.revision !== "number") {
    throw new Error(`段进度 ${path} 缺少 section 或 revision`);
  }
  if (!Array.isArray(parsed.stations)) throw new Error(`段进度 ${path} 的 stations 不是数组`);
  return parsed as unknown as SegmentProgress;
}

/** Write one progress snapshot asynchronously; the executor catches and only warns on failure. */
export async function writeSegmentProgress(
  path: string | undefined,
  progress: SegmentProgress,
): Promise<void> {
  if (path === undefined) return;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new Error(`写不了段进度 ${path}:${describeError(error)}`, { cause: error });
  }
}
