/**
 * Seed the lift rides seen on 11-08 (local 11-09) in the Fire-Powered Ship into a real
 * atlas file (task 71). The task's agent may not write ../.deps, so this is the reviewed
 * script to run by hand:
 *
 *   node scripts/seed-atlas-rides.ts --check          # print what would change
 *   node scripts/seed-atlas-rides.ts                  # write, after a .bak copy
 *   node scripts/seed-atlas-rides.ts --atlas <path>
 *
 * Sources are in ../.deps/ds/player-ff5.jsonl (the 11-08 UTC / 11-09 local session). The
 * 634 → 257 ride was not taken in that session; its look_around on 634 reads the same cell
 * (3, 6) as 「エレベーターで下がる①」, so the reverse of 257 → 634 is seeded as well.
 */

import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { Atlas } from "../src/engine/atlas.ts";

interface SeedRide {
  readonly map: number;
  readonly from: readonly [number, number];
  readonly press: readonly [number, number];
  readonly dir: string;
  readonly to: number;
  readonly land: readonly [number, number];
  readonly source: string;
}

const DEFAULT_ATLAS = join(import.meta.dirname, "..", "..", ".deps", "ds", "atlas-ff5.json");

const RIDES: readonly SeedRide[] = [
  {
    map: 257,
    from: [4, 6],
    press: [3, 6],
    dir: "Left",
    to: 634,
    land: [4, 6],
    source: "player-ff5.jsonl 2026-11-08T21:05:04.131Z",
  },
  {
    map: 634,
    from: [4, 6],
    press: [3, 6],
    dir: "Left",
    to: 257,
    land: [4, 6],
    source: "player-ff5.jsonl 2026-11-08T21:05:48.553Z(634 的 (3,6) 是「エレベーターで下がる①」)",
  },
  {
    map: 635,
    from: [4, 6],
    press: [3, 6],
    dir: "Left",
    to: 260,
    land: [3, 6],
    source: "player-ff5.jsonl 2026-11-08T21:08:41.054Z",
  },
  {
    map: 260,
    from: [3, 6],
    press: [2, 6],
    dir: "Left",
    to: 635,
    land: [4, 6],
    source: "player-ff5.jsonl 2026-11-08T21:24:39.998Z",
  },
];

const USAGE =
  "用法: node scripts/seed-atlas-rides.ts [--check] [--atlas <path>]\n" +
  "默认 atlas:../.deps/ds/atlas-ff5.json;--check 只打印,不写文件。";

function parseArguments(argv: readonly string[]): {
  check: boolean;
  path: string;
} {
  let check = false;
  let path = DEFAULT_ATLAS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") check = true;
    else if (arg === "--atlas") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--atlas 后面缺路径");
      path = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`不认识的参数:${arg ?? ""}`);
    }
  }
  return { check, path };
}

async function main(): Promise<void> {
  const { check, path } = parseArguments(process.argv.slice(2));
  const loaded = await Atlas.load(path);
  const atlas = check ? new Atlas() : loaded;
  if (check) {
    for (const [mapId, entry] of loaded.maps) atlas.maps.set(mapId, entry);
    console.log(`只检查,不写:${path}`);
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const backup = `${path}.bak-elevator-${stamp}`;
    await copyFile(path, backup);
    console.log(`备份:${backup}`);
  }
  for (const ride of RIDES) {
    const changed = await atlas.ride(ride.map, ride.from, ride.press, ride.dir, ride.to, ride.land);
    console.log(
      `${changed ? "写入" : "已有"} 地图 ${ride.map} (${ride.from[0]},${ride.from[1]})` +
        ` 面朝${ride.dir} 按(${ride.press[0]},${ride.press[1]}) → 地图 ${ride.to}` +
        ` (${ride.land[0]},${ride.land[1]})  [${ride.source}]`,
    );
  }
  if (check) {
    const latest = await Atlas.load(path);
    console.log(`检查后文件未改;当前 ${path} 里的坐一趟边:`);
    for (const ride of RIDES) {
      const found = latest
        .rides(ride.map)
        .some(
          (edge) =>
            edge.cell[0] === ride.from[0] &&
            edge.cell[1] === ride.from[1] &&
            edge.press[0] === ride.press[0] &&
            edge.press[1] === ride.press[1] &&
            edge.dir === ride.dir &&
            edge.to === ride.to,
        );
      console.log(`  ${found ? "有" : "缺"} 地图 ${ride.map} → 地图 ${ride.to}`);
    }
  }
}

await main();
