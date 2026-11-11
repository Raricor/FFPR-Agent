import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Game, type SegmentExecutor } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { SegmentPlan, SegmentReport } from "../src/engine/plan/types.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = {
  host: "laptop",
  user: "player",
  key: "/tmp/key",
  root: "C:/ffpr",
};

function plan(): SegmentPlan {
  return {
    version: 1,
    section: "试验段",
    goal: "走完试验段",
    prep: { jobs: [], equip: "keep", buy: [], rows: [] },
    stations: [{ to: "10:1,1", do: "move" }],
    battle: [],
    bosses: [],
    turnBack: [],
  };
}

function report(): SegmentReport {
  return {
    section: "试验段",
    status: "done",
    done: {
      stations: 1,
      chestsOpened: 2,
      battles: 3,
      bestiaryNew: ["试验怪"],
      blueMagicNew: ["试验青魔法"],
      bossesWon: [],
    },
    remaining: [],
    party: "巴兹 战士 Lv5 HP 100/100 MP 10/10",
    minutes: 7,
    modelCalls: 0,
  };
}

async function temporaryGame(
  directory: string,
  executor?: SegmentExecutor,
): Promise<{
  game: Game;
  planFile: string;
  reportFile: string;
  progressFile: string;
}> {
  const planFile = join(directory, "segment-plan-ff5.json");
  const reportFile = join(directory, "segment-report-ff5.json");
  const progressFile = join(directory, "segment-progress-ff5.json");
  const game = await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    atlasFile: join(directory, "atlas.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    segmentPlanFile: planFile,
    segmentReportFile: reportFile,
    segmentProgressFile: progressFile,
    ...(executor === undefined ? {} : { segmentExecutor: executor }),
  });
  return { game, planFile, reportFile, progressFile };
}

void test("execute_plan runs the saved plan through the executor and saves the report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-"));
  try {
    let seen: SegmentPlan | null = null;
    let seenPilot = false;
    const { game, reportFile } = await temporaryGame(directory, (given, pilot) => {
      seen = given;
      seenPilot = pilot instanceof FakePilot;
      return Promise.resolve(report());
    });
    await game.segmentPlans.save(plan());
    const text = await game.run("execute_plan", {}, new FakePilot());
    assert.ok(seenPilot, "执行器应该收到这次工具调用的 pilot");
    assert.deepEqual(seen, plan());
    assert.match(text, /段计划报告:试验段 — 完成/u);
    assert.match(text, /模型调用 0 次/u);
    assert.match(text, /图鉴新登记:试验怪/u);
    assert.match(text, /结构化报告\(JSON\)/u);
    assert.match(text, /"status": "done"/u);
    assert.deepEqual(JSON.parse(await readFile(reportFile, "utf8")), report());

    const status = await game.run("plan_status", {}, new FakePilot());
    assert.match(status, /当前段计划:试验段/u);
    assert.match(status, /上一份执行报告/u);
    assert.match(status, /模型调用 0 次/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("execute_plan explains how to make a plan when none is saved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-empty-"));
  try {
    const { game } = await temporaryGame(directory);
    const text = await game.run("execute_plan", {}, new FakePilot());
    assert.match(text, /还没有存盘的段计划/u);
    assert.match(text, /plan_facts/u);
    assert.match(text, /submit_plan/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a failed executor becomes a Chinese tool result, not an exception", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-fail-"));
  try {
    const { game } = await temporaryGame(directory, () => {
      throw new Error("桥插件断线");
    });
    await game.segmentPlans.save(plan());
    const text = await game.run("execute_plan", {}, new FakePilot());
    assert.match(text, /执行段计划失败:桥插件断线/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function readProgress(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

void test("segment progress revision rises within a section and restarts at 1 in a new one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-progress-"));
  try {
    const { game, reportFile, progressFile } = await temporaryGame(directory);
    await game.planProgressStart("风之神殿", "走完风之神殿", ["第 1 站"]);
    await game.planProgressFinish("done");
    const first = await readProgress(progressFile);
    assert.equal(first.revision, 1);
    assert.equal(first.goal, "走完风之神殿");

    await game.planProgressStart("风之神殿", "走完风之神殿", ["第 1 站"]);
    await game.planProgressFinish("exception");
    assert.equal((await readProgress(progressFile)).revision, 2);

    await game.planProgressStart("托纳运河", "走完托纳运河", ["第 1 站"]);
    await game.planProgressFinish("done");
    const next = await readProgress(progressFile);
    assert.equal(next.revision, 1);
    assert.equal(next.section, "托纳运河");

    const exceptionReport: SegmentReport = {
      ...report(),
      section: "托纳运河",
      status: "exception",
      exception: {
        kind: "stuck",
        map: 210,
        cell: [58, 37],
        station: 0,
        detail: "停在战斗里",
      },
    };
    await writeFile(reportFile, JSON.stringify(exceptionReport), "utf8");
    await game.planProgressStart("托纳运河", "走完托纳运河", ["第 1 站"]);
    const resumed = await readProgress(progressFile);
    assert.equal(resumed.revision, 2);
    assert.deepEqual(resumed.previousException, {
      kind: "stuck",
      detail: "停在战斗里",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("planPosition waits through a map change instead of reporting it unreadable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-pos-"));
  try {
    const { game } = await temporaryGame(directory);
    const pilot = new FakePilot();
    pilot.on("pos", [
      { pos: { map: null, cell: null, state: "ChangeMap" } },
      { pos: { map: 210, cell: [58, 37], state: "Player" } },
    ]);
    const at = await game.planPosition(pilot);
    assert.deepEqual(at, { map: 210, cell: [58, 37] });
    assert.equal(pilot.calls.filter((call) => call.kind === "send" && call.op === "pos").length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("planObservation does not report a crossover map while the screen is in a story", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-scene-"));
  try {
    const { game } = await temporaryGame(directory);
    const pilot = new FakePilot();
    pilot.on("pos", { pos: { map: 198, cell: [15, 23], state: "Event" } });
    pilot.onQuery("sample", {
      sample: { party: [], dialog: { lines: ["全身都湿透了啊"] }, battle: {} },
    });
    pilot.onQuery("items", { items: { normal: [] } });
    const observation = await game.planObservation(pilot);
    assert.equal(observation.map, null);
    assert.equal(observation.cell, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function chestGame(directory: string): Promise<Game> {
  const knowledge = {
    chests: [
      {
        mapId: 211,
        cell: [37, 49],
        flagId: 5,
        flag: null,
        contentName: "药",
        contentNames: { ja: null, en: "Potion", zhc: "药" },
      },
    ],
  } as unknown as import("../src/engine/knowledge/index.ts").Knowledge;
  return await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    atlasFile: join(directory, "atlas.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    segmentReportFile: join(directory, "segment-report-ff5.json"),
    knowledge,
  });
}

interface ChestInternals {
  treasureFlags: Map<number, boolean>;
  toolInteract: (args: unknown, pilot: unknown, guard?: boolean) => Promise<{ text: string }>;
  syncTreasureFlags: () => Promise<void>;
  planConfirmAgain: () => Promise<void>;
}

function chestPilot(): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { map: 211, cell: [37, 48], state: "Player" } });
  pilot.on("keys", { ok: true });
  pilot.onQuery("sample", { sample: { choice: {} } });
  pilot.onQuery("items", { items: { normal: [] } });
  return pilot;
}

void test("a chest counts as opened only when the treasure flag says so", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-chest-"));
  try {
    const game = await chestGame(directory);
    const internals = game as unknown as ChestInternals;
    internals.toolInteract = () =>
      Promise.resolve({
        text: "站在 (37,48) 面朝Down按了确认,之后翻了 0 页对话",
      });
    internals.syncTreasureFlags = () => Promise.resolve();
    internals.treasureFlags.set(5, true);
    const opened = await game.planInteract(chestPilot(), [37, 49]);
    assert.equal(opened.ok, true);
    assert.match(opened.text, /开了宝箱/u);

    internals.treasureFlags.set(5, false);
    const notOpened = await game.planInteract(chestPilot(), [37, 49]);
    assert.equal(notOpened.ok, false);
    assert.match(notOpened.text, /宝箱没有打开/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function interactionGame(directory: string): Promise<Game> {
  const knowledge = {
    chests: [],
  } as unknown as import("../src/engine/knowledge/index.ts").Knowledge;
  return await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    atlasFile: join(directory, "atlas.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    segmentReportFile: join(directory, "segment-report-ff5.json"),
    knowledge,
  });
}

function entityReply(entities: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { entities: { entities } };
}

function interactionPilot(
  before: readonly Record<string, unknown>[],
  after: readonly Record<string, unknown>[],
): FakePilot {
  const pilot = new FakePilot();
  pilot.on("pos", { pos: { map: 193, cell: [22, 8], state: "Player" } });
  pilot.on("keys", { ok: true });
  pilot.on("entities", [entityReply(before), entityReply(after), entityReply(after)]);
  pilot.onQuery("sample", { sample: { choice: {} } });
  pilot.onQuery("items", { items: { normal: [] } });
  return pilot;
}

void test("a switch with no visible effect fails and names the nearby switch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-switch-"));
  try {
    const game = await interactionGame(directory);
    const internals = game as unknown as ChestInternals;
    internals.toolInteract = () =>
      Promise.resolve({ text: "站在 (22,8) 面朝Up按了确认,之后翻了 0 页对话" });
    const entities = [
      {
        kind: "DefaultEntity",
        name: "sc_e_0206:扉が開く",
        cell: [22, 6],
        active: true,
      },
    ];
    const result = await game.planInteract(interactionPilot(entities, entities), [22, 7]);
    assert.equal(result.ok, false);
    assert.match(result.text, /调查 \(22,7\) 后什么也没发生/u);
    assert.match(result.text, /附近有 \(22,6\) sc_e_0206:扉が開く/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a nearby door changing state makes the switch action a success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-switch-open-"));
  try {
    const game = await interactionGame(directory);
    const internals = game as unknown as ChestInternals;
    internals.toolInteract = () =>
      Promise.resolve({ text: "站在 (22,8) 面朝Up按了确认,之后翻了 0 页对话" });
    const before = [
      {
        kind: "DefaultEntity",
        name: "扉のコリジョン",
        cell: [22, 6],
        active: true,
      },
    ];
    const after = [
      {
        kind: "DefaultEntity",
        name: "扉のコリジョン",
        cell: [22, 6],
        active: false,
      },
    ];
    const result = await game.planInteract(interactionPilot(before, after), [22, 7]);
    assert.equal(result.ok, true);
    assert.match(result.text, /附近实体变化:扉のコリジョン/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a chest that opens only on the second confirm says so", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-chest-second-"));
  try {
    const game = await chestGame(directory);
    const internals = game as unknown as ChestInternals;
    internals.toolInteract = () =>
      Promise.resolve({
        text: "站在 (37,48) 面朝Down按了确认,之后翻了 0 页对话",
      });
    internals.syncTreasureFlags = () => Promise.resolve();
    internals.treasureFlags.set(5, false);
    internals.planConfirmAgain = () => {
      internals.treasureFlags.set(5, true);
      return Promise.resolve();
    };
    const result = await game.planInteract(chestPilot(), [37, 49]);
    assert.equal(result.ok, true);
    assert.match(result.text, /第 2 次按确认才有效果/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("plan keys turn first, wait for the direction, then confirm", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-plan-keys-"));
  try {
    const game = await chestGame(directory);
    const pilot = new FakePilot();
    pilot.on("keys", { ok: true });
    pilot.on("pos", [{ pos: { dir: "Up" } }, { pos: { dir: "Down" } }]);
    const proxy = (
      game as unknown as {
        planKeyPilot: (pilot: FakePilot) => import("../src/engine/pilot.ts").Pilot;
      }
    ).planKeyPilot(pilot);
    const result = await proxy.send("keys", { keys: ["Down:60", "Enter"] });
    assert.equal(result.ok, true);
    const keyCalls = pilot.calls.filter((call) => call.kind === "send" && call.op === "keys");
    assert.deepEqual(
      keyCalls.map((call) => (call as unknown as { fields: { keys: string[] } }).fields.keys),
      [["Down:60"], ["Enter"]],
    );
    assert.equal(pilot.calls.filter((call) => call.kind === "send" && call.op === "pos").length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
