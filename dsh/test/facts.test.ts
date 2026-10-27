import assert from "node:assert/strict";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { MonsterCache } from "../src/engine/bestiary.ts";
import { Elements } from "../src/engine/elements.ts";
import { KeyEvents } from "../src/engine/events.ts";
import { areaOf, buildFacts, chooseTrigger, isTown, shortenGuide } from "../src/engine/facts.ts";
import { Guide } from "../src/engine/guide/kb.ts";
import type { Chapter } from "../src/engine/guide/ludo.ts";
import { Tactics } from "../src/engine/tactics.ts";
import { FakePilot } from "./fake-pilot.ts";

const CHAPTER: Chapter = {
  slug: "fire-powered-ship",
  title: "Fire-Powered Ship",
  url: "https://example.test/fire",
  summary: "",
  prerequisites: [],
  steps: [],
  tips: ["The conveyer belt takes you to the lower floor."],
  monsters: [
    {
      book: 39,
      name: "Defeater",
      area: "Fire-Powered Ship",
      level: 12,
      hp: 260,
      weak: ["Ice"],
      absorb: ["Fire"],
      immune: [],
      steal: "",
      drop: "",
      blue: "",
      notes: "",
      row: "039 Defeater (Level 18, HP 260): Steals Potion. Weak to Ice.",
    },
  ],
  bosses: {},
  items: {},
  previous: "",
  next: "",
};

function guide(text: string): Guide {
  return new Guide(
    [{ title: "Fire-Powered Ship", text }],
    new Map([[39, "Defeater"]]),
    [CHAPTER],
    [],
    { walkthrough: "https://example.test/walkthrough" },
  );
}

async function factsGame(text: string) {
  const atlas = new Atlas();
  await atlas.visit(
    260,
    "火力船",
    [{ cell: [4, 8], to: 261, name: "出口", active: true }],
    [{ cell: [9, 6], name: "秘银手套" }],
  );
  await atlas.link(260, [13, 23], [9, 30], "传送带");
  const tactics = new Tactics();
  await tactics.set(260, [{ 巴兹: [{ do: "攻击" }] }], ["败怨魔"]);
  await tactics.record(260, "hard", "巴兹倒下");
  const events = new KeyEvents();
  events.enemies.set(260, new Set(["败怨魔"]));
  events.books.set("败怨魔", 39);
  const elements = Elements.fromChapters([CHAPTER]);
  return { events, atlas, tactics, elements, guide: guide(text), mapId: 260 };
}

function pilot(): FakePilot {
  const fake = new FakePilot();
  fake.onQuery("sample", {
    sample: {
      user: { mapId: 260, areaText: "火力船" },
      party: [
        {
          name: "巴兹",
          jobName: "骑士",
          lv: 17,
          hp: 500,
          maxHp: 600,
          mp: 60,
          maxMp: 60,
          abilities: [
            { id: 19, name: "保护", type: 19, group: 0, mp: 0 },
            { id: 1, name: "<IC_WMGC>治疗", type: 1, group: 1, mp: 4 },
          ],
        },
        {
          name: "蕾娜",
          jobName: "白魔法师",
          lv: 17,
          hp: 300,
          maxHp: 400,
          mp: 90,
          maxMp: 120,
          status: ["Blind"],
          abilities: [
            { id: 1, name: "<IC_WMGC>治疗", type: 1, group: 1, mp: 4 },
            { id: 2, name: "<IC_WMGC>救疗", type: 1, group: 1, mp: 9 },
            { id: 3, name: "<IC_BMGC>火炎", type: 2, group: 2, mp: 4 },
            { id: 4, name: "<IC_TMGC>重力", type: 501, group: 3, mp: 9 },
            { id: 5, name: "<IC_SRD>火炎剑", type: 502, group: 4, mp: 2 },
          ],
        },
      ],
    },
  });
  fake.onQuery("items", {
    items: {
      normal: [
        { name: "<IC_ITEM>眼药", count: 2 },
        { name: "恢复药", count: 3 },
        { name: "不死鸟之尾", count: 1 },
      ],
      important: [],
    },
  });
  fake.on("entities", {
    entities: {
      entities: [
        { kind: "Event", cell: [13, 23], name: "流される①" },
        { kind: "Event", cell: [13, 25], name: "流される①" },
      ],
    },
  });
  return fake;
}

void test("the fact sheet carries the map, guide, monsters, party and bag", async () => {
  const game = await factsGame("Go west, flip the lever, then take the conveyer belt.");
  const facts = await buildFacts(game, {
    kind: "new-monster",
    mapId: 260,
    detail: "新怪",
    monsters: ["败怨魔"],
    pilot: pilot(),
  });
  assert.match(facts, /### 起因[\s\S]*写战术时没见过的怪:败怨魔/);
  assert.match(facts, /### 地图[\s\S]*地图 260 火力船/);
  assert.match(facts, /出口:\(4, 8\)→地图 261 出口/);
  assert.match(facts, /宝箱:\(9, 6\) 秘银手套/);
  assert.match(facts, /流される① 传送带，踩上去会被带走/);
  assert.match(facts, /走法:在 \(13, 23\) 传送带 到 \(9, 30\)/);
  assert.match(facts, /### 攻略[\s\S]*【Fire-Powered Ship】[\s\S]*flip the lever/);
  assert.match(facts, /### 怪物[\s\S]*败怨魔 图鉴 #039 HP 260 弱 冰;吸收 火/);
  assert.match(facts, /攻略:039 Defeater.*HP 260/);
  assert.match(facts, /### 队伍[\s\S]*全队的魔法:/);
  assert.match(facts, /- 白魔法:治疗\(4MP\)、救疗\(9MP\)/);
  assert.match(facts, /- 黑魔法:火炎\(4MP\)/);
  assert.match(facts, /- 时魔法:重力\(9MP\)/);
  assert.match(facts, /- 魔法剑:火炎剑\(2MP\)/);
  assert.match(facts, /巴兹 骑士 Lv17 HP 500\/600 MP 60\/60 能力:保护/);
  assert.match(facts, /蕾娜 白魔法师.*状态:黑暗 能放:白魔法/);
  assert.match(
    facts,
    /队伍有但现在没人能放的魔法：黑魔法 火炎;时魔法 重力;魔法剑 火炎剑\(换职业才能用\)$/,
  );
  assert.doesNotMatch(facts, /<IC_/);
  assert.doesNotMatch(facts, /桥插件这次没有给已学法术/);
  assert.match(facts, /### 背包[\s\S]*恢复药×3[\s\S]*不死鸟之尾×1[\s\S]*眼药×2/);
  assert.match(facts, /### 上次战斗[\s\S]*hard\(巴兹倒下\)/);
  assert.doesNotMatch(facts, /### 这里的遇敌表/);
});

void test("the encounter table adds the formations and each monster's facts", async () => {
  const fake = pilot();
  fake.onQuery("encounters", {
    encounters: {
      monsterSet: 3,
      parties: [
        {
          id: 1,
          rate: 600,
          notEscape: false,
          monsters: [
            { name: "败怨魔", book: 39 },
            { name: "败怨魔", book: 39 },
          ],
        },
        { id: 2, rate: 400, notEscape: true, monsters: [{ name: "哥布林", book: 1 }] },
      ],
    },
  });
  fake.onQuery("monsters", {
    monsters: [
      {
        number: 39,
        name: "败怨魔",
        hp: 260,
        attributes: [
          { id: 2, type: 1 },
          { id: 1, type: 4 },
        ],
      },
    ],
  });
  const cache = new MonsterCache();
  const game = { ...(await factsGame("walkthrough")), monsterCache: cache };
  const facts = await buildFacts(game, {
    kind: "new-map",
    mapId: 260,
    detail: "",
    pilot: fake,
  });
  assert.match(facts, /### 这里的遇敌表/);
  assert.match(facts, /败怨魔 ×2 · 60%/);
  assert.match(facts, /哥布林 · 40% · 不能逃/);
  assert.match(facts, /- 败怨魔: HP 260 · 弱：冰 · 吸收：火/);
  assert.match(facts, /- 哥布林\n/);
});

void test("a long guide chapter is cut at the fact-sheet limit, keeping the start", () => {
  const body = "【Fire-Powered Ship】\n" + "机关和走法。".repeat(2000);
  const cut = shortenGuide(body);
  assert.ok(Array.from(cut).length <= 6000 + 20);
  assert.ok(cut.startsWith("【Fire-Powered Ship】"));
  assert.ok(cut.endsWith("…(攻略太长,后面省略)"));
});

void test("the code-enforced moments pick one trigger, in the documented order", async () => {
  const game = await factsGame("walkthrough");
  assert.deepEqual(chooseTrigger({ mapId: 260, tactics: new Tactics(), met: [] }), {
    kind: "new-map",
    mapId: 260,
    detail: "这张地图还没有战斗策略",
  });
  assert.equal(chooseTrigger({ mapId: 1, tactics: new Tactics(), met: [] }), null);
  const stale = game.tactics;
  assert.equal(
    chooseTrigger({ mapId: 260, tactics: stale, met: ["败怨魔", "新怪"] })?.kind,
    "new-monster",
  );
  assert.equal(
    chooseTrigger({
      mapId: 260,
      tactics: stale,
      met: ["败怨魔"],
      lastBattle: { mapId: 260, verdict: "hard", detail: "巴兹倒下" },
    })?.kind,
    "bad-battle",
  );
  assert.equal(
    chooseTrigger({
      mapId: 260,
      tactics: stale,
      met: ["败怨魔"],
      blocked: { count: 3, detail: "在 (1, 2) 被挡住" },
    })?.kind,
    "blocked",
  );
  assert.equal(
    chooseTrigger({
      mapId: 260,
      tactics: stale,
      met: ["败怨魔"],
      ride: "踩到传送带 (13, 23),被带到 (9, 30)",
    })?.kind,
    "conveyor",
  );
});

void test("an old bridge without abilities keeps the note and lists no spells", async () => {
  const without = pilot();
  without.onQuery("sample", {
    sample: {
      user: { mapId: 260, areaText: "火力船" },
      party: [{ name: "巴兹", jobName: "骑士", lv: 17, hp: 500, maxHp: 600, mp: 60, maxMp: 60 }],
    },
  });
  const facts = await buildFacts(await factsGame("walkthrough"), {
    kind: "new-map",
    mapId: 260,
    detail: "",
    pilot: without,
  });
  assert.match(facts, /桥插件这次没有给已学法术/);
  assert.doesNotMatch(facts, /全队的魔法:/);
});

void test("a guide area with several parts keeps the whole chapter", async () => {
  const game = await factsGame("part one");
  const split = {
    ...game,
    guide: new Guide(
      [
        { title: "Fire-Powered Ship: Part I", text: "第一段的机关。" },
        { title: "Fire-Powered Ship: Part II", text: "第二段的传送带。" },
        { title: "Tower of Walse", text: "别的地图。" },
      ],
      new Map([[39, "Defeater"]]),
      [CHAPTER],
    ),
  };
  const facts = await buildFacts(split, {
    kind: "new-map",
    mapId: 260,
    detail: "",
    pilot: pilot(),
  });
  assert.match(facts, /【Fire-Powered Ship: Part I】[\s\S]*第一段的机关/);
  assert.match(facts, /【Fire-Powered Ship: Part II】[\s\S]*第二段的传送带/);
  assert.doesNotMatch(facts, /别的地图/);
});

void test("a town's maps share one tactician call; castles and dungeons do not", () => {
  assert.equal(areaOf("卡纳克镇 旅店"), "卡纳克镇");
  assert.equal(isTown("卡纳克镇"), true);
  assert.equal(isTown("图尔村"), true);
  assert.equal(isTown("卡纳克城"), false);
  assert.equal(isTown("火力船"), false);
  const covered = new Set(["卡纳克镇"]);
  const tactics = new Tactics();
  const inn = { mapId: 89, tactics, met: [], mapName: "卡纳克镇 旅店", townsCovered: covered };
  assert.equal(chooseTrigger(inn), null);
  const castle = { ...inn, mapId: 95, mapName: "卡纳克城 １层" };
  assert.equal(chooseTrigger(castle)?.kind, "new-map");
  const otherTown = { ...inn, mapId: 30, mapName: "图尔村" };
  assert.equal(chooseTrigger(otherTown)?.kind, "new-map");
});
