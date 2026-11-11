/**
 * The chapter draft and the accepted chapter plan (task 151, 11-11). A chapter rule file can
 * cover hundreds of stations, so the model writes one segment at a time into
 * `.deps/ds/chapter-draft-<game>.json`; only a plan that passes the whole-chapter check is saved
 * to `.deps/ds/chapter-plan-<game>.json`, keeping up to five versions per chapter.
 *
 * The paths are supplied by the caller (the same convention as `store.ts`). Reads and writes are
 * asynchronous; a missing file is an empty store, while a malformed file raises a Chinese error.
 * The draft tolerates one broken segment so a single bad entry does not lose the rest.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeError, isMissingFile } from "../errors.ts";
import { DEPS } from "../paths.ts";
import { isRecord } from "../values.ts";
import type {
  ChapterFallback,
  ChapterGrowthTarget,
  ChapterPlan,
  ChapterSkipped,
} from "./chapter-types.ts";
import type { SegmentPlan } from "./types.ts";

/** How many old versions of each chapter's plan are kept (the current one is included). */
export const CHAPTER_PLAN_HISTORY_LIMIT = 5;

export function chapterDraftPath(game: string, deps = DEPS): string {
  return join(deps, "ds", `chapter-draft-${game}.json`);
}

export function chapterPlanPath(game: string, deps = DEPS): string {
  return join(deps, "ds", `chapter-plan-${game}.json`);
}

/** The fields `chapter_draft_meta` fills in before the segments are assembled. */
export interface ChapterDraftMeta {
  readonly chapter: number;
  readonly goal: string;
  readonly growth: readonly ChapterGrowthTarget[];
  readonly fallback: ChapterFallback;
  readonly skipped?: readonly ChapterSkipped[];
  readonly notes?: string;
}

/** One chapter draft on disk; `chapter`, `goal` and `fallback` are null until meta is written. */
export interface ChapterDraft {
  readonly version: 1;
  readonly game: string;
  readonly chapter: number | null;
  readonly goal: string | null;
  readonly growth: readonly ChapterGrowthTarget[];
  readonly fallback: ChapterFallback | null;
  readonly skipped: readonly ChapterSkipped[];
  readonly notes?: string;
  /** Station order index → the segment the model drafted for it. */
  readonly segments: Readonly<Record<string, SegmentPlan>>;
}

export interface ChapterDraftAssembly {
  readonly plan: ChapterPlan | null;
  /** Chinese, one line per missing or malformed part; empty means `plan` is usable. */
  readonly problems: readonly string[];
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function draftPlanOf(value: unknown): SegmentPlan | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.section !== "string" || value.section.trim() === "") return null;
  if (!Array.isArray(value.stations)) return null;
  if (!Array.isArray(value.battle) || !Array.isArray(value.bosses)) return null;
  if (!Array.isArray(value.turnBack)) return null;
  return value as unknown as SegmentPlan;
}

function chapterPlanOf(value: unknown): ChapterPlan | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (!isPositiveInteger(value.chapter)) return null;
  if (typeof value.goal !== "string" || value.goal.trim() === "") return null;
  if (!Array.isArray(value.segments)) return null;
  if (!Array.isArray(value.growth)) return null;
  if (!isRecord(value.fallback)) return null;
  if (value.skipped !== undefined && !Array.isArray(value.skipped)) return null;
  if (value.notes !== undefined && typeof value.notes !== "string") return null;
  return value as unknown as ChapterPlan;
}

export class ChapterDraftStore {
  readonly game: string;
  readonly path: string | undefined;
  /** Non-fatal shape problems found while loading; empty for a clean file. */
  readonly problems: string[] = [];
  chapter: number | null = null;
  goal: string | null = null;
  growth: readonly ChapterGrowthTarget[] = [];
  fallback: ChapterFallback | null = null;
  skipped: readonly ChapterSkipped[] = [];
  notes: string | undefined;
  private readonly segments = new Map<number, SegmentPlan>();

  constructor(game: string, path?: string) {
    this.game = game;
    this.path = path;
  }

  static async load(game: string, path?: string, signal?: AbortSignal): Promise<ChapterDraftStore> {
    const store = new ChapterDraftStore(game, path);
    if (path === undefined) return store;
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return store;
      signal?.throwIfAborted();
      throw new Error(`读不了章草稿 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂章草稿 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    if (!isRecord(parsed)) throw new Error(`章草稿 ${path} 不是 JSON 对象`);
    if (parsed.version !== undefined && parsed.version !== 1) {
      throw new Error(`章草稿 ${path} 的 version 要是 1`);
    }
    if (parsed.game !== undefined && typeof parsed.game !== "string") {
      throw new Error(`章草稿 ${path} 的 game 不是字符串`);
    }
    if (parsed.chapter !== undefined && parsed.chapter !== null) {
      if (!isPositiveInteger(parsed.chapter)) {
        throw new Error(`章草稿 ${path} 的 chapter 不是正整数`);
      }
      store.chapter = parsed.chapter;
    }
    if (parsed.goal !== undefined && parsed.goal !== null) {
      if (typeof parsed.goal !== "string") {
        throw new Error(`章草稿 ${path} 的 goal 不是字符串`);
      }
      store.goal = parsed.goal;
    }
    if (parsed.growth !== undefined) {
      if (!Array.isArray(parsed.growth)) {
        throw new Error(`章草稿 ${path} 的 growth 不是数组`);
      }
      store.growth = parsed.growth as readonly ChapterGrowthTarget[];
    }
    if (parsed.fallback !== undefined && parsed.fallback !== null) {
      if (!isRecord(parsed.fallback)) {
        throw new Error(`章草稿 ${path} 的 fallback 不是对象`);
      }
      store.fallback = parsed.fallback as unknown as ChapterFallback;
    }
    if (parsed.skipped !== undefined) {
      if (!Array.isArray(parsed.skipped)) {
        throw new Error(`章草稿 ${path} 的 skipped 不是数组`);
      }
      store.skipped = parsed.skipped as readonly ChapterSkipped[];
    }
    if (parsed.notes !== undefined) {
      if (typeof parsed.notes !== "string") {
        throw new Error(`章草稿 ${path} 的 notes 不是字符串`);
      }
      store.notes = parsed.notes;
    }
    if (parsed.segments !== undefined) {
      if (!isRecord(parsed.segments)) {
        throw new Error(`章草稿 ${path} 的 segments 不是对象`);
      }
      for (const [key, raw] of Object.entries(parsed.segments)) {
        if (!/^\d+$/u.test(key)) {
          store.problems.push(`章草稿里的段下标「${key}」不是整数,已跳过`);
          continue;
        }
        const index = Number(key);
        const plan = draftPlanOf(raw);
        if (plan === null) {
          store.problems.push(`章草稿里第 ${index + 1} 段格式不对,已跳过`);
          continue;
        }
        store.segments.set(index, plan);
      }
    }
    return store;
  }

  /** The drafted segments in station order. */
  segmentEntries(): readonly {
    readonly index: number;
    readonly plan: SegmentPlan;
  }[] {
    return [...this.segments.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, plan]) => ({ index, plan }));
  }

  segmentAt(index: number): SegmentPlan | undefined {
    return this.segments.get(index);
  }

  async setSegment(index: number, plan: SegmentPlan): Promise<void> {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`段下标要写 0 以上的整数,收到「${String(index)}」`);
    }
    this.segments.set(index, plan);
    await this.write();
  }

  async setMeta(meta: ChapterDraftMeta): Promise<void> {
    this.chapter = meta.chapter;
    this.goal = meta.goal;
    this.growth = meta.growth;
    this.fallback = meta.fallback;
    this.skipped = meta.skipped ?? [];
    this.notes = meta.notes;
    await this.write();
  }

  /** Remove every drafted segment and the meta after a successful submission. */
  async clear(): Promise<void> {
    this.chapter = null;
    this.goal = null;
    this.growth = [];
    this.fallback = null;
    this.skipped = [];
    this.notes = undefined;
    this.segments.clear();
    await this.write();
  }

  /** Assemble the meta and segments into one candidate plan, or list what is still missing. */
  toPlan(): ChapterDraftAssembly {
    const problems: string[] = [];
    if (this.chapter === null) problems.push("草稿还没有写 chapter(先调用 chapter_draft_meta)");
    if (this.goal === null || this.goal.trim() === "") {
      problems.push("草稿还没有写 goal(先调用 chapter_draft_meta)");
    }
    if (this.fallback === null) {
      problems.push("草稿还没有写 fallback(先调用 chapter_draft_meta)");
    }
    if (this.segments.size === 0) problems.push("草稿里还没有任何段");
    const entries = this.segmentEntries();
    for (const [index, entry] of entries.entries()) {
      if (entry.index !== index) {
        problems.push(`草稿缺少第 ${index + 1} 段(段下标要从 0 开始连着写)`);
      }
    }
    if (
      problems.length > 0 ||
      this.chapter === null ||
      this.goal === null ||
      this.fallback === null
    ) {
      return { plan: null, problems };
    }
    const plan: ChapterPlan = {
      version: 1,
      chapter: this.chapter,
      goal: this.goal,
      segments: entries.map((entry) => entry.plan),
      growth: this.growth,
      fallback: this.fallback,
      ...(this.skipped.length === 0 ? {} : { skipped: this.skipped }),
      ...(this.notes === undefined ? {} : { notes: this.notes }),
    };
    return { plan, problems };
  }

  private async write(): Promise<void> {
    if (this.path === undefined) return;
    const file: ChapterDraft = {
      version: 1,
      game: this.game,
      chapter: this.chapter,
      goal: this.goal,
      growth: this.growth,
      fallback: this.fallback,
      skipped: this.skipped,
      ...(this.notes === undefined ? {} : { notes: this.notes }),
      segments: Object.fromEntries(
        this.segmentEntries().map((entry) => [String(entry.index), entry.plan]),
      ),
    };
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    } catch (error) {
      throw new Error(`写不了章草稿 ${this.path}:${describeError(error)}`, {
        cause: error,
      });
    }
  }
}

interface ChapterPlanFile {
  readonly game: string;
  readonly current: ChapterPlan | null;
  readonly history: Record<string, readonly ChapterPlan[]>;
}

function historyOf(value: unknown, problems: string[]): Map<number, readonly ChapterPlan[]> {
  const out = new Map<number, readonly ChapterPlan[]>();
  if (value === undefined) return out;
  if (!isRecord(value)) {
    problems.push("章计划文件里的 history 不是对象,已忽略");
    return out;
  }
  for (const [chapter, raw] of Object.entries(value)) {
    const number = Number(chapter);
    if (!isPositiveInteger(number)) {
      problems.push(`章计划文件里的章号「${chapter}」不是正整数,已忽略`);
      continue;
    }
    if (!Array.isArray(raw)) {
      problems.push(`章计划文件里第 ${number} 章的历史不是数组,已忽略`);
      continue;
    }
    const plans = raw.flatMap((entry, index) => {
      const plan = chapterPlanOf(entry);
      if (plan === null) {
        problems.push(`章计划文件里第 ${number} 章第 ${index + 1} 版格式不对,已跳过`);
        return [];
      }
      return [plan];
    });
    out.set(number, plans.slice(-CHAPTER_PLAN_HISTORY_LIMIT));
  }
  return out;
}

export class ChapterPlanStore {
  readonly game: string;
  readonly path: string | undefined;
  /** Non-fatal shape problems found while loading; empty for a clean file. */
  readonly problems: string[] = [];
  current: ChapterPlan | null = null;
  private readonly versions = new Map<number, readonly ChapterPlan[]>();

  constructor(game: string, path?: string) {
    this.game = game;
    this.path = path;
  }

  static async load(game: string, path?: string, signal?: AbortSignal): Promise<ChapterPlanStore> {
    const store = new ChapterPlanStore(game, path);
    if (path === undefined) return store;
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return store;
      signal?.throwIfAborted();
      throw new Error(`读不了章计划 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂章计划 ${path}:${describeError(error)}`, {
        cause: error,
      });
    }
    if (!isRecord(parsed)) throw new Error(`章计划 ${path} 不是 JSON 对象`);
    if (parsed.current !== undefined && parsed.current !== null) {
      const current = chapterPlanOf(parsed.current);
      if (current === null) {
        store.problems.push("章计划文件里的 current 格式不对,已忽略");
      } else {
        store.current = current;
      }
    }
    for (const [chapter, plans] of historyOf(parsed.history, store.problems)) {
      store.versions.set(chapter, plans);
    }
    return store;
  }

  /** All kept versions of one chapter, oldest first. */
  historyFor(chapter: number): readonly ChapterPlan[] {
    return [...(this.versions.get(chapter) ?? [])];
  }

  /** Make `plan` current and append it to the chapter's history, keeping five versions. */
  async save(plan: ChapterPlan): Promise<void> {
    this.current = plan;
    const versions = this.versions.get(plan.chapter) ?? [];
    this.versions.set(plan.chapter, [...versions, plan].slice(-CHAPTER_PLAN_HISTORY_LIMIT));
    await this.write();
  }

  private async write(): Promise<void> {
    if (this.path === undefined) return;
    const file: ChapterPlanFile = {
      game: this.game,
      current: this.current,
      history: Object.fromEntries(
        [...this.versions.entries()].map(([chapter, plans]) => [String(chapter), plans]),
      ),
    };
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(this.path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    } catch (error) {
      throw new Error(`写不了章计划 ${this.path}:${describeError(error)}`, {
        cause: error,
      });
    }
  }
}

/** Read the current chapter plan without constructing a store, for callers that only read. */
export async function readChapterPlan(
  game: string,
  path?: string,
  signal?: AbortSignal,
): Promise<ChapterPlan | null> {
  const store = await ChapterPlanStore.load(game, path, signal);
  return store.current;
}
