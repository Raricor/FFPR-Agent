import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Backlog,
  Incidents,
  completionLine,
  completionState,
  isComplete,
  timedLine,
} from "../src/engine/completion.ts";
import { BestiarySave, hitKill, recordKills } from "../src/engine/bestiary-save.ts";
import { encounterParties, parseEncounters } from "../src/engine/encounters.ts";
import type { BattleRecord } from "../src/engine/battle-record.ts";
import { Game } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { Pilot } from "../src/engine/pilot.ts";
import type { Json } from "../src/engine/values.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

function battle(overrides: Partial<BattleRecord>): BattleRecord {
  return {
    id: 1,
    game: "ff5",
    startedAt: "2026-11-04T00:00:00.000Z",
    endedAt: "2026-11-04T00:01:00.000Z",
    mapId: 26,
    mapName: "火力船",
    kind: "regular",
    enemies: [],
    table: { kind: "map", mapId: 26, table: 1 },
    rewrites: [],
    result: "ok",
    detail: "",
    seconds: 60,
    turns: [],
    summary: { rules: [], items: {}, damageTaken: 0, damageDealt: 0 },
    events: [],
    ...overrides,
  };
}

void test("the completion line names missing chests, hidden items and monsters", () => {
  const state = completionState({
    mapId: 26,
    areaId: 26,
    mapName: "火力船",
    world: false,
    treasure: [
      { area: 26, name: "火力船", type: 1, total: 2, open: 1 },
      { area: 26, name: "火力船", type: 2, total: 1, open: 0 },
    ],
    entities: [
      { kind: "TresureBox", cell: [1, 1], contentName: "以太", hidden: false, opened: true },
      { kind: "TresureBox", cell: [2, 2], contentName: "金针", hidden: false, opened: false },
      { kind: "TresureBox", cell: [3, 3], contentName: "精灵披风", hidden: true, opened: false },
      { kind: "GotoMap", cell: [9, 9], toMap: 24 },
      { kind: "Event", name: "首领战", cell: [8, 8] },
      { kind: "Event", name: "流される①", cell: [7, 7] },
    ],
    monsters: [
      { name: "船员尘埃", book: 41 },
      { name: "败怨魔", book: 42 },
    ],
    known: new Set([41]),
  });
  assert.equal(
    completionLine(state),
    "本图完成度(火力船)：宝箱 1/2(没拿：(2,2) 金针) · 隐藏道具 0/1(没拿：(3,3) 精灵披风)" +
      " · 本图的怪 2 种，本档图鉴还缺 1 种：败怨魔",
  );
  assert.equal(isComplete(state), false);
  assert.deepEqual(state.exits, [[9, 9]]);
  assert.deepEqual(
    state.storyEvents.map((event) => event.label),
    ["首领战"],
  );
});

void test("the encounters reply carries the world map's region and its monsters", () => {
  const table = parseEncounters({
    encounters: {
      monsterSet: 7,
      parties: [{ id: 1, rate: 1000, monsters: [{ name: "祖", book: 20 }] }],
      region: {
        grid: 3,
        start: [20, 10],
        end: [40, 30],
        current: true,
        parties: [{ id: 2, rate: 1000, monsters: [{ name: "艾吉尔", book: 31 }] }],
      },
      regions: [
        {
          grid: 3,
          start: [20, 10],
          end: [40, 30],
          current: true,
          parties: [{ id: 2, rate: 1000, monsters: [{ name: "艾吉尔", book: 31 }] }],
        },
      ],
    },
  });
  assert.ok(table !== null);
  assert.equal(table.region?.grid, 3);
  assert.equal(table.regions.length, 1);
  assert.deepEqual(
    encounterParties(table).flatMap((party) => party.monsters.map((monster) => monster.name)),
    ["艾吉尔"],
  );
});

void test("the world map reports the current region's monsters", () => {
  const state = completionState({
    mapId: 1,
    areaId: 1,
    mapName: "世界地图",
    world: true,
    region: {
      grid: 3,
      start: [20, 10],
      end: [40, 30],
      current: true,
      parties: [{ id: 1, rate: 1000, notEscape: false, monsters: [{ name: "祖", book: 20 }] }],
    },
    regionLabel: "世界地图 · 区域 3((20,10)-(40,30))",
    treasure: [],
    entities: [],
    monsters: [{ name: "祖", book: 20 }],
    known: new Set(),
  });
  assert.match(completionLine(state), /本图完成度\(世界地图 · 区域 3/);
  assert.match(completionLine(state), /本档图鉴还缺 1 种：祖/);
});

void test("a backlog entry is added once and resolves when the place is complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-backlog-"));
  const path = join(directory, "backlog-ff5.jsonl");
  try {
    const backlog = await Backlog.load(path);
    await backlog.add({
      mapId: 24,
      areaId: 24,
      region: null,
      mapName: "卡纳克城",
      missing: ["宝箱 12/15(没拿：(4,7) 以太)"],
      reason: "需要钥匙",
      at: "2026-11-04T00:00:00.000Z",
    });
    await backlog.add({
      mapId: 24,
      areaId: 24,
      region: null,
      mapName: "卡纳克城",
      missing: ["宝箱 12/15(没拿：(4,7) 以太)"],
      reason: "需要钥匙",
      at: "2026-11-04T00:01:00.000Z",
    });
    assert.equal(backlog.pending().length, 1);
    const reloaded = await Backlog.load(path);
    assert.equal(reloaded.pending().length, 1);
    assert.equal(await reloaded.resolve(24, 24, null), 1);
    assert.equal(reloaded.pending().length, 0);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1] ?? "{}") as { resolvedAt?: string | null };
    assert.equal(last.resolvedAt !== null, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the Walse Tower incident is written once as 补记, and a later loss is a new incident", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-incidents-"));
  const path = join(directory, "incidents-ff5.jsonl");
  const state = join(directory, "incidents-state-ff5.json");
  try {
    const first = await Incidents.load(path, state);
    const created = await first.observe(
      [{ area: 71, place: "沃尔斯塔", missed: 2 }],
      "2026-11-04T00:00:00.000Z",
    );
    assert.equal(created.length, 1);
    const firstIncident = created[0];
    assert.ok(firstIncident !== undefined);
    assert.equal(firstIncident.supplement, true);
    assert.equal(firstIncident.lost, 2);
    assert.equal((await first.observe([{ area: 71, place: "沃尔斯塔", missed: 2 }])).length, 0);
    const later = await first.observe([{ area: 71, place: "沃尔斯塔", missed: 3 }]);
    assert.equal(later.length, 1);
    const laterIncident = later[0];
    assert.ok(laterIncident !== undefined);
    assert.equal(laterIncident.lost, 1);
    assert.equal(laterIncident.supplement, undefined);

    const reloaded = await Incidents.load(path, state);
    assert.equal(reloaded.entries.length, 2);
    assert.equal((await reloaded.observe([{ area: 71, place: "沃尔斯塔", missed: 3 }])).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the save-local bestiary restores from the save-count snapshot and adds later wins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-bestiary-"));
  const path = join(directory, "bestiary-save-ff5.json");
  try {
    const store = await BestiarySave.load("ff5", path);
    store.observeHit({
      type: "battle.hit",
      target: { side: "enemy", hp: 0, book: 41 },
    });
    assert.equal(hitKill({ type: "battle.hit", target: { side: "enemy", hp: 0, book: 41 } }), 41);
    assert.equal(hitKill({ type: "battle.hit", target: { side: "enemy", hp: 3, book: 41 } }), null);
    assert.deepEqual(
      recordKills(
        battle({
          enemies: [
            {
              name: "船员尘埃",
              id: 41,
              book: 41,
              maxHp: 1,
              hp: 0,
              mp: null,
              status: [],
              boss: false,
            },
          ],
        }),
      ),
      [41],
    );
    assert.deepEqual(
      recordKills(
        battle({
          result: "wipe",
          enemies: [
            {
              name: "船员尘埃",
              id: 41,
              book: 41,
              maxHp: 1,
              hp: 0,
              mp: null,
              status: [],
              boss: false,
            },
          ],
        }),
      ),
      [],
    );
    // Records written before bridge 0.13.6 have no book; the name map backfills them.
    assert.deepEqual(
      recordKills(
        battle({
          enemies: [
            { name: "船员尘埃", id: 41, maxHp: 1, hp: 0, mp: null, status: [], boss: false },
          ],
        }),
        new Map([["船员尘埃", 41]]),
      ),
      [41],
    );
    await store.snapshot(1, "2026-11-04T00:00:00.000Z");
    const reloaded = await BestiarySave.load("ff5", path);
    reloaded.restore(1, [
      battle({
        startedAt: "2026-11-03T23:00:00.000Z",
        enemies: [
          { name: "旧怪", id: 9, book: 9, maxHp: 1, hp: 0, mp: null, status: [], boss: false },
        ],
      }),
      battle({
        startedAt: "2026-11-04T01:00:00.000Z",
        enemies: [
          { name: "败怨魔", id: 42, book: 42, maxHp: 1, hp: 0, mp: null, status: [], boss: false },
        ],
      }),
    ]);
    assert.deepEqual(
      [...reloaded.numbers].sort((a, b) => a - b),
      [41, 42],
    );
    assert.equal(reloaded.has(9), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function completionGame(directory: string): Promise<Game> {
  return await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    atlasFile: join(directory, "atlas.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    backlogFile: join(directory, "backlog-ff5.jsonl"),
    incidentsFile: join(directory, "incidents-ff5.jsonl"),
    incidentsStateFile: join(directory, "incidents-state-ff5.json"),
    bestiarySaveFile: join(directory, "bestiary-save-ff5.json"),
  });
}

function answerCompletion(
  pilot: FakePilot,
  complete = false,
  area = 71,
  mapName = "沃尔斯塔",
  bestiary: readonly {
    readonly number: number;
    readonly name: string;
    readonly areas: readonly number[];
  }[] = [],
): void {
  pilot.on("pos", {
    pos: {
      map: area,
      area: area,
      areaType: 1,
      areaText: mapName,
      state: "Player",
      cell: [2, 2],
      saves: 1,
    },
  });
  pilot.onQuery("achievements", {
    achievements: {
      defs: [],
      save: {
        playTime: 1,
        saveCount: 1,
        chests: complete ? 2 : 1,
        hiddenItems: 1,
        treasure: [
          { area, name: mapName, type: 1, total: 2, open: complete ? 2 : 1 },
          { area, name: mapName, type: 2, total: 1, open: 1 },
        ],
        members: [],
        flags: {},
      },
      bestiary:
        bestiary.length === 0
          ? null
          : {
              entries: bestiary.map((entry) => ({ ...entry, registered: false })),
              areas: {},
            },
    },
  });
  pilot.on("entities", {
    entities: {
      total: 5,
      entities: [
        { kind: "TresureBox", cell: [4, 7], contentName: "以太", opened: complete },
        { kind: "TresureBox", cell: [5, 7], contentName: "金针", opened: true },
        { kind: "TresureBox", cell: [6, 7], contentName: "精灵披风", hidden: true, opened: true },
        { kind: "GotoMap", cell: [9, 9], toMap: 25 },
        { kind: "Event", name: `${mapName}首领战`, cell: [8, 8] },
      ],
    },
  });
  pilot.onQuery("encounters", {
    encounters: {
      monsterSet: 5,
      parties: [
        {
          id: 1,
          rate: 1000,
          monsters: [
            { name: "船员尘埃", book: 41 },
            { name: "败怨魔", book: 42 },
          ],
        },
      ],
    },
  });
}

void test("leaving an incomplete map is refused, allowed with a reason, and the backlog clears", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-leave-"));
  const pilot = new FakePilot();
  try {
    const game = await completionGame(directory);
    answerCompletion(pilot);
    const state = await (
      game as unknown as {
        refreshCompletion(pilot: Pilot): Promise<ReturnType<typeof completionState> | null>;
      }
    ).refreshCompletion(pilot);
    assert.ok(state !== null);
    assert.equal(state.chests.total, 2);
    assert.equal(state.chests.open, 1);
    assert.equal(state.monsters.missing.length, 2);
    assert.deepEqual(state.exits, [[9, 9]]);
    const guard = (
      game as unknown as {
        guardLeave(
          args: Json,
          pilot: Pilot,
          goal: readonly [number, number],
        ): Promise<{ text: string; early?: boolean } | null>;
      }
    ).guardLeave.bind(game);

    const refused = await guard({}, pilot, [9, 9]);
    assert.ok(refused !== null);
    assert.match(refused.text, /还没完成：宝箱 1\/2/);
    assert.match(refused.text, /本图鉴还缺 2 种/);
    assert.match(refused.text, /leave_incomplete/);

    const allowed = await guard({ leave_incomplete: "需要钥匙" }, pilot, [9, 9]);
    assert.equal(allowed, null);
    assert.equal(game.backlog.pending().length, 1);
    assert.equal(game.backlog.pending()[0]?.reason, "需要钥匙");

    // The one-time place also refuses a named story/boss event cell, not only the exit.
    const story = await guard({}, pilot, [8, 8]);
    assert.ok(story !== null);
    assert.match(story.text, /一次性地点/);

    // Complete it: both chests open, both monsters in this save's bestiary, and the debt closes.
    answerCompletion(pilot, true);
    game.bestiary.numbers.add(41);
    game.bestiary.numbers.add(42);
    const done = await guard({}, pilot, [9, 9]);
    assert.equal(done, null);
    assert.equal(game.backlog.pending().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a timed escape is allowed even with chests and monsters missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-timed-"));
  const pilot = new FakePilot();
  try {
    const game = await completionGame(directory);
    answerCompletion(pilot, false, 24, "卡纳克城");
    const guard = (
      game as unknown as {
        guardLeave(
          args: Json,
          pilot: Pilot,
          goal: readonly [number, number],
        ): Promise<{ text: string; early?: boolean } | null>;
      }
    ).guardLeave.bind(game);
    assert.equal(await guard({}, pilot, [9, 9]), null);
    assert.equal(game.backlog.pending().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a timed escape is not blocked but lists the remaining chests", () => {
  const state = completionState({
    mapId: 24,
    areaId: 24,
    mapName: "卡纳克城",
    world: false,
    timedUntil: "火力船首领后的 10 分钟逃脱里",
    treasure: [{ area: 24, name: "卡纳克城", type: 1, total: 15, open: 3 }],
    entities: [{ kind: "TresureBox", cell: [4, 7], contentName: "以太", opened: false }],
    monsters: [],
    known: new Set(),
  });
  assert.match(timedLine(state), /限时地点\(火力船首领后的 10 分钟逃脱里\)/);
  assert.match(timedLine(state), /还剩 1 个宝箱：\(4,7\) 以太/);
});

void test("each map counts only its own chest entities; other maps of the area are a note", () => {
  const state = completionState({
    mapId: 72,
    areaId: 72,
    mapName: "风之神殿 1 层",
    world: false,
    treasure: [{ area: 72, name: "风之神殿", type: 1, total: 4, open: 1 }],
    entities: [{ kind: "TresureBox", cell: [1, 1], contentName: "宝箱", opened: true }],
    monsters: [],
    encounter: "none",
    known: new Set(),
  });
  assert.equal(state.chests.total, 1);
  assert.equal(state.chests.open, 1);
  assert.equal(state.chests.missing.length, 0);
  assert.equal(state.chests.elsewhere, 3);
  assert.equal(isComplete(state), true);
  assert.match(completionLine(state), /宝箱 1\/1 ✓\(风之神殿别的图里还有 3 个没开\)/);
});

function guardOf(
  game: Game,
): (
  args: Json,
  pilot: Pilot,
  goal: readonly [number, number],
) => Promise<{ text: string; early?: boolean } | null> {
  return (
    game as unknown as {
      guardLeave(
        args: Json,
        pilot: Pilot,
        goal: readonly [number, number],
      ): Promise<{ text: string; early?: boolean } | null>;
    }
  ).guardLeave.bind(game);
}

void test("disabled encounters require no grinding even when habitats list monsters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-disabled-"));
  const pilot = new FakePilot();
  try {
    const game = await completionGame(directory);
    answerCompletion(pilot, true, 71, "沃尔斯塔", [{ number: 90, name: "破影", areas: [71] }]);
    pilot.onQuery("encounters", {
      encounters: {
        enabled: false,
        parties: [{ rate: 1000, monsters: [{ name: "破影", book: 90 }] }],
      },
    });
    const state = await (
      game as unknown as {
        refreshCompletion(pilot: Pilot): Promise<ReturnType<typeof completionState> | null>;
      }
    ).refreshCompletion(pilot);
    assert.ok(state !== null);
    assert.equal(state.encounter, "none");
    assert.equal(state.monsters.total, 0);
    assert.equal(
      completionLine(state),
      "本图完成度(沃尔斯塔)：宝箱 2/2 ✓ · 隐藏道具 1/1 ✓ · 本图现在不遇敌",
    );
    assert.equal(await guardOf(game)({}, pilot, [9, 9]), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the whole map's parties are the union, and rate-0 formations do not count", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-map-union-"));
  const pilot = new FakePilot();
  try {
    const game = await completionGame(directory);
    answerCompletion(pilot, true);
    pilot.onQuery("encounters", {
      encounters: {
        enabled: true,
        // The cell underfoot has none; the region's list must not replace the map union.
        parties: [],
        region: {
          grid: 3,
          start: [1, 1],
          end: [9, 9],
          current: true,
          parties: [{ rate: 1000, monsters: [{ name: "区域怪", book: 99 }] }],
        },
        map: {
          scope: "map",
          grids: [1, 2],
          parties: [
            { rate: 1000, monsters: [{ name: "甲怪", book: 41 }] },
            { rate: 500, monsters: [{ name: "乙怪", book: 42 }] },
            { rate: 0, monsters: [{ name: "不出的怪", book: 43 }] },
          ],
        },
      },
    });
    const state = await (
      game as unknown as {
        refreshCompletion(pilot: Pilot): Promise<ReturnType<typeof completionState> | null>;
      }
    ).refreshCompletion(pilot);
    assert.ok(state !== null);
    assert.equal(state.monsters.total, 2);
    assert.deepEqual(
      state.monsters.missing.map((monster) => monster.name),
      ["甲怪", "乙怪"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("an old bridge reply without map still uses the parties underfoot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-old-bridge-"));
  const pilot = new FakePilot();
  try {
    const game = await completionGame(directory);
    answerCompletion(pilot, true);
    pilot.onQuery("encounters", {
      encounters: {
        parties: [{ rate: 1000, monsters: [{ name: "脚下怪", book: 41 }] }],
        region: {
          grid: 3,
          start: [1, 1],
          end: [9, 9],
          current: true,
          parties: [{ rate: 1000, monsters: [{ name: "区域怪", book: 99 }] }],
        },
      },
    });
    const state = await (
      game as unknown as {
        refreshCompletion(pilot: Pilot): Promise<ReturnType<typeof completionState> | null>;
      }
    ).refreshCompletion(pilot);
    assert.ok(state !== null);
    assert.equal(state.encounter, "ok");
    assert.deepEqual(
      state.monsters.missing.map((monster) => monster.name),
      ["脚下怪"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("an unreadable encounter table never falls back to the bestiary's habitats", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-no-encounters-"));
  const pilot = new FakePilot();
  try {
    const game = await completionGame(directory);
    answerCompletion(pilot, true, 71, "风之神殿 1 层", [
      { number: 90, name: "巨翼猛禽", areas: [71] },
    ]);
    pilot.onQuery("encounters", { encounters: null });
    const state = await (
      game as unknown as {
        refreshCompletion(pilot: Pilot): Promise<ReturnType<typeof completionState> | null>;
      }
    ).refreshCompletion(pilot);
    assert.ok(state !== null);
    assert.equal(state.encounter, "unknown");
    assert.equal(state.monsters.total, 0);
    assert.match(completionLine(state), /读不到遇敌表/);
    assert.doesNotMatch(completionLine(state), /巨翼猛禽/);
    assert.equal(await guardOf(game)({}, pilot, [9, 9]), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
