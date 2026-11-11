import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildItems,
  buildWorldMap,
  mapTitleNames,
  compareAtlas,
  compareCollisions,
  objectCell,
  objectRect,
  parseAttributeLayer,
  parseCollisionLayers,
  parseContentCsv,
  parseEntity,
  parseEventFile,
  parseEventNpcs,
  parseMapCsv,
  parseMessageTable,
  parseScriptNames,
  parseSubmap,
  parseTransportationGroups,
  parseTreasureBoxCsv,
  parseValueLayers,
  parseWorldArrivals,
  parseWorldExitScripts,
  type MapResource,
} from "../src/engine/knowledge/game-files.ts";
import { DEPS } from "../src/engine/paths.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "game-files");

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

const mapCsv = await readFile(join(FIXTURE, "map.csv"), "utf8");
const contentCsv = await readFile(join(FIXTURE, "content.csv"), "utf8");
const entity = await json(join(FIXTURE, "entity_default.json"));
const eventFile = await json(join(FIXTURE, "ev_e_0021.json"));
const collision = await json(join(FIXTURE, "collision.json"));
const damage = await json(join(FIXTURE, "damage.json"));
const hiddenPassage = await json(join(FIXTURE, "hidden_passage.json"));
const atlas = await json(join(FIXTURE, "atlas.json"));
const collisionCache = await json(join(FIXTURE, "collision-cache.json"));
const treasureTypes = parseTreasureBoxCsv(
  await readFile(join(FIXTURE, "treasure_box.csv"), "utf8"),
);

void test("map.csv gives the id, Tiled directory and package name", () => {
  const maps = parseMapCsv(mapCsv);
  assert.equal(maps.length, 2);
  assert.deepEqual(
    maps.map((map) => [map.id, map.name, map.packageName, map.areaId]),
    [
      [30, "Map_92010", "Map_92010", 9],
      [30041, "Map_93041_7", "Map_93041", 26],
    ],
  );
  assert.deepEqual(
    [...treasureTypes.entries()],
    [
      [0, 1],
      [1, 2],
    ],
  );
});

void test("a map title resolves all three languages from its message keys", () => {
  const maps = parseMapCsv(
    ["id,map_name,asset_name,map_title", "33,Map_1,,TITLE_A", "34,Map_2,,"].join("\n"),
  );
  const messages = {
    ja: new Map([["TITLE_A", "試し酒場"]]),
    en: new Map([["TITLE_A", "Test Pub"]]),
    zhc: new Map([["TITLE_A", "试酒馆"]]),
  };
  const titled = maps[0];
  assert.ok(titled);
  assert.deepEqual(mapTitleNames(titled, messages), {
    ja: "試し酒場",
    en: "Test Pub",
    zhc: "试酒馆",
  });
  const without = maps[1];
  assert.ok(without);
  assert.deepEqual(mapTitleNames(without, messages), {
    ja: null,
    en: null,
    zhc: null,
  });
});

void test("a gid object's cell is x/16 and y/16-1", () => {
  const chest = { gid: 1023, x: 480, y: 224, width: 16, height: 16 };
  assert.deepEqual(objectCell(chest), [30, 13]);
  assert.deepEqual(objectRect(chest), { x1: 30, y1: 13, x2: 30, y2: 13 });
});

void test("a rectangle without gid uses its top-left and an inclusive span", () => {
  const tall = { x: 320, y: 432, width: 16, height: 48 };
  assert.deepEqual(objectCell(tall), [20, 27]);
  assert.deepEqual(objectRect(tall), { x1: 20, y1: 27, x2: 20, y2: 29 });
  const wide = { x: 416, y: 496, width: 112, height: 48 };
  assert.deepEqual(objectRect(wide), { x1: 26, y1: 31, x2: 32, y2: 33 });
});

void test("entity_default gives chests, exits, NPCs, save points and move areas", () => {
  const parsed = parseEntity(entity, treasureTypes);
  assert.deepEqual(
    parsed.chests.map((chest) => [chest.cell, chest.contentId, chest.flagId, chest.hidden]),
    [
      [[30, 13], 4, 0, false],
      [[40, 13], 251, 1, true],
    ],
  );
  assert.equal(parsed.chests[0]?.name, "宝箱A");
  assert.deepEqual(
    parsed.exits.map((exit) => [exit.cell, exit.toMap, exit.toPoint, exit.kind]),
    [
      [[18, 45], 31, 1, "goto"],
      [[32, 51], 1, null, "world"],
    ],
  );
  assert.equal(parsed.npcs.length, 1);
  assert.equal(parsed.npcs[0]?.name, "测试NPC（蓝发）");
  assert.deepEqual(
    parsed.savePoints.map((point) => point.cell),
    [[5, 6]],
  );
  assert.deepEqual(
    parsed.restorePoints.map((point) => point.cell),
    [[6, 7]],
  );
  assert.deepEqual(
    parsed.moveAreas.map((area) => area.rect),
    [
      { x1: 20, y1: 27, x2: 20, y2: 29 },
      { x1: 26, y1: 31, x2: 32, y2: 33 },
    ],
  );
  assert.equal(parsed.unresolved.length, 1);
  assert.equal(parsed.unresolved[0]?.reason, "缺少 object_type");
});

void test("content_id becomes three names with icon tags removed", async () => {
  const contents = parseContentCsv(contentCsv);
  const messages = {
    ja: parseMessageTable(await readFile(join(FIXTURE, "system_ja.txt"), "utf8")),
    en: parseMessageTable(await readFile(join(FIXTURE, "system_en.txt"), "utf8")),
    zhc: parseMessageTable(await readFile(join(FIXTURE, "system_zhc.txt"), "utf8")),
  };
  const items = buildItems(contents, messages);
  const phoenix = items.find((item) => item.id === 4);
  assert.ok(phoenix !== undefined);
  assert.deepEqual(phoenix.names, {
    ja: "测试羽毛",
    en: "Test Feather",
    zhc: "测试羽毛",
  });
  assert.equal(phoenix.kind, "item");
  const gil = items.find((item) => item.id === 1);
  assert.ok(gil !== undefined);
  assert.equal(gil.kind, "gil");
  assert.deepEqual(gil.names, {
    ja: "测试金币",
    en: "Test Gil",
    zhc: "测试金币",
  });
  assert.ok(
    items.every(
      (item) =>
        ![item.names.ja, item.names.en, item.names.zhc].some((name) => name?.includes("<IC_")),
    ),
  );
});

void test("collision keeps every cell value and damage/hidden passage keep non-zero cells", () => {
  assert.deepEqual(parseCollisionLayers(collision), [
    {
      name: "GroundCollision",
      width: 4,
      height: 3,
      rows: ["0100", "0007", "0040"],
    },
  ]);
  assert.deepEqual(parseValueLayers(damage), [
    { name: "GroundDamage", width: 2, height: 2, cells: [[1, 0, 2]] },
  ]);
  assert.deepEqual(parseValueLayers(hiddenPassage), [
    {
      name: "GroundHiddenPassage",
      width: 3,
      height: 2,
      cells: [
        [2, 0, 1],
        [1, 1, 2],
      ],
    },
  ]);
});

void test("ev_e files keep event triggers and drop their NPC placements", () => {
  const triggers = parseEventFile("ev_e_0021.json", eventFile);
  assert.equal(triggers.length, 1);
  const trigger = triggers[0];
  assert.ok(trigger !== undefined);
  assert.equal(trigger.name, "sc_e_0021:测试之家");
  assert.deepEqual(trigger.cell, [33, 24]);
  assert.equal(trigger.scriptId, 56);
  const npcs = parseEventNpcs("ev_e_0021.json", eventFile);
  assert.equal(npcs.length, 1);
  assert.equal(npcs[0]?.file, "ev_e_0021.json");
});

void test("parseSubmap combines entity, events, collision, damage and hidden passages", () => {
  const maps = parseMapCsv(mapCsv);
  const map = maps[0];
  assert.ok(map !== undefined);
  const parsed = parseSubmap({
    map,
    entity,
    treasureTypes,
    collision,
    damage,
    hiddenPassage,
    events: [{ file: "ev_e_0021.json", value: eventFile }],
  });
  assert.equal(parsed.chests.length, 2);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.npcs.length, 1);
  assert.equal(parsed.npcs[0]?.file, "entity_default.json");
  assert.equal(parsed.collision.length, 1);
  assert.equal(parsed.damage[0]?.cells.length, 1);
  assert.equal(parsed.hiddenPassages[0]?.cells.length, 2);
});

void test("world attribute plus transportation groups become per-vehicle rows", () => {
  const attribute = parseAttributeLayer({
    layers: [
      {
        name: "GroundAttribute",
        type: "tilelayer",
        width: 3,
        height: 2,
        data: [2, 16, 4, 4, 2, 16],
      },
    ],
  });
  assert.deepEqual(attribute, {
    width: 3,
    height: 2,
    values: [2, 16, 4, 4, 2, 16],
  });
  const groups = parseTransportationGroups(
    ["id,type1,type2,type3,type_4", "1,0,1,0,1", "2,1,0,0,0"].join("\n"),
  );
  assert.deepEqual([...(groups.get(1) ?? [])], [2, 4]);
  assert.deepEqual([...(groups.get(2) ?? [])], [1]);
  groups.set(2, new Set([16])); // the ship's flags are indexed by attribute value
  const world = buildWorldMap(attribute, groups, []);
  assert.deepEqual(world.modes.walk, ["101", "110"]);
  assert.deepEqual(world.modes.ship, ["010", "001"]);
});

void test("world arrival points use object_id and world scripts name their ChangeMap", () => {
  const arrivals = parseWorldArrivals({
    layers: [
      {
        objects: [
          {
            gid: 1,
            x: 16,
            y: 16,
            name: "4:测试村",
            properties: [
              { name: "object_type", value: 0 },
              { name: "object_id", value: 4 },
            ],
          },
          {
            name: "not an arrival",
            properties: [{ name: "object_type", value: 3 }],
          },
        ],
      },
    ],
  });
  assert.deepEqual(arrivals, [{ point: 4, cell: [1, 0], name: "4:测试村" }]);
  const exits = parseWorldExitScripts(
    [
      {
        file: "sc_20010_to_world.json",
        value: {
          Mnemonics: [
            { mnemonic: "Nop", operands: {} },
            { mnemonic: "ChangeMap", operands: { iValues: [1, 4, 0, 0, 1] } },
            { mnemonic: "ChangeMap", operands: { iValues: [19, 7, 0, 0, 1] } },
          ],
        },
      },
    ],
    new Set([1]),
  );
  assert.deepEqual(exits, [{ to: 1, point: 4 }]);
});

void test("script.csv maps an object's script_id to its script name", () => {
  const names = parseScriptNames("id,script_name\n1002,sc_10010_to_30020\n");
  assert.deepEqual([...names.entries()], [[1002, "sc_10010_to_30020"]]);
});

void test("a world-map event with a ChangeMap script becomes an event exit", () => {
  const world: MapResource = {
    id: 1,
    name: "Map_10010",
    assetName: "map_10010",
    packageName: "Map_10010",
    titleKey: null,
    areaId: 1,
    saveAvailable: true,
    monsterSetId: 0,
    encountAreaGridId: 1,
  };
  const entity = {
    layers: [
      {
        objects: [
          {
            gid: 1,
            x: 165 * 16,
            y: (115 + 1) * 16,
            width: 16,
            height: 16,
            name: "测试世界入口",
            properties: [
              { name: "object_type", value: 2 },
              { name: "script_id", value: 1002 },
            ],
          },
        ],
      },
    ],
  };
  const parsed = parseSubmap({
    map: world,
    entity,
    collision: null,
    damage: null,
    hiddenPassage: null,
    events: [],
    scriptNames: new Map([[1002, "sc_10010_to_30020"]]),
    packageScripts: [
      {
        name: "sc_10010_to_30020",
        value: {
          Mnemonics: [
            { mnemonic: "ChangeMap", operands: { iValues: [191, 1] } },
            { mnemonic: "Exit", operands: { iValues: [] } },
          ],
        },
      },
    ],
  });
  assert.deepEqual(
    parsed.exits.map((exit) => [exit.cell, exit.toMap, exit.toPoint, exit.kind]),
    [[[165, 115], 191, 1, "event"]],
  );
});

void test("the real world map export has the pirate hideout event entrance", async (t) => {
  const path = join(DEPS, "knowledge", "ff5", "files", "maps", "1.json");
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch {
    t.skip("本机没有真实的世界地图导出");
    return;
  }
  const parsed = JSON.parse(body) as { exits?: unknown };
  const exits = Array.isArray(parsed.exits) ? (parsed.exits as Record<string, unknown>[]) : [];
  const entrance = exits.find(
    (exit) => exit.kind === "event" && exit.toMap === 191 && Array.isArray(exit.cell),
  );
  if (entrance === undefined) {
    t.skip("本机导出还是旧版，重跑 scripts/game-files.mts 后再查");
    return;
  }
  const cell = entrance.cell as unknown[];
  assert.ok(Math.abs((cell[0] as number) - 165) <= 1);
  assert.ok(Math.abs((cell[1] as number) - 115) <= 1);
});

void test("atlas and collision cache comparison find no fixture mismatch", () => {
  const map = parseMapCsv(mapCsv)[0];
  assert.ok(map !== undefined);
  const parsed = parseSubmap({
    map,
    entity,
    treasureTypes,
    collision,
    damage,
    hiddenPassage,
    events: [{ file: "ev_e_0021.json", value: eventFile }],
  });
  const atlasResult = compareAtlas([parsed], atlas);
  assert.equal(atlasResult.mapsCompared, 1);
  assert.equal(atlasResult.chestsCompared, 2);
  assert.equal(atlasResult.chestsMatched, 2);
  assert.equal(atlasResult.exitsCompared, 2);
  assert.equal(atlasResult.exitsMatched, 2);
  assert.deepEqual(atlasResult.mismatches, []);
  const collisionResult = compareCollisions([parsed], collisionCache);
  assert.equal(collisionResult.mapsCompared, 1);
  assert.equal(collisionResult.cellsCompared, 12);
  assert.equal(collisionResult.cellsMatched, 12);
  assert.deepEqual(collisionResult.mismatches, []);
});

const realRoot = join(DEPS, "ff5", "files");
let realFiles = true;
try {
  await access(join(realRoot, "Data", "Master", "map.csv"));
} catch {
  realFiles = false;
}

async function realEntity(name: string, packageName: string): Promise<unknown> {
  return json(join(realRoot, "Res", "Map", packageName, name, "entity_default.json"));
}

void test(
  "real files: Torul's five chests and the Wind Shrine 4F staff",
  { skip: realFiles ? false : "没有 .deps/ff5/files，跳过真实文件测试" },
  async () => {
    const maps = parseMapCsv(await readFile(join(realRoot, "Data", "Master", "map.csv"), "utf8"));
    const torul = maps.find((map) => map.id === 30);
    const wind = maps.find((map) => map.name === "Map_30041_7");
    assert.ok(torul !== undefined);
    assert.ok(wind !== undefined);
    const contents = parseContentCsv(
      await readFile(join(realRoot, "Data", "Master", "content.csv"), "utf8"),
    );
    const messages = {
      ja: parseMessageTable(
        await readFile(join(realRoot, "Data", "Message", "system_ja.txt"), "utf8"),
      ),
      en: parseMessageTable(
        await readFile(join(realRoot, "Data", "Message", "system_en.txt"), "utf8"),
      ),
      zhc: parseMessageTable(
        await readFile(join(realRoot, "Data", "Message", "system_zhc.txt"), "utf8"),
      ),
    };
    const items = new Map(buildItems(contents, messages).map((item) => [item.id, item]));
    const torulChests = parseEntity(await realEntity(torul.name, torul.packageName)).chests;
    const named = new Map(
      torulChests.map((chest) => [
        `${chest.cell[0]},${chest.cell[1]}`,
        items.get(chest.contentId)?.names.en ?? null,
      ]),
    );
    assert.deepEqual(
      named,
      new Map([
        ["30,13", "Phoenix Down"],
        ["40,13", "Leather Shoes"],
        ["29,28", "Tent"],
        ["30,28", "Potion"],
        ["45,36", "Gil"],
      ]),
    );
    const windChests = parseEntity(await realEntity(wind.name, wind.packageName)).chests;
    assert.ok(
      windChests.some(
        (chest) => chest.cell[0] === 28 && chest.cell[1] === 17 && chest.contentId === 136,
      ),
    );
  },
);
