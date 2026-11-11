/**
 * Route analyzer debug (task 127). Reads the real FF5 atlas, collision cache, game-file map
 * export and the saved stage plan, then prints every directed pair estimate and the analyzer's
 * unreachable reasons. Offline: no bridge, no laptop, no keys.
 *
 *   node scripts/route-debug.mts
 *   node scripts/route-debug.mts --start 1:156,139 --end 194:16,10
 *   node scripts/route-debug.mts --modes walk,chocobo --no-pairs
 *   node scripts/route-debug.mts --plan ../.deps/ds/stage-ff5.json
 *
 * Without `--plan` it uses `.deps/ds/stage-<game>.json`; without `--end` it follows the route
 * tool's rule (the last stop becomes the end when its action is not move).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Atlas } from "../src/engine/atlas.ts";
import { DEPS } from "../src/engine/paths.ts";
import { CollisionStore, RegionIndex, WORLD_MODES, type WorldMode } from "../src/engine/regions.ts";
import { analyzeRoute } from "../src/engine/route/analyze.ts";
import { ROUTE_SURFACE_WORLD_MODES, estimatePair } from "../src/engine/route/distance.ts";
import { parseGrindUntil, targetCell } from "../src/engine/route/tool.ts";
import type { RoutePoint, Waypoint, WaypointKind } from "../src/engine/route/types.ts";
import { isRecord, records, text } from "../src/engine/values.ts";

interface Options {
  readonly game: string;
  readonly start: string;
  readonly end: string | null;
  readonly plan: string | null;
  readonly modes: readonly WorldMode[];
  readonly pairs: boolean;
}

function arg(args: readonly string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function modesOf(value: string): readonly WorldMode[] {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const modes: WorldMode[] = [];
  for (const name of names) {
    if (!WORLD_MODES.includes(name as WorldMode)) {
      throw new Error(`不认识的 world mode「${name}」，可选:${WORLD_MODES.join(",")}`);
    }
    modes.push(name as WorldMode);
  }
  return modes.length === 0 ? ROUTE_SURFACE_WORLD_MODES : modes;
}

function optionsOf(args: readonly string[]): Options {
  const game = arg(args, "--game", "ff5");
  return {
    game,
    start: arg(args, "--start", "1:156,139"),
    end: args.includes("--end") ? arg(args, "--end", "194:16,10") : null,
    plan: args.includes("--plan") ? arg(args, "--plan", "") : null,
    modes: modesOf(arg(args, "--modes", ROUTE_SURFACE_WORLD_MODES.join(","))),
    pairs: !args.includes("--no-pairs"),
  };
}

function pointOf(value: string, where: string): RoutePoint {
  const match = /^(?:地图\s*)?(\d+)(?::\s*(.+))?$/u.exec(value.trim());
  if (match === null) throw new Error(`${where} 要写成 地图号 或 地图号:格子，收到「${value}」`);
  const map = Number(match[1]);
  if (!Number.isInteger(map)) throw new Error(`${where} 的地图号不是整数`);
  const cellText = match[2];
  const cell = cellText === undefined ? null : targetCell(cellText);
  if (cellText !== undefined && cell === null) {
    throw new Error(`${where} 的格子读不懂:「${cellText}」`);
  }
  return { map, cell };
}

function kindOf(action: string | undefined): WaypointKind {
  if (action === "open") return "chest";
  if (action === "save") return "save";
  if (action === "talk") return "story";
  if (action === "grind") return "grind";
  if (action === "boss") return "boss";
  if (action === "handoff") return "handoff";
  return "move";
}

interface PlanStop {
  readonly to: string;
  readonly do?: string;
  readonly until?: unknown;
}

async function planStops(file: string): Promise<PlanStop[]> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.plan)) throw new Error(`${file} 里没有 plan`);
  const route = records(parsed.plan.route);
  if (route.length === 0) throw new Error(`${file} 的 plan.route 是空的`);
  return route.flatMap((entry) => {
    const to = text(entry.to);
    if (to === undefined || to === "") return [];
    const action = text(entry.do);
    return [{ to, ...(action === undefined ? {} : { do: action }), until: entry.until }];
  });
}

function waypointOf(stop: PlanStop, index: number): Waypoint {
  const point = pointOf(stop.to, `第 ${index + 1} 站`);
  const action = stop.do;
  return {
    id: `s${index + 1}`,
    kind: kindOf(action),
    map: point.map,
    cell: point.cell,
    label: stop.to,
    ...(action === "grind" && isRecord(stop.until)
      ? { until: parseGrindUntil(stop.until, `第 ${index + 1} 站的 until`) }
      : {}),
  };
}

function pointText(point: RoutePoint): string {
  return point.cell === null
    ? `地图 ${point.map}`
    : `地图 ${point.map} (${point.cell[0]},${point.cell[1]})`;
}

function pairText(ok: boolean, body: string): string {
  return ok ? body : `走不到：${body}`;
}

async function main(): Promise<void> {
  const options = optionsOf(process.argv.slice(2));
  const atlasFile = join(DEPS, "ds", `atlas-${options.game}.json`);
  const collisionDir = join(DEPS, "ds", `collision-${options.game}`);
  const gameDir = join(DEPS, "knowledge", options.game, "files", "maps");
  const atlas = await Atlas.load(atlasFile);
  const collisions = await CollisionStore.load(collisionDir, undefined, gameDir);
  const regions = RegionIndex.create(atlas, collisions);
  const world = { atlas, collisions, regions, worldModes: options.modes };
  const start = pointOf(options.start, "--start");
  if (start.cell === null) throw new Error("--start 要写地图号:格子，分析要从一个格子出发");
  const startCell = start.cell;

  console.log(`地图记录 ${atlasFile}:${atlas.maps.size} 张`);
  console.log(`碰撞/游戏文件 ${collisionDir} + ${gameDir}`);
  console.log(`起点 ${pointText(start)}，世界地图模式 ${options.modes.join("+")}`);
  if (atlas.maps.has(String(start.map)) && collisions.hasWorld(start.map)) {
    console.log(
      `起点世界块:${options.modes.map((mode) => `${mode}=${collisions.worldZone(start.map, [mode], startCell)}`).join(" ")}`,
    );
  }

  const stops =
    options.plan === null
      ? await planStops(join(DEPS, "ds", `stage-${options.game}.json`))
      : await planStops(options.plan);
  const waypoints = stops.map(waypointOf);
  const last = waypoints.at(-1);
  let end: RoutePoint | null = options.end === null ? null : pointOf(options.end, "--end");
  let planned = waypoints;
  if (end === null && last !== undefined) {
    if ((stops.at(-1)?.do ?? "move") === "move") {
      planned = waypoints.slice(0, -1);
    }
    end = { map: last.map, cell: last.cell };
  }
  console.log(`路标 ${planned.length} 个，终点 ${end === null ? "无" : pointText(end)}`);
  if (options.plan === null)
    console.log(`计划文件 ${join(DEPS, "ds", `stage-${options.game}.json`)}`);

  if (options.pairs) {
    const points: RoutePoint[] = [
      start,
      ...planned.map((waypoint) => ({ map: waypoint.map, cell: waypoint.cell })),
      ...(end === null ? [] : [end]),
    ];
    const names = [
      "起点",
      ...planned.map((waypoint) => waypoint.label),
      ...(end === null ? [] : ["终点"]),
    ];
    for (const [fromIndex, from] of points.entries()) {
      for (const [toIndex, to] of points.entries()) {
        if (fromIndex === toIndex) continue;
        const pair = estimatePair(world, from, to);
        console.log(
          `${names[fromIndex]} → ${names[toIndex]}:` +
            (pair.ok
              ? pairText(
                  true,
                  `${pair.estimate.maps.join(">")}，${pair.estimate.hops} 跳，` +
                    `${pair.estimate.cells} 格，${(pair.estimate.minutes * 60).toFixed(1)} 秒`,
                )
              : pairText(false, pair.reason)),
        );
      }
    }
  }

  const started = performance.now();
  const plan = analyzeRoute(
    {
      start: { map: start.map, cell: startCell },
      end: end === null ? null : { map: end.map, cell: end.cell },
      waypoints: planned,
    },
    world,
  );
  const elapsed = performance.now() - started;
  console.log(
    `\n分析 ${elapsed.toFixed(1)} ms，${plan.legs.length} 段，${plan.unreachable.length} 个走不到`,
  );
  for (const [index, leg] of plan.legs.entries()) {
    console.log(
      `  ${index + 1}. ${leg.kind}「${leg.label}」${leg.maps.join(">")}，` +
        `${leg.hops} 跳，${Math.round(leg.cells)} 格，${(leg.minutes * 60).toFixed(1)} 秒`,
    );
  }
  for (const lost of plan.unreachable) {
    console.log(`  走不到 ${lost.kind}「${lost.label}」${pointText(lost)}：${lost.reason}`);
  }
  for (const warning of plan.warnings) console.log(`  提醒：${warning}`);
  console.log(
    `  合计 ${plan.total.hops} 跳，${Math.round(plan.total.cells)} 格，` +
      `${(plan.total.minutes * 60).toFixed(1)} 秒`,
  );
}

await main();
