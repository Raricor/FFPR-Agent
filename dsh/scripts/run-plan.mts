/**
 * Run one `SegmentPlan` on the real device without dsh (task 138): load the laptop link and the
 * bridge token exactly as the plugin does, build the engine, execute the whole segment in code
 * and print the `SegmentReport`. This is for checking the executor on the laptop; unit tests
 * never use it.
 *
 *   node scripts/run-plan.mts plan.json
 *   node scripts/run-plan.mts plan.json --game ff5 --minutes 60 --log /tmp/run.log
 *
 * Task 141: every executor step goes to `.deps/tmp/plans/run-<time>.log` (or `--log`) and to
 * the terminal as one `[plan]` line, so a failed run can be read after the fact.
 *
 * The tactician and stage officer are suspended for the run (game-ports.ts), so no model call
 * is made. Ctrl-C aborts at the next safe point.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BridgeLink } from "../src/engine/bridge.ts";
import { Game } from "../src/engine/game.ts";
import { byKey } from "../src/engine/games.ts";
import { load as loadLaptop } from "../src/engine/laptop.ts";
import { createPilot } from "../src/engine/link-pilot.ts";
import { DEPS, LAPTOP_ENV, secretsPath } from "../src/engine/paths.ts";
import { executeSegmentPlan } from "../src/engine/plan/execute.ts";
import { gamePlanPorts } from "../src/engine/plan/game-ports.ts";
import type { SegmentPlan } from "../src/engine/plan/types.ts";
import { isRecord } from "../src/engine/values.ts";

function arg(args: readonly string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

/** Task 141: the default run log, one file per start, colons replaced for Windows too. */
function defaultLogFile(args: readonly string[]): string {
  const requested = arg(args, "--log", "");
  if (requested !== "") return requested;
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  return join(DEPS, "tmp", "plans", `run-${stamp}.log`);
}

function minuteArg(args: readonly string[]): number {
  const minutes = Number(arg(args, "--minutes", "60"));
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 60;
}

/** The plan file is the model's JSON; task 137 validates the details, this only rejects a shell. */
function planOf(value: unknown, file: string): SegmentPlan {
  if (!isRecord(value)) throw new Error(`${file} 不是 JSON 对象`);
  if (value.version !== 1) throw new Error(`${file} 的 version 不是 1`);
  if (typeof value.section !== "string" || value.section.trim() === "") {
    throw new Error(`${file} 没有 section`);
  }
  if (!Array.isArray(value.stations)) throw new Error(`${file} 没有 stations 数组`);
  if (!isRecord(value.prep) || !Array.isArray(value.battle)) {
    throw new Error(`${file} 没有 prep 或 battle`);
  }
  if (!Array.isArray(value.bosses) || !Array.isArray(value.turnBack)) {
    throw new Error(`${file} 没有 bosses 或 turnBack 数组`);
  }
  return value as unknown as SegmentPlan;
}

function pathsFor(game: string) {
  const key = byKey(game).key;
  return {
    key,
    saveSlot: 20,
    notesFile: join(DEPS, "ds", `notes-${key}.json`),
    atlasFile: join(DEPS, "ds", `atlas-${key}.json`),
    tacticsFile: join(DEPS, "ds", `tactics-${key}.json`),
    elementsFile: join(DEPS, "ds", `elements-${key}.json`),
    battlesFile: join(DEPS, "ds", `battles-${key}.jsonl`),
    tacticianFile: join(DEPS, "ds", `tactician-${key}.jsonl`),
    backlogFile: join(DEPS, "ds", `backlog-${key}.jsonl`),
    incidentsFile: join(DEPS, "ds", `incidents-${key}.jsonl`),
    incidentsStateFile: join(DEPS, "ds", `incidents-state-${key}.json`),
    bestiarySaveFile: join(DEPS, "ds", `bestiary-save-${key}.json`),
    routeFile: join(DEPS, "ds", `route-${key}.json`),
    stagePlanFile: join(DEPS, "ds", `stage-${key}.json`),
    routeBookProgressFile: join(DEPS, "ds", `routebook-progress-${key}.json`),
    routeBookLearnedFile: join(DEPS, "ds", `routebook-learned-${key}.json`),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log("node scripts/run-plan.mts <计划.json> [--game ff5] [--minutes 60] [--log 路径]");
    return;
  }
  const file = args[0];
  if (file === undefined) throw new Error("要一份计划 JSON 的路径");
  const plan = planOf(JSON.parse(await readFile(file, "utf8")), file);
  const game = arg(args, "--game", "ff5");
  const paths = pathsFor(game);
  const stop = new AbortController();
  const onInterrupt = (): void => {
    console.error("收到中断，执行器会在下一个安全点停下。");
    stop.abort();
  };
  process.on("SIGINT", onInterrupt);

  const laptop = await loadLaptop(LAPTOP_ENV, stop.signal);
  const bridge = await BridgeLink.load({
    secretsFile: secretsPath(),
    laptopEnv: LAPTOP_ENV,
    port: paths.key === "ff5" ? 47800 : 47800 + Number(paths.key.slice(2)),
    laptopUrl: paths.key === "ff5",
    signal: stop.signal,
  });
  if (bridge === undefined) throw new Error(`没有 BRIDGE_TOKEN，读 ${secretsPath()}`);
  const pilot = createPilot(laptop, bridge, stop.signal, {
    game: paths.key,
    log: (line) => {
      console.error(line);
    },
  });
  const engine = await Game.create({
    laptop,
    game: paths.key,
    saveSlot: paths.saveSlot,
    notesFile: paths.notesFile,
    atlasFile: paths.atlasFile,
    tacticsFile: paths.tacticsFile,
    elementsFile: paths.elementsFile,
    battlesFile: paths.battlesFile,
    tacticianFile: paths.tacticianFile,
    backlogFile: paths.backlogFile,
    incidentsFile: paths.incidentsFile,
    incidentsStateFile: paths.incidentsStateFile,
    bestiarySaveFile: paths.bestiarySaveFile,
    routeFile: paths.routeFile,
    stagePlanFile: paths.stagePlanFile,
    routeBookEnabled: false,
    routeBookAutoPlan: false,
    routeBookProgressFile: paths.routeBookProgressFile,
    routeBookLearnedFile: paths.routeBookLearnedFile,
    // The executor owns walking; the model-facing gates must not turn a plan walk away.
    stageAutoPlan: false,
    stageGoGate: false,
    stageGoFollowPlan: false,
    signal: stop.signal,
  });
  const logFile = defaultLogFile(args);
  await mkdir(dirname(logFile), { recursive: true });
  let logQueue: Promise<void> = Promise.resolve();
  let logWarned = false;
  const planLog = (line: string): void => {
    console.error(`[plan] ${line}`);
    const at = new Date().toISOString();
    logQueue = logQueue.then(async () => {
      try {
        await appendFile(logFile, `[${at}] ${line}\n`, "utf8");
      } catch (error) {
        if (!logWarned) {
          logWarned = true;
          console.error(`写不了过程日志 ${logFile}:${String(error)}`);
        }
      }
    });
  };
  planLog(`命令行执行:计划 ${file},日志 ${logFile}`);
  const report = await executeSegmentPlan(plan, gamePlanPorts(engine, pilot), {
    signal: stop.signal,
    timeBudgetMs: minuteArg(args) * 60_000,
    log: planLog,
  });
  await logQueue;
  console.log(JSON.stringify(report, null, 2));
  const outcome =
    report.status === "done"
      ? `完成 ${report.done.stations} 站`
      : `${report.status}:${report.exception?.kind ?? "?"} ${report.exception?.detail ?? ""}`;
  const summary =
    `段「${report.section}」${outcome};宝箱 ${report.done.chestsOpened},` +
    `战斗 ${report.done.battles},首领 ${report.done.bossesWon.join("、") || "无"},` +
    `用时 ${report.minutes} 分,模型调用 ${report.modelCalls} 次`;
  console.log(summary);
  planLog(`结束:${summary.split("\n")[0] ?? summary}`);
  await logQueue;
  bridge.close();
  process.off("SIGINT", onInterrupt);
}

await main();
