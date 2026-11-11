/**
 * Task 134 measurements, run by hand (not part of `npm test`):
 *
 *   node test/measure-134.ts timing 2026-11-11T00:57:16Z 2026-11-11T00:57:52Z
 *   node test/measure-134.ts plan
 *
 * `timing` streams `.deps/pilot/timing.jsonl` for one tool window and sums the bridge op
 * times, so the 35 s village hop is split into story/walk/read/wait instead of guessed.
 * `plan` rebuilds the real Tule route book and analyzes its 15 stations, timing the CPU part
 * of the 86 s auto-plan; the stage officer is an LLM call in game.ts and is not timed here.
 */

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { Atlas } from "../src/engine/atlas.ts";
import { loadKnowledge } from "../src/engine/knowledge/load.ts";
import { DEPS } from "../src/engine/paths.ts";
import { CollisionStore } from "../src/engine/regions.ts";
import { analyzeRoute } from "../src/engine/route/analyze.ts";
import { resolveRouteStop, type RouteAction } from "../src/engine/route/tool.ts";
import { routeFromBookSection } from "../src/engine/stage/book-plan.ts";
import { parseWalkthrough } from "../src/engine/stage/guide-steps.ts";
import { loadRouteBook } from "../src/engine/stage/route-book-load.ts";
import { isRecord } from "../src/engine/values.ts";

const HOME = join(DEPS, "knowledge", "ff5");
const ATLAS = join(DEPS, "ds", "atlas-ff5.json");
const COLLISIONS = join(DEPS, "ds", "collision-ff5");
const TIMING = join(DEPS, "pilot", "timing.jsonl");

interface TimingRow {
  readonly t: string;
  readonly op: string;
  readonly via: string;
  readonly ms: number;
}

async function timing(startText: string, endText: string): Promise<void> {
  const start = Date.parse(startText);
  const end = Date.parse(endText);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("用法: node test/measure-134.ts timing <开始 ISO> <结束 ISO>");
  }
  const rows: TimingRow[] = [];
  const lines = createInterface({
    input: createReadStream(TIMING),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) continue;
    const t = typeof parsed.t === "string" ? Date.parse(parsed.t) : Number.NaN;
    if (!Number.isFinite(t) || t < start || t > end) continue;
    rows.push({
      t: parsed.t as string,
      op: typeof parsed.op === "string" ? parsed.op : "?",
      via: typeof parsed.via === "string" ? parsed.via : "?",
      ms: typeof parsed.ms === "number" ? parsed.ms : 0,
    });
  }
  const groups = new Map<string, { ms: number; calls: number }>();
  for (const row of rows) {
    const key = `${row.op}/${row.via}`;
    const group = groups.get(key) ?? { ms: 0, calls: 0 };
    group.ms += row.ms;
    group.calls += 1;
    groups.set(key, group);
  }
  const total = [...groups.values()].reduce((sum, group) => sum + group.ms, 0);
  console.log(`窗口 ${startText} .. ${endText}`);
  console.log(
    `墙钟 ${((end - start) / 1000).toFixed(1)}s，桥操作合计 ${(total / 1000).toFixed(1)}s`,
  );
  for (const [key, group] of [...groups.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
    console.log(`  ${key.padEnd(24)} ${(group.ms / 1000).toFixed(2).padStart(7)}s x${group.calls}`);
  }
}

function actionOf(stop: { readonly do?: string }): RouteAction {
  switch (stop.do) {
    case "open":
      return "open";
    case "save":
      return "save";
    case "talk":
      return "talk";
    case "grind":
      return "grind";
    case "boss":
      return "boss";
    case "handoff":
      return "handoff";
    default:
      return "move";
  }
}

async function plan(): Promise<void> {
  let mark = performance.now();
  const knowledge = await loadKnowledge({
    game: "ff5",
    home: HOME,
    atlas: null,
    collisions: null,
    bestiarySave: null,
    atlasSave: null,
  });
  console.log(`知识读取      ${(performance.now() - mark).toFixed(0)} ms`);
  mark = performance.now();
  const atlas = await Atlas.load(ATLAS);
  const store = await CollisionStore.load(COLLISIONS, undefined, join(HOME, "files", "maps"));
  console.log(`地图/碰撞     ${(performance.now() - mark).toFixed(0)} ms`);
  mark = performance.now();
  const raw: unknown = JSON.parse(await readFile(join(HOME, "guide.json"), "utf8"));
  if (!isRecord(raw)) throw new Error("guide.json 不是对象");
  const sections = parseWalkthrough(raw.walkthrough);
  console.log(`攻略解析      ${(performance.now() - mark).toFixed(0)} ms`);
  mark = performance.now();
  const runtime = await loadRouteBook({
    game: "ff5",
    sections,
    knowledge,
    atlas,
    visitOrder: [],
    save: {
      bestiary: new Set(knowledge.progress.bestiary),
      blueMagic: null,
      jobs: null,
      openedChests: new Set<string>(),
    },
    fromSection: "Tule",
    preferredSection: "Tule",
    preferredMapId: 30,
    mapId: 1,
    aheadSections: 4,
    timeBudgetMs: 120_000,
  });
  console.log(`路线书构建    ${(performance.now() - mark).toFixed(0)} ms`);
  if (runtime === null) throw new Error("没有生成 Tule 路线书");
  mark = performance.now();
  const stops = routeFromBookSection(runtime.section, { grindMinutes: 8 });
  console.log(`站点转换      ${(performance.now() - mark).toFixed(0)} ms（${stops.length} 站）`);
  const waypoints = stops.map((stop, index) =>
    resolveRouteStop(
      {
        to: stop.to,
        action: actionOf(stop),
        optional: true,
        ...(stop.book === undefined ? {} : { book: stop.book }),
      },
      `p${index}`,
      31,
      atlas,
      false,
    ),
  );
  mark = performance.now();
  const analyzed = analyzeRoute(
    { start: { map: 31, cell: [9, 8] }, waypoints, end: null },
    { atlas, collisions: store, battleSeconds: 45 },
  );
  console.log(
    `路线分析      ${(performance.now() - mark).toFixed(0)} ms（${analyzed.legs.length} 段，` +
      `${analyzed.unreachable.length} 个走不到）`,
  );
  const total = stops.length;
  console.log(`阶段官不在此脚本内：它在 game.ts 的 createStagePlan -> officer(...)，是 LLM 调用。`);
  console.log(`这 ${total} 站的纯计算合计通常 < 2 s；86 s 里的大头是阶段官和它前后的桥读。`);
}

const mode = process.argv[2] ?? "";
if (mode === "timing") {
  await timing(process.argv[3] ?? "", process.argv[4] ?? "");
} else if (mode === "plan") {
  await plan();
} else {
  console.log("用法: node test/measure-134.ts timing <开始 ISO> <结束 ISO> | plan");
}
