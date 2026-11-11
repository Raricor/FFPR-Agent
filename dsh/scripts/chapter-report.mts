/**
 * One-screen chapter run summary (task 158, 11-12):
 *
 *   node scripts/chapter-report.mts [--run <id>|--last] [--chapter N] [--game ff5] [--json]
 *
 * Reads `.deps/ds/run-<game>.jsonl` (written by the executors), the chapter plan and the chapter
 * progress, and prints every station's result/time/attempts/reason, chests and hidden items,
 * fallbacks by kind, the blocked spot, battles, levels, heals and the run's model calls.
 * `--json` prints the same data as JSON. `--deps <dir>` is for tests and alternate checkouts.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChapterPlanStore } from "../src/engine/plan/chapter-store.ts";
import type { ChapterProgress } from "../src/engine/plan/chapter-types.ts";
import { buildChapterRunReport, formatChapterRunReport } from "../src/engine/plan/run-report.ts";
import { DEPS } from "../src/engine/paths.ts";
import { readRunEvents } from "../src/engine/run-log.ts";
import { isRecord } from "../src/engine/values.ts";

function arg(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index < 0 ? null : (args[index + 1] ?? null);
}

function numberArg(args: readonly string[], name: string): number | null {
  const value = arg(args, name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 要写正整数，收到「${value}」`);
  }
  return parsed;
}

async function progressOf(file: string): Promise<ChapterProgress | null> {
  let body: string;
  try {
    body = await readFile(file, "utf8");
  } catch (error) {
    if (isRecord(error) && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || typeof parsed.chapter !== "number") return null;
  return parsed as unknown as ChapterProgress;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "node scripts/chapter-report.mts [--run <id>|--last] [--chapter N] [--game ff5] [--json]",
    );
    return;
  }
  const game = (arg(args, "--game") ?? "ff5").toLowerCase();
  if (!/^ff[1-6]$/u.test(game)) throw new Error(`--game 要写 ff1–ff6，收到「${game}」`);
  const deps = arg(args, "--deps") ?? DEPS;
  const requestedRun = arg(args, "--run");
  const last = args.includes("--last");
  const chapterFilter = numberArg(args, "--chapter");
  if (requestedRun !== null && last) throw new Error("--run 和 --last 只能写一个");
  const json = args.includes("--json");

  const file = join(deps, "ds", `run-${game}.jsonl`);
  const all = await readRunEvents(file);
  if (all.length === 0) {
    throw new Error(`没有执行日志 ${file}（先执行一章，再来看汇总）`);
  }
  const candidates =
    chapterFilter === null ? all : all.filter((event) => event.chapter === chapterFilter);
  if (candidates.length === 0) {
    throw new Error(`执行日志里没有第 ${chapterFilter ?? "?"} 章的记录`);
  }

  const run = requestedRun ?? candidates[candidates.length - 1]?.run ?? null;
  if (run === null) throw new Error("执行日志里没有可用的 run id");
  let events = candidates.filter((event) => event.run === run);
  if (events.length === 0) {
    const recent = [...new Set(all.map((event) => event.run))].slice(-5).join("、");
    throw new Error(`找不到 run「${run}」；最近的 run:${recent}`);
  }
  const chapter = chapterFilter ?? events.find((event) => event.chapter !== null)?.chapter ?? null;
  if (chapter !== null) events = events.filter((event) => event.chapter === chapter);

  const planStore = await ChapterPlanStore.load(
    game,
    join(deps, "ds", `chapter-plan-${game}.json`),
  );
  const plan =
    chapter === null
      ? null
      : planStore.current?.chapter === chapter
        ? planStore.current
        : (planStore.historyFor(chapter).at(-1) ?? null);
  let progress = await progressOf(join(deps, "ds", `chapter-progress-${game}.json`));
  if (progress !== null && (chapter === null || progress.chapter !== chapter)) progress = null;

  const report = buildChapterRunReport({
    game,
    run,
    events,
    plan,
    progress,
    chapter,
  });
  console.log(json ? JSON.stringify(report, null, 2) : formatChapterRunReport(report));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
