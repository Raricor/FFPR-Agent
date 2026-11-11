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
import type { StagePlan } from "../src/engine/stage/types.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

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
      layers: [{ name: "GroundCollision", rows: Array.from({ length: 20 }, () => "0".repeat(20)) }],
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
    encounters: { monsterSet: null, parties: [], region: null, regions: [], enabled: false },
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
): RouteStation {
  return {
    index,
    where: null,
    kind,
    mapId: MAP,
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
): RouteSection {
  return {
    title: "测试洞窟",
    order: 0,
    areaName: MAP_NAME,
    maps: [{ mapId: MAP, name: MAP_NAME, areaName: MAP_NAME, reasons: ["test"] }],
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

function book(sectionValue: RouteSection): RouteBook {
  return {
    fromSection: sectionValue.title,
    fromPlace: null,
    toSection: sectionValue.title,
    sections: [sectionValue],
    totals: {
      sections: 1,
      stations: sectionValue.stations.length,
      chestsMatched: sectionValue.chestsMatched,
      chestsTotal: sectionValue.chestsTotal,
      bestiaryMissing: 0,
      bestiaryUnknown: false,
      blueMagicMissing: 0,
      revisit: 0,
      mismatches: 0,
    },
  };
}

async function makeGame(
  directory: string,
  bookValue: RouteBook,
  officer?: StageOfficerRunner,
): Promise<{ readonly game: Game; readonly progressFile: string; readonly learnedFile: string }> {
  const atlasFile = join(directory, "atlas.json");
  await writeFile(
    atlasFile,
    JSON.stringify({ [MAP]: { name: MAP_NAME, exits: [], chests: [] } }),
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
    layers: [{ name: "GroundCollision", rows: Array.from({ length: 20 }, () => "0".repeat(20)) }],
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
      points: { section: string; station: number; mapId: number; cell: number[]; at: string }[];
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
