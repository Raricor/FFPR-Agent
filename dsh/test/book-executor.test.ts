/**
 * Task 117: `route {}` runs a route book section. The book is hand-written here; the fake bridge
 * only knows one 20×20 room with chests and an Event cell, so the test sees exactly what the
 * executor does: open, hand back, learn the model's cell, and continue.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Game } from "../src/engine/game.ts";
import { loadKnowledge } from "../src/engine/knowledge/index.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { Cell } from "../src/engine/nav.ts";
import type { Reply } from "../src/engine/pilot.ts";
import type { BookProgress } from "../src/engine/stage/book-progress-types.ts";

import type {
  RouteBook,
  RouteChest,
  RouteSection,
  RouteStation,
} from "../src/engine/stage/route-book.ts";
import type { StageOfficerRunner } from "../src/engine/stage/runner.ts";
import { ROUTE_BOOK_PLAN_VERSION } from "../src/engine/stage/book-version.ts";
import type { StagePlan } from "../src/engine/stage/types.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = {
  host: "laptop",
  user: "player",
  key: "/tmp/key",
  root: "C:/ffpr",
};

const MAP = 71;
const MAP_NAME = "测试洞窟";

interface World {
  map: number;
  cell: Cell;
  readonly chests: readonly { cell: Cell; label: string }[];
  readonly opened: Set<string>;
  readonly openedOrder: string[];
  readonly events: readonly { cell: Cell; name: string; active?: boolean }[];
}

function keyOf(cell: Cell): string {
  return `${cell[0]},${cell[1]}`;
}

function world(overrides: Partial<World> = {}): World {
  return {
    map: MAP,
    cell: [1, 5],
    chests: [
      { cell: [2, 5], label: "帐篷" },
      { cell: [4, 5], label: "解毒药" },
    ],
    opened: new Set(),
    openedOrder: [],
    events: [],
    ...overrides,
  };
}

function position(value: World): Reply {
  return {
    pos: {
      map: value.map,
      area: value.map,
      areaType: 1,
      areaText: MAP_NAME,
      state: "Player",
      cell: value.cell,
      saves: 1,
      battle: false,
    },
  };
}

function entities(value: World, kind: string): Reply[] {
  const out: Reply[] = value.chests.map((chest) => ({
    kind: "TresureBox",
    cell: chest.cell,
    contentName: chest.label,
    opened: value.opened.has(keyOf(chest.cell)),
  }));
  for (const event of value.events) {
    out.push({
      kind: "Event",
      name: event.name,
      cell: event.cell,
      active: event.active ?? true,
    });
  }
  return out.filter((entity) => kind === "All" || entity.kind === kind);
}

function pilotFor(value: World): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", () => position(value));
  pilot.on("cells", () => ({
    cells: {
      origin: [0, 0],
      center: [value.cell[0], value.cell[1]],
      attr: Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 0)),
    },
  }));
  pilot.on("collision", () => ({
    collision: {
      searchLayer: 1,
      playerCell: [value.cell[0], value.cell[1]],
      layers: [
        {
          name: "GroundCollision",
          rows: Array.from({ length: 20 }, () => "0".repeat(20)),
        },
      ],
    },
  }));
  pilot.on("entities", (fields) => ({
    entities: {
      total: entities(value, String(fields.kind)).length,
      entities: entities(value, String(fields.kind)),
    },
  }));
  pilot.on("route", { route: {} });
  pilot.on("walkpath", { ok: false, error: "walkpath_unsupported" });
  pilot.on("walk", (fields) => {
    const to = fields.to;
    if (!Array.isArray(to) || typeof to[0] !== "number" || typeof to[1] !== "number") {
      return { ok: false, error: "bad_target", ...position(value) };
    }
    value.cell = [to[0], to[1]];
    return { ok: true, ...position(value) };
  });
  pilot.on("keys", (fields) => {
    const keys = Array.isArray(fields.keys) ? fields.keys : [];
    if (keys.some((key) => key === "Enter")) {
      const chest = value.chests.find(
        (candidate) =>
          !value.opened.has(keyOf(candidate.cell)) &&
          Math.abs(candidate.cell[0] - value.cell[0]) +
            Math.abs(candidate.cell[1] - value.cell[1]) ===
            1,
      );
      if (chest !== undefined) {
        value.opened.add(keyOf(chest.cell));
        value.openedOrder.push(keyOf(chest.cell));
      }
    }
    return { ok: true };
  });
  pilot.on("story", { pages: 1, stop: "free" });
  pilot.onQuery("sample", {
    sample: {
      party: [
        {
          name: "巴兹",
          jobName: "青魔导士",
          lv: 10,
          hp: 100,
          maxHp: 100,
          mp: 20,
          maxMp: 20,
          status: [],
          abilities: [],
        },
      ],
      gil: 100,
    },
  });
  pilot.onQuery("items", { items: { normal: [], important: [] } });
  pilot.onQuery("achievements", {
    achievements: {
      defs: [],
      save: {
        playTime: 1,
        saveCount: 1,
        chests: 0,
        hiddenItems: 0,
        treasure: [],
        members: [],
        flags: {},
      },
      bestiary: null,
    },
  });
  pilot.onQuery("encounters", {
    encounters: {
      monsterSet: null,
      parties: [],
      region: null,
      regions: [],
      enabled: false,
    },
  });
  pilot.onQuery("shop", { shop: { open: false, products: [] } });
  pilot.on("wait", { ok: true });
  pilot.onQuery("textinput", { textinput: { open: false } });
  return pilot;
}

function chest(
  stepIndex: number,
  cell: Cell | null,
  opened = false,
  candidates: { mapId: number; cell: Cell; opened: boolean }[] = [],
): RouteChest {
  return {
    stepIndex,
    where: null,
    kind: "chest",
    n: stepIndex + 1,
    item: "帐篷",
    text: "Open the chest",
    mapId: cell === null ? null : MAP,
    mapName: cell === null ? null : MAP_NAME,
    cell,
    opened,
    match: cell === null && candidates.length > 0 ? "none" : "name",
    note: "",
    candidates: candidates.map((candidate) => ({
      mapId: candidate.mapId,
      mapName: MAP_NAME,
      cell: candidate.cell,
      name: "帐篷",
      opened: candidate.opened,
    })),
  };
}

function station(
  index: number,
  kind: RouteStation["kind"],
  cell: Cell | null,
  chestValue: RouteChest | null = null,
  mapId = MAP,
): RouteStation {
  return {
    index,
    where: null,
    kind,
    mapId,
    cell,
    action: kind,
    text: `guide ${kind}`,
    basis: "test",
    chest: chestValue,
    pointCandidate: null,
  };
}

function section(
  stations: readonly RouteStation[],
  chests: readonly RouteChest[] = [],
  overrides: Partial<RouteSection> = {},
): RouteSection {
  return {
    title: "测试洞窟",
    order: 0,
    areaName: MAP_NAME,
    maps: [{ mapId: MAP, name: MAP_NAME, areaName: MAP_NAME, reasons: ["test"] }],
    ...overrides,
    places: [],
    stations,
    notes: [],
    chests,
    guideChestItems: [],
    chestsMatched: chests.length,
    chestsTotal: chests.length,
    monsters: [],
    bosses: [],
    blueMagic: [],
    grind: [],
    revisit: null,
    bestiaryMissing: 0,
    blueMagicMissing: 0,
    mismatches: [],
  };
}

function bookOf(sections: readonly RouteSection[]): RouteBook {
  const first = sections[0];
  if (first === undefined) throw new Error("book needs a section");
  return {
    fromSection: first.title,
    fromPlace: null,
    toSection: sections[sections.length - 1]?.title ?? first.title,
    sections,
    totals: {
      sections: sections.length,
      stations: sections.reduce((sum, item) => sum + item.stations.length, 0),
      chestsMatched: sections.reduce((sum, item) => sum + item.chestsMatched, 0),
      chestsTotal: sections.reduce((sum, item) => sum + item.chestsTotal, 0),
      bestiaryMissing: 0,
      bestiaryUnknown: false,
      blueMagicMissing: 0,
      revisit: 0,
      mismatches: 0,
    },
  };
}

function book(sectionValue: RouteSection): RouteBook {
  return bookOf([sectionValue]);
}

async function makeGame(
  directory: string,
  bookValue: RouteBook,
  officer?: StageOfficerRunner,
  extraAtlas: Record<string, unknown> = {},
): Promise<{
  readonly game: Game;
  readonly progressFile: string;
  readonly learnedFile: string;
}> {
  const atlasFile = join(directory, "atlas.json");
  await writeFile(
    atlasFile,
    JSON.stringify({
      [MAP]: { name: MAP_NAME, exits: [], chests: [] },
      ...extraAtlas,
    }),
    "utf8",
  );
  const progressFile = join(directory, "routebook-progress-ff5.json");
  const learnedFile = join(directory, "routebook-learned-ff5.json");
  const knowledge = await loadKnowledge({
    game: "ff5",
    home: join(directory, "knowledge"),
    atlas: null,
    collisions: null,
    bestiarySave: null,
    atlasSave: null,
  });
  const game = await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    atlasFile,
    collisionDir: join(directory, "collision"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    backlogFile: join(directory, "backlog.jsonl"),
    incidentsFile: join(directory, "incidents.jsonl"),
    incidentsStateFile: join(directory, "incidents-state.json"),
    bestiarySaveFile: join(directory, "bestiary-save.json"),
    routeFile: join(directory, "route-ff5.json"),
    stagePlanFile: join(directory, "stage-ff5.json"),
    routeBook: bookValue,
    routeBookEnabled: true,
    routeBookProgressFile: progressFile,
    routeBookLearnedFile: learnedFile,
    ...(officer === undefined ? {} : { stageOfficer: officer }),
    knowledge,
  });
  const collision = {
    searchLayer: 1,
    playerCell: [1, 5] as Cell,
    layers: [
      {
        name: "GroundCollision",
        rows: Array.from({ length: 20 }, () => "0".repeat(20)),
      },
    ],
  };
  await game.collisions.remember(MAP, collision);
  game.settle = () => Promise.resolve("");
  game.observe = () => Promise.resolve("状态好");
  return { game, progressFile, learnedFile };
}

async function inTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ffpr-book-executor-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test("route {} opens the book's chests in order and writes the acceptance progress", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const first = chest(0, [2, 5]);
    const second = chest(1, [4, 5]);
    const { game } = await makeGame(
      dir,
      book(
        section(
          [station(0, "chest", [2, 5], first), station(1, "chest", [4, 5], second)],
          [first, second],
        ),
      ),
    );
    const lines: string[] = [];
    game.onActivity = (message) => lines.push(message);
    const result = await game.run("route", {}, pilotFor(value));
    assert.match(result, /完成/);
    assert.deepEqual(value.openedOrder, ["2,5", "4,5"]);
    assert.equal(game.stagePlan()?.book?.section, "测试洞窟");
    assert.equal(game.stagePlan()?.status, "completed");
    const progress = JSON.parse(
      await readFile(join(dir, "routebook-progress-ff5.json"), "utf8"),
    ) as BookProgress;
    assert.equal(progress.section, "测试洞窟");
    assert.equal(
      progress.stations.every((item) => item.status === "done"),
      true,
    );
    assert.equal(progress.stats.chestsOpened, 2);
    assert.equal(progress.stats.chestsTotal, 2);
    assert.notEqual(progress.finishedAt, null);
    assert.ok(
      lines.some(
        (line) =>
          line.startsWith("路线书统计「测试洞窟」:工具 ") &&
          line.includes("宝箱 2/2") &&
          line.includes("用时"),
      ),
      lines.join("\n"),
    );
  });
});

void test("already opened chests are skipped", async () => {
  await inTemp(async (dir) => {
    const value = world();
    value.opened.add("2,5");
    const first = chest(0, [2, 5], true);
    const second = chest(1, [4, 5]);
    const { game } = await makeGame(
      dir,
      book(
        section(
          [station(0, "chest", [2, 5], first), station(1, "chest", [4, 5], second)],
          [first, second],
        ),
      ),
    );
    const result = await game.run("route", {}, pilotFor(value));
    assert.match(result, /完成/);
    assert.deepEqual(value.openedOrder, ["4,5"]);
  });
});

void test("a full party skips the heal station and the plan opens the next chest", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const first = chest(1, [2, 5]);
    const { game } = await makeGame(
      dir,
      book(section([station(0, "heal", [7, 7]), station(1, "chest", [2, 5], first)], [first])),
    );
    const result = await game.run("route", {}, pilotFor(value));
    assert.match(result, /完成/);
    assert.deepEqual(value.openedOrder, ["2,5"]);
    const progress = JSON.parse(
      await readFile(join(dir, "routebook-progress-ff5.json"), "utf8"),
    ) as BookProgress;
    const heal = progress.stations.find((station) => station.index === 0);
    assert.ok(heal !== undefined);
    assert.equal(heal.status, "skipped");
    assert.match(heal.note, /满血，跳过回复/);
  });
});

void test("a heal station on another floor is not walked back to at full HP", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const first = chest(1, [2, 5]);
    const { game } = await makeGame(
      dir,
      book(
        section(
          [station(0, "heal", [2, 2], null, 72), station(1, "chest", [2, 5], first)],
          [first],
        ),
      ),
      undefined,
      { 72: { name: "二楼", exits: [], chests: [] } },
    );
    const result = await game.run("route", {}, pilotFor(value));
    assert.match(result, /完成/);
    assert.doesNotMatch(result, /地图 72/);
    assert.deepEqual(value.openedOrder, ["2,5"]);
    const progress = JSON.parse(
      await readFile(join(dir, "routebook-progress-ff5.json"), "utf8"),
    ) as BookProgress;
    assert.equal(progress.stations.find((station) => station.index === 0)?.status, "skipped");
  });
});

void test("a multi-cell chest station opens every cell", async () => {
  await inTemp(async (dir) => {
    const value = world({
      chests: [
        { cell: [3, 5], label: "帐篷" },
        { cell: [6, 5], label: "解毒药" },
      ],
    });
    const multi = chest(0, null, false, [
      { mapId: MAP, cell: [3, 5], opened: false },
      { mapId: MAP, cell: [6, 5], opened: false },
    ]);
    const { game } = await makeGame(
      dir,
      book(section([station(0, "chest", null, multi)], [multi])),
    );
    const result = await game.run("route", {}, pilotFor(value));
    assert.match(result, /完成/);
    assert.deepEqual([...value.opened].sort(), ["3,5", "6,5"]);
    const progress = JSON.parse(
      await readFile(join(dir, "routebook-progress-ff5.json"), "utf8"),
    ) as BookProgress;
    assert.equal(progress.stations[0]?.status, "done");
  });
});

void test("a boss station stops at the door and hands the fight to the model", async () => {
  await inTemp(async (dir) => {
    const value = world({ chests: [] });
    const { game } = await makeGame(dir, book(section([station(0, "boss", [4, 5])])));
    const result = await game.run("route", {}, pilotFor(value));
    assert.match(result, /首领/);
    assert.match(result, /交给 AI/);
    assert.notEqual(game.stagePlan()?.status, "completed");
    const progress = JSON.parse(
      await readFile(join(dir, "routebook-progress-ff5.json"), "utf8"),
    ) as BookProgress;
    assert.equal(progress.stations[0]?.status, "current");
  });
});

void test("a cell-less handoff stops, learns the model's cell, and the next route continues", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const second = chest(1, [4, 5]);
    const { game } = await makeGame(
      dir,
      book(section([station(0, "switch", null), station(1, "chest", [4, 5], second)], [second])),
    );
    const first = await game.run("route", {}, pilotFor(value));
    assert.match(first, /第 1 站交给你/);
    assert.match(first, /攻略原文:guide switch/);
    assert.match(first, /处理完再 route \{\} 接着走/);
    let progress = JSON.parse(
      await readFile(join(dir, "routebook-progress-ff5.json"), "utf8"),
    ) as BookProgress;
    assert.equal(progress.stations[0]?.status, "current");

    // The model handles the station at a cell of its own; that is the learned coordinate.
    const handled = await game.run("interact", { x: 3, y: 5 }, pilotFor(value));
    assert.doesNotMatch(handled, /阶段计划拦下/);
    const learned = JSON.parse(await readFile(join(dir, "routebook-learned-ff5.json"), "utf8")) as {
      points: {
        section: string;
        station: number;
        mapId: number;
        cell: number[];
        at: string;
      }[];
    };
    const point = learned.points[0];
    assert.ok(point);
    assert.equal(point.section, "测试洞窟");
    assert.equal(point.station, 0);
    assert.equal(point.mapId, MAP);
    assert.deepEqual(point.cell, [3, 5]);
    assert.equal(typeof point.at, "string");

    const secondRun = await game.run("route", {}, pilotFor(value));
    assert.match(secondRun, /完成/);
    assert.deepEqual(value.openedOrder, ["4,5"]);
    progress = JSON.parse(
      await readFile(join(dir, "routebook-progress-ff5.json"), "utf8"),
    ) as BookProgress;
    assert.equal(progress.stations[0]?.status, "handoff");
    assert.equal(progress.stats.handoffs, 1);
  });
});

void test("a story handoff with exactly one untriggered Event walks there itself", async () => {
  await inTemp(async (dir) => {
    const value = world({
      chests: [],
      events: [{ cell: [7, 7], name: "剧情: 水晶" }],
    });
    const { game } = await makeGame(dir, book(section([station(0, "cutscene", null)])));
    const result = await game.run("route", {}, pilotFor(value));
    assert.doesNotMatch(result, /第 1 站交给你/);
    assert.match(result, /完成/);
    assert.deepEqual(value.cell, [7, 7]);
    const progress = JSON.parse(
      await readFile(join(dir, "routebook-progress-ff5.json"), "utf8"),
    ) as BookProgress;
    assert.equal(progress.stations[0]?.status, "done");
  });
});

void test("route {} builds the plan from the book first, not from a stage officer route", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const first = chest(0, [2, 5]);
    const { game } = await makeGame(
      dir,
      book(section([station(0, "chest", [2, 5], first)], [first])),
    );
    const before = game.stagePlan();
    assert.equal(before, null);
    const result = await game.run("route", {}, pilotFor(value));
    assert.match(result, /完成/);
    const plan = game.stagePlan();
    const route: StagePlan["route"] = plan?.plan.route ?? [];
    assert.deepEqual(
      route.map((stop) => [stop.to, stop.do, stop.book?.section]),
      [["71:2,5", "open", "测试洞窟"]],
    );
  });
});

void test("go walks normally when the book plan has no executable station left", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const near = chest(0, [2, 5]);
    const far: RouteChest = {
      ...chest(1, [1, 1]),
      mapId: 72,
      mapName: "下一站",
      cell: [1, 1],
    };
    const { game } = await makeGame(
      dir,
      book(
        section(
          [station(0, "chest", [2, 5], near), station(1, "chest", [1, 1], far, 72)],
          [near, far],
          {
            maps: [
              {
                mapId: MAP,
                name: MAP_NAME,
                areaName: MAP_NAME,
                reasons: ["test"],
              },
              {
                mapId: 72,
                name: "下一站",
                areaName: "下一站",
                reasons: ["test"],
              },
            ],
          },
        ),
      ),
      undefined,
      { "72": { name: "下一站", exits: [], chests: [] } },
    );
    await autoBook(game)(pilotFor(value), undefined, true);
    const store = (
      game as unknown as {
        bookProgress: {
          current: { stations: readonly { index: number }[] } | null;
          mark(index: number, status: string, note: string, kind: string): Promise<void>;
        };
      }
    ).bookProgress;
    assert.ok(store.current);
    for (const station of store.current.stations) {
      await store.mark(station.index, "done", "test", "chest");
    }
    const result = await game.run("go", { to: 72 }, pilotFor(value));
    assert.doesNotMatch(result, /代码接着按计划走|没有要执行的站了/u);
  });
});

void test("overlapping sections pick the earliest unfinished one, not the one that was just finished", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const doneChest = chest(0, [2, 5], true);
    const openChest = chest(1, [4, 5], false);
    const doneSection = section([station(0, "chest", [2, 5], doneChest)], [doneChest], {
      title: "先做完的节",
      order: 0,
    });
    const nextSection = section([station(1, "chest", [4, 5], openChest)], [openChest], {
      title: "运河",
      order: 1,
    });
    const { game } = await makeGame(dir, bookOf([doneSection, nextSection]));
    await autoBook(game)(pilotFor(value), undefined, true);
    assert.equal(game.stagePlan()?.book?.section, "运河");
  });
});

void test("bridge 0.14.8's flag table marks a far chest done and moves to the next section", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const doneChest: RouteChest = { ...chest(0, [2, 5], false), flag: "88" };
    const nextChest: RouteChest = { ...chest(1, [4, 5], false), flag: "89" };
    const doneSection = section([station(0, "chest", [2, 5], doneChest)], [doneChest], {
      title: "图尔村",
      order: 0,
    });
    const nextSection = section([station(1, "chest", [4, 5], nextChest)], [nextChest], {
      title: "运河",
      order: 1,
    });
    const { game } = await makeGame(dir, bookOf([doneSection, nextSection]));
    const pilot = pilotFor(value);
    pilot.onQuery("treasureflags", {
      treasureflags: { flags: { "88": true, "89": false }, total: 2 },
    });
    await autoBook(game)(pilot, undefined, true);
    assert.equal(game.stagePlan()?.book?.section, "运河");
  });
});

void test("a book plan starts before the stage officer answers and merges the officer later", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const opened = chest(0, [2, 5]);
    const officerPlan: StagePlan = {
      threats: [],
      supplies: [{ item: "Potion", min: 2, buyTo: 3 }],
      spells: [],
      gear: [],
      jobs: [{ member: "巴兹", job: "青魔导士", reason: "测试" }],
      minLevel: 5,
      route: [{ to: "71:9,9" }],
      turnBack: [],
      notes: "阶段官的药品和等级",
    };
    interface OfficerAnswer {
      readonly plan: StagePlan;
      readonly problems: readonly string[];
      readonly text: string;
    }
    let resolveAnswer: (answer: OfficerAnswer) => void = () => undefined;
    const answer = new Promise<OfficerAnswer>((resolve) => {
      resolveAnswer = resolve;
    });
    const officer: StageOfficerRunner = () => answer;
    const { game } = await makeGame(
      dir,
      book(section([station(0, "chest", [2, 5], opened)], [opened])),
      officer,
    );
    await autoBook(game)(pilotFor(value), undefined, true);
    const immediate = game.stagePlan();
    assert.ok(immediate?.book);
    assert.deepEqual(immediate.plan.supplies, []);
    assert.equal(immediate.plan.route.length, 1);
    resolveAnswer({ plan: officerPlan, problems: [], text: "阶段官计划" });
    await game.whenTacticianIdle();
    const merged = game.stagePlan();
    assert.ok(merged);
    const supply = merged.plan.supplies[0];
    assert.ok(supply);
    assert.equal(supply.item, "Potion");
    assert.equal(merged.plan.minLevel, 5);
    assert.equal(merged.plan.route.length, 1);
    assert.equal(merged.book?.section, "测试洞窟");
  });
});

void test("plan_stage keeps the officer's route as a note and stores the book's route", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const opened = chest(0, [2, 5]);
    const officerPlan: StagePlan = {
      threats: [],
      supplies: [],
      spells: [],
      gear: [],
      jobs: [],
      minLevel: null,
      route: [{ to: "71:9,9" }],
      turnBack: [],
      notes: "阶段官的走法",
    };
    const officer: StageOfficerRunner = () =>
      Promise.resolve({ plan: officerPlan, problems: [], text: "阶段官计划" });
    const { game } = await makeGame(
      dir,
      book(section([station(0, "chest", [2, 5], opened)], [opened])),
      officer,
    );
    const result = await game.run("plan_stage", { to: MAP }, pilotFor(value));
    assert.match(result, /阶段计划已存盘/);
    const saved = game.stagePlan();
    assert.ok(saved);
    assert.equal(saved.book?.section, "测试洞窟");
    assert.deepEqual(
      saved.plan.route.map((stop) => [stop.to, stop.do]),
      [["71:2,5", "open"]],
    );
    assert.match(saved.plan.notes, /阶段官路线（不执行）/);
  });
});

void test("route {} does not start a book section from a map the book does not cover", async () => {
  await inTemp(async (dir) => {
    const value = world({ map: 999, cell: [1, 1] });
    const opened = chest(0, [2, 5]);
    const { game } = await makeGame(
      dir,
      book(section([station(0, "chest", [2, 5], opened)], [opened])),
    );
    const result = await game.run("route", {}, pilotFor(value));
    assert.match(result, /没有可接着走的路线/);
    assert.equal(game.stagePlan(), null);
    assert.deepEqual(value.openedOrder, []);
  });
});

interface AutoBook {
  autoBookPlanOnMove(
    pilot: FakePilot,
    signal: AbortSignal | undefined,
    force?: boolean,
  ): Promise<{ readonly text: string } | null>;
}

function autoBook(game: Game): AutoBook["autoBookPlanOnMove"] {
  return (
    game as unknown as {
      autoBookPlanOnMove: AutoBook["autoBookPlanOnMove"];
    }
  ).autoBookPlanOnMove.bind(game);
}

void test("the first movement into a book section builds its plan and says so", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const opened = chest(0, [2, 5]);
    const { game } = await makeGame(
      dir,
      book(section([station(0, "chest", [2, 5], opened)], [opened])),
    );
    const result = await game.run("go", { to: [1, 4] }, pilotFor(value));
    assert.ok(
      result.startsWith(
        "已按路线书为「测试洞窟」生成计划，共 1 站(宝箱 1、剧情 0、交回 0)," +
          "代码会按计划走;处理完交回站再 `route {}`",
      ),
      result,
    );
    const plan = game.stagePlan();
    assert.ok(plan);
    assert.ok(plan.book);
    assert.equal(plan.book.section, "测试洞窟");
    assert.equal(plan.book.version, ROUTE_BOOK_PLAN_VERSION);
    assert.equal(typeof plan.book.digest, "string");
    assert.deepEqual(value.openedOrder, ["2,5"]);
  });
});

void test("moving into the next section settles the old plan and builds the new one", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const opened = chest(0, [2, 5]);
    const first = section([station(0, "chest", [2, 5], opened), station(1, "switch", null)]);
    const second = section([station(2, "switch", null, null, 72)], [], {
      title: "第二段",
      order: 1,
      areaName: "第二地区",
      maps: [
        {
          mapId: 72,
          name: "第二洞窟",
          areaName: "第二地区",
          reasons: ["test"],
        },
      ],
    });
    const { game } = await makeGame(dir, bookOf([first, second]), undefined, {
      "72": { name: "第二洞窟", exits: [], chests: [] },
    });
    const lines: string[] = [];
    game.onActivity = (message) => lines.push(message);
    const automatic = autoBook(game);
    await automatic(pilotFor(value), undefined, true);
    const planned = game.stagePlan();
    assert.ok(planned);
    await game.stagePlans.save({
      ...planned,
      status: "departed",
      stats: {
        departedAt: new Date().toISOString(),
        tools: 1,
        go: 1,
        route: 0,
        planStage: 0,
        stops: 0,
      },
    });
    value.map = 72;
    value.cell = [1, 1];
    await automatic(pilotFor(value), undefined, true);
    assert.equal(game.stagePlan()?.book?.section, "第二段");
    assert.equal(game.stagePlan()?.target.mapId, 72);
    assert.equal(
      lines.some((line) => line.startsWith("阶段统计「测试洞窟」:")),
      true,
      lines.join("\n"),
    );
  });
});

void test("a plan from an older book version is rebuilt", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const opened = chest(0, [2, 5]);
    const { game } = await makeGame(
      dir,
      book(section([station(0, "chest", [2, 5], opened)], [opened])),
    );
    const automatic = autoBook(game);
    await automatic(pilotFor(value), undefined, true);
    const old = game.stagePlan();
    assert.ok(old?.book);
    await game.stagePlans.save({
      ...old,
      target: { ...old.target, label: "旧计划" },
      book: { ...old.book, version: 0 },
    });
    await automatic(pilotFor(value), undefined, true);
    assert.equal(game.stagePlan()?.book?.version, ROUTE_BOOK_PLAN_VERSION);
    assert.equal(game.stagePlan()?.target.label, "测试洞窟");
  });
});

void test("the world map goes on to the next section without an empty world plan", async () => {
  await inTemp(async (dir) => {
    const value = world({ map: 1, cell: [1, 1] });
    const opened = chest(0, [2, 5]);
    const { game } = await makeGame(
      dir,
      book(section([station(0, "chest", [2, 5], opened)], [opened])),
      undefined,
      { "1": { name: "世界地图", exits: [], chests: [] } },
    );
    const result = await game.run("go", { to: [1, 2] }, pilotFor(value));
    const plan = game.stagePlan();
    assert.ok(plan);
    assert.equal(plan.target.mapId, MAP);
    assert.equal(plan.plan.route.length, 1);
    assert.equal(plan.book?.section, "测试洞窟");
    assert.doesNotMatch(result, /Map_/);
  });
});

void test("go by map name follows a covered book plan; a map outside it walks normally", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const opened = chest(0, [2, 5]);
    const { game } = await makeGame(
      dir,
      book(section([station(0, "chest", [2, 5], opened)], [opened])),
      undefined,
      { "72": { name: "别处", exits: [], chests: [] } },
    );
    await autoBook(game)(pilotFor(value), undefined, true);
    const followed = await game.run("go", { to: MAP_NAME }, pilotFor(value));
    assert.match(followed, /代码接着按计划走/);
    assert.deepEqual(value.openedOrder, ["2,5"]);
  });
  await inTemp(async (dir) => {
    const value = world();
    const opened = chest(0, [2, 5]);
    const { game } = await makeGame(
      dir,
      book(section([station(0, "chest", [2, 5], opened)], [opened])),
      undefined,
      { "72": { name: "别处", exits: [], chests: [] } },
    );
    await autoBook(game)(pilotFor(value), undefined, true);
    const normal = await game
      .run("go", { to: 72 }, pilotFor(value))
      .catch((error: unknown) => String(error));
    assert.doesNotMatch(normal, /代码接着按计划走/);
    assert.deepEqual(value.openedOrder, []);
  });
});

void test("leaving a book section with an unopened chest is refused, then allowed with a debt", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const opened = chest(0, [2, 5]);
    const { game } = await makeGame(
      dir,
      book(section([station(0, "chest", [2, 5], opened)], [opened])),
      undefined,
      { "72": { name: "别处", exits: [], chests: [] } },
    );
    await autoBook(game)(pilotFor(value), undefined, true);
    const refused = await game.run("go", { to: 72 }, pilotFor(value));
    assert.match(refused, /还有没开的宝箱/u);
    assert.match(refused, /地图 71 \(2,5\) 帐篷/u);
    assert.equal(await readFile(join(dir, "backlog.jsonl"), "utf8").catch(() => ""), "");
    const allowed = await game.run("go", { to: 72, leave_incomplete: "测试离开" }, pilotFor(value));
    assert.doesNotMatch(allowed, /还有没开的宝箱/u);
    const backlog = await readFile(join(dir, "backlog.jsonl"), "utf8");
    assert.match(backlog, /测试离开/u);
    assert.match(backlog, /地图 71 \(2,5\) 帐篷/u);
  });
});

void test("a book plan's statistics use the section's Chinese area, not a map resource", async () => {
  await inTemp(async (dir) => {
    const value = world();
    const opened = chest(0, [2, 5]);
    const chapter = section([station(0, "chest", [2, 5], opened)], [opened], {
      title: "Prologue",
      areaName: "泰空",
    });
    const { game } = await makeGame(dir, book(chapter));
    const lines: string[] = [];
    game.onActivity = (message) => lines.push(message);
    await game.run("go", { to: [1, 4] }, pilotFor(value));
    assert.equal(game.stagePlan()?.target.label, "Prologue（泰空）");
    assert.equal(
      lines.some((line) => line.startsWith("阶段统计「Prologue（泰空）」:")),
      true,
      lines.join("\n"),
    );
    assert.equal(
      lines.some((line) => line.includes("Map_")),
      false,
    );
  });
});
