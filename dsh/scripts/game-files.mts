// Export the whole game's maps and three-language item names from the extracted FF5 files.
// Offline: reads `.deps/ff5/files/` and writes `.deps/knowledge/ff5/files/`; never talks to the
// game, the bridge or the laptop.
//
//   node scripts/game-files.mts
//
// The last step compares the result with the visited-map atlas and the collision cache. Those
// records were learned by walking, so a mismatch usually means a coordinate rule is wrong.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildItems,
  compareAtlas,
  compareCollisions,
  isWorldMapResource,
  parseContentCsv,
  parseEntity,
  parseMapCsv,
  parseMessageTable,
  parseScriptNames,
  parseSubmap,
  parseTransportationGroups,
  parseTreasureBoxCsv,
  type GameItem,
  type MapFileSet,
  type MapResource,
  type ParsedMap,
} from "../src/engine/knowledge/game-files.ts";
import { DEPS } from "../src/engine/paths.ts";
import { isRecord } from "../src/engine/values.ts";

const GAME = "ff5";
const FILES = join(DEPS, GAME, "files");
const OUTPUT = join(DEPS, "knowledge", GAME, "files");
const MAP_OUTPUT = join(OUTPUT, "maps");

function missingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return await readJson(path);
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }
}

async function readEventFiles(directory: string): Promise<{ file: string; value: unknown }[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (missingFile(error)) return [];
    throw error;
  }
  const events: { file: string; value: unknown }[] = [];
  for (const name of names.filter((item) => /^ev_e_.+\.json$/u.test(item)).sort()) {
    const value = await readOptionalJson(join(directory, name));
    if (value !== null) events.push({ file: name, value });
  }
  return events;
}

async function readScriptFiles(directory: string): Promise<{ file: string; value: unknown }[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (missingFile(error)) return [];
    throw error;
  }
  const scripts: { file: string; value: unknown }[] = [];
  for (const name of names.filter((item) => /^sc_.+\.json$/u.test(item)).sort()) {
    const value = await readOptionalJson(join(directory, name));
    if (value !== null) scripts.push({ file: name, value });
  }
  return scripts;
}

/**
 * Task 128: world-map scripts are inline base64 inside package.json (`map[].script[]`), not
 * `sc_*.json` files. Decode only the world map packages; every other map keeps the file reader.
 */
async function readPackageScripts(directory: string): Promise<{ name: string; value: unknown }[]> {
  const value = await readOptionalJson(join(directory, "package.json"));
  if (!isRecord(value) || !Array.isArray(value.map)) return [];
  const scripts: { name: string; value: unknown }[] = [];
  for (const map of value.map) {
    if (!isRecord(map) || !Array.isArray(map.script)) continue;
    for (const entry of map.script) {
      if (!isRecord(entry)) continue;
      const name = typeof entry.name === "string" ? entry.name : "";
      const inline = typeof entry.inline === "string" ? entry.inline : "";
      if (name === "" || inline === "") continue;
      try {
        scripts.push({
          name,
          value: JSON.parse(Buffer.from(inline, "base64").toString("utf8")) as unknown,
        });
      } catch {
        // One unreadable inline script must not drop the whole map export.
      }
    }
  }
  return scripts;
}

async function readCaches(): Promise<Record<string, unknown>> {
  const directory = join(DEPS, "ds", `collision-${GAME}`);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (missingFile(error)) return {};
    throw error;
  }
  const caches: Record<string, unknown> = {};
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    const value = await readOptionalJson(join(directory, name));
    if (value !== null) caches[name.slice(0, -".json".length)] = value;
  }
  return caches;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mapForJson(map: ParsedMap): Record<string, unknown> {
  return {
    id: map.map.id,
    name: map.map.name,
    packageName: map.map.packageName,
    assetName: map.map.assetName,
    titleKey: map.map.titleKey,
    areaId: map.map.areaId,
    saveAvailable: map.map.saveAvailable,
    chests: map.chests,
    exits: map.exits,
    events: map.events,
    npcs: map.npcs,
    savePoints: map.savePoints,
    restorePoints: map.restorePoints,
    moveAreas: map.moveAreas,
    collision: map.collision,
    damage: map.damage,
    hiddenPassages: map.hiddenPassages,
    unresolved: map.unresolved,
    ...(map.world === undefined ? {} : { world: map.world }),
    ...(map.worldExits === undefined ? {} : { worldExits: map.worldExits }),
  };
}

async function parseMap(
  map: MapResource,
  treasureTypes: ReadonlyMap<number, number>,
  transportationGroups: ReadonlyMap<number, ReadonlySet<number>>,
  worldIds: ReadonlySet<number>,
  scriptNames: ReadonlyMap<number, string>,
): Promise<ParsedMap | null> {
  const directory = join(FILES, "Res", "Map", map.packageName, map.name);
  const packageDirectory = join(FILES, "Res", "Map", map.packageName);
  const entityText = await readOptionalText(join(directory, "entity_default.json"));
  if (entityText === null) return null;
  const entity = JSON.parse(entityText) as unknown;
  // World-exit scripts are only interesting on maps whose entities have a world-map exit.
  const hasWorldExit = parseEntity(entity).exits.some((exit) => exit.kind === "world");
  const scripts = hasWorldExit ? await readScriptFiles(directory) : [];
  const toWorld = scripts.filter((script) => script.file.endsWith("_to_world.json"));
  const worldScripts = toWorld.length > 0 ? toWorld : scripts;
  const files: MapFileSet = {
    map,
    entity,
    treasureTypes,
    collision: await readOptionalJson(join(directory, "collision.json")),
    damage: await readOptionalJson(join(directory, "damage.json")),
    hiddenPassage: await readOptionalJson(join(directory, "hidden_passage.json")),
    events: await readEventFiles(directory),
    attribute: isWorldMapResource(map)
      ? await readOptionalJson(join(directory, "attribute.json"))
      : undefined,
    scripts: worldScripts,
    scriptNames,
    packageScripts: isWorldMapResource(map)
      ? await readPackageScripts(packageDirectory)
      : undefined,
    transportationGroups,
    worldIds,
  };
  return parseSubmap(files);
}

interface DiskSubmaps {
  readonly count: number;
  readonly unmapped: readonly string[];
}

async function scanSubmaps(resources: readonly MapResource[]): Promise<DiskSubmaps> {
  const known = new Set(resources.map((map) => map.name));
  const root = join(FILES, "Res", "Map");
  let packages: string[];
  try {
    packages = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (missingFile(error)) return { count: 0, unmapped: [] };
    throw error;
  }
  let count = 0;
  const unmapped: string[] = [];
  for (const packageName of packages) {
    const directory = join(root, packageName);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (missingFile(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const files = await readOptionalText(join(directory, entry.name, "entity_default.json"));
      if (files === null) continue;
      count += 1;
      if (!known.has(entry.name)) unmapped.push(entry.name);
    }
  }
  return { count, unmapped };
}

interface Summary {
  readonly game: string;
  readonly maps: number;
  readonly mapsInCsv: number;
  readonly missingMaps: number;
  readonly submapsOnDisk: number;
  readonly unmappedSubmaps: readonly string[];
  readonly chests: number;
  readonly hiddenItems: number;
  readonly exits: number;
  readonly eventExits: number;
  readonly events: number;
  readonly npcs: number;
  readonly savePoints: number;
  readonly restorePoints: number;
  readonly moveAreas: number;
  readonly collisionLayers: number;
  readonly damageCells: number;
  readonly hiddenPassageCells: number;
  readonly items: number;
  readonly unresolved: {
    readonly total: number;
    readonly byType: Record<string, number>;
    readonly examples: readonly string[];
  };
  readonly atlas: ReturnType<typeof compareAtlas>;
  readonly collisions: ReturnType<typeof compareCollisions>;
}

function buildSummary(
  maps: readonly ParsedMap[],
  mapsInCsv: number,
  disk: DiskSubmaps,
  items: readonly GameItem[],
  atlasComparison: ReturnType<typeof compareAtlas>,
  collisionComparison: ReturnType<typeof compareCollisions>,
): Summary {
  const unresolved = maps.flatMap((map) =>
    map.unresolved.map((entry) => ({ mapId: map.map.id, ...entry })),
  );
  const byType: Record<string, number> = {};
  for (const entry of unresolved) {
    const key = entry.objectType === null ? "none" : String(entry.objectType);
    byType[key] = (byType[key] ?? 0) + 1;
  }
  return {
    game: GAME,
    maps: maps.length,
    mapsInCsv,
    missingMaps: mapsInCsv - maps.length,
    submapsOnDisk: disk.count,
    unmappedSubmaps: disk.unmapped,
    chests: sum(maps.map((map) => map.chests.length)),
    hiddenItems: sum(maps.map((map) => map.chests.filter((chest) => chest.hidden).length)),
    exits: sum(maps.map((map) => map.exits.length)),
    eventExits: sum(maps.map((map) => map.exits.filter((exit) => exit.kind === "event").length)),
    events: sum(maps.map((map) => map.events.length)),
    npcs: sum(maps.map((map) => map.npcs.length)),
    savePoints: sum(maps.map((map) => map.savePoints.length)),
    restorePoints: sum(maps.map((map) => map.restorePoints.length)),
    moveAreas: sum(maps.map((map) => map.moveAreas.length)),
    collisionLayers: sum(maps.map((map) => map.collision.length)),
    damageCells: sum(maps.flatMap((map) => map.damage.map((layer) => layer.cells.length))),
    hiddenPassageCells: sum(
      maps.flatMap((map) => map.hiddenPassages.map((layer) => layer.cells.length)),
    ),
    items: items.length,
    unresolved: {
      total: unresolved.length,
      byType,
      examples: unresolved
        .slice(0, 20)
        .map((entry) => `map ${entry.mapId} ${entry.file} ${entry.name} ${entry.reason}`),
    },
    atlas: atlasComparison,
    collisions: collisionComparison,
  };
}

function printSummary(summary: Summary): void {
  console.log(
    `地图 ${summary.maps}/${summary.mapsInCsv} 张（磁盘 ${summary.submapsOnDisk} 张子图，` +
      `${summary.unmappedSubmaps.length} 张无地图编号），宝箱 ${summary.chests} 个（隐藏 ${summary.hiddenItems}），` +
      `出口 ${summary.exits} 个（其中事件入口 ${summary.eventExits}），` +
      `事件 ${summary.events} 个，NPC ${summary.npcs} 个，` +
      `存档点 ${summary.savePoints} 个，回复点 ${summary.restorePoints} 个`,
  );
  console.log(
    `物品 ${summary.items} 条；碰撞 ${summary.collisionLayers} 层，伤害格 ${summary.damageCells}，` +
      `隐藏通道格 ${summary.hiddenPassageCells}，移动区域 ${summary.moveAreas}`,
  );
  const unresolvedTypes = Object.entries(summary.unresolved.byType)
    .map(([type, count]) => `${type}=${count}`)
    .join("，");
  console.log(`解析不了 ${summary.unresolved.total} 个物件：${unresolvedTypes}`);
  console.log(
    `地图记录 ${summary.atlas.mapsCompared} 张：宝箱 ${summary.atlas.chestsMatched}/${summary.atlas.chestsCompared} 一致，` +
      `出口 ${summary.atlas.exitsMatched}/${summary.atlas.exitsCompared} 一致，` +
      `不一致 ${summary.atlas.mismatches.length} 张`,
  );
  console.log(
    `碰撞缓存 ${summary.collisions.mapsCompared} 张：` +
      `${summary.collisions.cellsMatched}/${summary.collisions.cellsCompared} 格一致，` +
      `不一致 ${summary.collisions.mismatches.length} 张`,
  );
  const lines = [
    ...summary.atlas.mismatches.map(
      (item) =>
        `地图记录 ${item.mapId} ${item.mapName} ${item.kind}：` +
        `缺 ${item.missing.length === 0 ? "（无）" : item.missing.join(" ")}；` +
        `多 ${item.extra.length === 0 ? "（无）" : item.extra.join(" ")}`,
    ),
    ...summary.collisions.mismatches.map(
      (item) =>
        `碰撞缓存 ${item.mapId} ${item.mapName} ${item.layer}：${item.reason}，${item.cells} 格不一致`,
    ),
  ];
  for (const line of lines.slice(0, 20)) console.log(line);
}

async function main(): Promise<void> {
  const mapText = await readFile(join(FILES, "Data", "Master", "map.csv"), "utf8");
  const resources = parseMapCsv(mapText);
  const contentText = await readFile(join(FILES, "Data", "Master", "content.csv"), "utf8");
  const contents = parseContentCsv(contentText);
  const treasureText = await readFile(join(FILES, "Data", "Master", "treasure_box.csv"), "utf8");
  const treasureTypes = parseTreasureBoxCsv(treasureText);
  const groups = parseTransportationGroups(
    await readFile(join(FILES, "Data", "Master", "transportation_group.csv"), "utf8"),
  );
  const scriptNames = parseScriptNames(
    (await readOptionalText(join(FILES, "Data", "Master", "script.csv"))) ?? "",
  );
  const worldIds = new Set(resources.filter(isWorldMapResource).map((resource) => resource.id));
  const messageTable = async (language: string): Promise<Map<string, string>> => {
    const text = await readOptionalText(join(FILES, "Data", "Message", `system_${language}.txt`));
    return text === null ? new Map() : parseMessageTable(text);
  };
  const items = buildItems(contents, {
    ja: await messageTable("ja"),
    en: await messageTable("en"),
    zhc: await messageTable("zhc"),
  });

  const disk = await scanSubmaps(resources);
  const maps: ParsedMap[] = [];
  await mkdir(MAP_OUTPUT, { recursive: true });
  for (const resource of resources) {
    const parsed = await parseMap(resource, treasureTypes, groups, worldIds, scriptNames);
    if (parsed === null) continue;
    maps.push(parsed);
    await writeFile(
      join(MAP_OUTPUT, `${parsed.map.id}.json`),
      `${JSON.stringify(mapForJson(parsed), null, 2)}\n`,
      "utf8",
    );
  }

  const atlas = await readOptionalJson(join(DEPS, "ds", `atlas-${GAME}.json`));
  const caches = await readCaches();
  const atlasComparison = compareAtlas(maps, atlas);
  const collisionComparison = compareCollisions(maps, caches);
  const summary = buildSummary(
    maps,
    resources.length,
    disk,
    items,
    atlasComparison,
    collisionComparison,
  );

  await mkdir(OUTPUT, { recursive: true });
  const itemsById = Object.fromEntries(items.map((item) => [String(item.id), item]));
  await writeFile(join(OUTPUT, "items.json"), `${JSON.stringify(itemsById, null, 2)}\n`, "utf8");
  await writeFile(join(OUTPUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  printSummary(summary);
}

await main();
