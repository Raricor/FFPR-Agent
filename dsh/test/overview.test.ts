import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActivityLog } from "../src/engine/activity.ts";
import type { Watcher } from "../src/engine/events.ts";
import { GAMES } from "../src/engine/games.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { Json } from "../src/engine/values.ts";
import {
  detectionSource,
  resetDetection,
  type DetectionResult,
  type DetectionSource,
} from "../src/plugin/detect.ts";
import { buildOverview, overviewRoute } from "../src/plugin/overview.ts";
import type { PlayerEngine } from "../src/plugin/player.ts";
import type { EngineSlot } from "../src/plugin/registry.ts";

const FAKE_SSH = join(import.meta.dirname, "fake-ssh.mjs");

const LAPTOP: Laptop = {
  host: "10.0.0.2",
  user: "ffpr",
  key: "/home/dev/.ssh/ffpr_laptop_ed25519",
  root: "C:/ffpr",
  sshCommand: FAKE_SSH,
};

function sourceOf(result: DetectionResult): DetectionSource {
  return {
    peek: () => ({ result, fresh: true, pending: false }),
    detect: () => Promise.resolve(result),
  };
}

async function sshCalls(path: string): Promise<number> {
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).length;
}

interface EngineOptions {
  readonly sample?: Json;
  readonly connected?: boolean;
  readonly error?: string | null;
  readonly noBridge?: boolean;
  readonly activity?: ActivityLog;
}

function engine(game: string, options: EngineOptions = {}): PlayerEngine {
  const activity = options.activity ?? new ActivityLog({ game });
  return {
    bridge: options.noBridge === true ? undefined : {},
    watcher: {
      connected: options.connected ?? true,
      error: options.error ?? null,
    } as unknown as Watcher,
    events: { liveSample: () => options.sample ?? null },
    activity,
    game: { game, saveSlot: 20 },
  } as unknown as PlayerEngine;
}

function lookup(engines: readonly PlayerEngine[]): (game: string) => PlayerEngine | undefined {
  const byGame = new Map(engines.map((item) => [item.game.game, item]));
  return (game) => byGame.get(game);
}

function sample(state: string, area = "图尔村", location = "商店"): Json {
  return {
    scene: { state },
    user: { areaText: area, locationText: location },
    party: [
      { name: "巴兹", hp: 30, maxHp: 60 },
      { name: "蕾娜", hp: 10, maxHp: 50 },
    ],
  };
}

void test("overview always has six cards in ff1 … ff6 order, unloaded games included", () => {
  const overview = buildOverview(lookup([engine("ff3", { sample: sample("Player") })]));
  assert.deepEqual(
    overview.games.map((card) => card.game),
    GAMES.map((game) => game.key),
  );
  const unloaded = overview.games[0];
  assert.ok(unloaded);
  assert.equal(unloaded.loaded, false);
  assert.equal(unloaded.link, "down");
  assert.equal(unloaded.linkText, "还没启动");
  assert.equal(unloaded.status, "");
  assert.equal(unloaded.place, "");
  assert.deepEqual(unloaded.party, []);
  assert.equal(unloaded.last, null);
  assert.equal(unloaded.saveSlot, 20);
});

void test("a loaded card shows its title, state, place, party and save slot", () => {
  const overview = buildOverview(lookup([engine("ff5", { sample: sample("Player") })]));
  const card = overview.games[4];
  assert.ok(card);
  assert.equal(card.title, "FF5 · 最终幻想V");
  assert.equal(card.loaded, true);
  assert.equal(card.link, "up");
  assert.equal(card.linkText, null);
  assert.equal(card.status, "在地图上");
  assert.equal(card.place, "图尔村 商店");
  assert.deepEqual(card.party, [
    { name: "巴兹", hp: 30, maxHp: 60 },
    { name: "蕾娜", hp: 10, maxHp: 50 },
  ]);
  assert.equal(card.saveSlot, 20);
});

void test("status translates known scene states and leaves unknown ones alone", () => {
  const battle = buildOverview(lookup([engine("ff1", { sample: sample("Battle") })]));
  assert.equal(battle.games[0]?.status, "战斗中");
  const unknown = buildOverview(lookup([engine("ff1", { sample: sample("Weird") })]));
  assert.equal(unknown.games[0]?.status, "Weird");
});

void test("the title screen, a Title scene with no state, reads as the title screen", () => {
  const title = {
    type: "sample",
    scene: { name: "Title", state: null },
    user: {},
    party: [],
  };
  const overview = buildOverview(lookup([engine("ff1", { sample: title })]));
  assert.equal(overview.games[0]?.status, "标题画面");
});

void test("a down link hides the stale sample's status, place and party", () => {
  const down = buildOverview(
    lookup([
      engine("ff5", {
        sample: sample("Player"),
        connected: false,
        error: "连不上桥插件，游戏可能没开",
      }),
    ]),
  );
  const card = down.games[4];
  assert.ok(card);
  assert.equal(card.link, "down");
  assert.equal(card.status, "");
  assert.equal(card.place, "");
  assert.deepEqual(card.party, []);
});

void test("a down link shows the watcher's error; a missing bridge shows the default text", () => {
  const down = buildOverview(
    lookup([
      engine("ff6", {
        connected: false,
        error: "连不上 http://192.168.1.20:47806",
      }),
    ]),
  );
  const downCard = down.games[5];
  assert.ok(downCard);
  assert.equal(downCard.link, "down");
  assert.equal(downCard.linkText, "连不上 http://192.168.1.20:47806");
  const noBridge = buildOverview(lookup([engine("ff2", { noBridge: true })]));
  const noBridgeCard = noBridge.games[1];
  assert.ok(noBridgeCard);
  assert.equal(noBridgeCard.link, "down");
  assert.equal(noBridgeCard.linkText, "连不上桥插件，游戏可能没开");
});

void test("a busy tool and the newest activity fill the card's two lines", () => {
  const activity = new ActivityLog({
    game: "ff4",
    now: () => new Date("2026-10-29T10:00:00.000Z"),
  });
  activity.beginTool("walk_to");
  const overview = buildOverview(lookup([engine("ff4", { sample: sample("Player"), activity })]));
  const card = overview.games[3];
  assert.ok(card);
  assert.deepEqual(card.busy, {
    name: "walk_to",
    at: "2026-10-29T10:00:00.000Z",
  });
  assert.equal(card.last, null);

  activity.record("error", "fight 出错:连不上桥插件");
  const after = buildOverview(lookup([engine("ff4", { activity })]));
  assert.deepEqual(after.games[3]?.last, {
    at: "2026-10-29T10:00:00.000Z",
    kind: "error",
    text: "fight 出错:连不上桥插件",
  });
});

void test("the overview's log is the six logs merged, filtered by game and since", () => {
  const ff5 = new ActivityLog({
    game: "ff5",
    now: () => new Date("2026-10-29T10:00:00.000Z"),
  });
  ff5.record("tool", "五之一");
  const ff6 = new ActivityLog({
    game: "ff6",
    now: () => new Date("2026-10-29T10:00:01.000Z"),
  });
  ff6.record("event", "六之一");
  const engines = [engine("ff5", { activity: ff5 }), engine("ff6", { activity: ff6 })];
  assert.deepEqual(
    buildOverview(lookup(engines)).log.map((entry) => entry.text),
    ["六之一", "五之一"],
  );
  assert.deepEqual(
    buildOverview(lookup(engines), { game: "ff5" }).log.map((entry) => entry.text),
    ["五之一"],
  );
  assert.deepEqual(
    buildOverview(lookup(engines), {
      since: "2026-10-29T10:00:00.500Z",
    }).log.map((entry) => entry.text),
    ["六之一"],
  );
});

void test("the overview route is no-store and passes since, game and limit", async () => {
  const ff5 = new ActivityLog({
    game: "ff5",
    now: () => new Date("2026-10-29T10:00:00.000Z"),
  });
  ff5.record("tool", "五之一");
  ff5.record("tool", "五之二");
  const route = overviewRoute(
    lookup([engine("ff5", { activity: ff5 })]),
    () => undefined,
    sourceOf({ ok: true, running: [] }),
  );
  const response = await route.fetch(
    new Request("http://localhost/api/ffpr/overview?game=ff5&limit=1&since=2026-10-29T09:00:00Z"),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body: unknown = await response.json();
  assert.ok(typeof body === "object" && body !== null);
  const record = body as Record<string, unknown>;
  assert.equal(record.ok, true);
  assert.equal(Array.isArray(record.games) && record.games.length, 6);
  const log = record.log;
  assert.ok(Array.isArray(log));
  assert.equal(log.length, 1);
});

void test("cards without an engine say 没开 or 还没启动 from the detection", () => {
  const open = buildOverview(lookup([]), {}, { ok: true, running: ["ff3"] });
  assert.equal(open.games[0]?.linkText, "没开");
  assert.equal(open.games[2]?.linkText, "还没启动");
  const unchecked = buildOverview(lookup([]), {}, { ok: false, error: "连不上" });
  assert.equal(unchecked.games[2]?.linkText, "还没启动");
  assert.equal(unchecked.games[0]?.linkText, "还没启动");
});

void test("the overview route starts only the one engine the laptop has open", async () => {
  let ff5Starts = 0;
  let ff3Starts = 0;
  const idle = (game: string, start: () => void): EngineSlot => ({
    game,
    current: () => undefined,
    ensure: () => {
      start();
      return Promise.resolve({ game: { game } } as unknown as PlayerEngine);
    },
    stop: () => undefined,
  });
  const route = overviewRoute(
    () => undefined,
    (game) =>
      game === "ff5" ? idle("ff5", () => (ff5Starts += 1)) : idle(game, () => (ff3Starts += 1)),
    sourceOf({ ok: true, running: ["ff5"] }),
  );
  const response = await route.fetch(new Request("http://localhost/api/ffpr/overview"));
  const body = (await response.json()) as {
    games: { game: string; linkText: string | null }[];
  };
  assert.equal(response.status, 200);
  assert.equal(ff5Starts, 1);
  assert.equal(ff3Starts, 0);
  assert.equal(body.games.find((card) => card.game === "ff3")?.linkText, "没开");
});

void test("the overview route does not wait for a slow SSH detection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-overview-"));
  resetDetection();
  const config = join(directory, "fake-ssh.json");
  const sshLog = join(directory, "ssh.log");
  await writeFile(
    config,
    JSON.stringify({ responses: [{ stdout: '["ff5"]\n', delayMs: 500 }] }),
    "utf8",
  );
  await writeFile(sshLog, "", "utf8");
  await chmod(config, 0o600);
  process.env.FAKE_SSH_CONFIG = config;
  process.env.FAKE_SSH_LOG = sshLog;
  try {
    const source = detectionSource(
      { laptopEnv: join(directory, "laptop.env"), detectCacheMs: 10_000 },
      () => Promise.resolve(LAPTOP),
    );
    let starts = 0;
    let current: PlayerEngine | undefined;
    const slot: EngineSlot = {
      game: "ff5",
      current: () => current,
      ensure: () => {
        starts += 1;
        current = { game: { game: "ff5" } } as unknown as PlayerEngine;
        return Promise.resolve(current);
      },
      stop: () => undefined,
    };
    const route = overviewRoute(
      () => undefined,
      (game) => (game === "ff5" ? slot : undefined),
      source,
    );

    const started = Date.now();
    const first = await route.fetch(new Request("http://localhost/api/ffpr/overview"));
    assert.ok(Date.now() - started < 300, "路由不该等 SSH");
    const firstBody = (await first.json()) as {
      games: { game: string; linkText: string | null }[];
    };
    assert.equal(firstBody.games.find((card) => card.game === "ff5")?.linkText, "还没启动");
    assert.equal(starts, 0);

    await source.detect(); // the same in-flight query the route started
    await route.fetch(new Request("http://localhost/api/ffpr/overview"));
    assert.equal(starts, 1);
    assert.equal(await sshCalls(sshLog), 1);
  } finally {
    resetDetection();
    await rm(directory, { recursive: true, force: true });
  }
});
