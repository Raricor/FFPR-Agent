import assert from "node:assert/strict";
import test from "node:test";
import {
  achievementView,
  formatAchievements,
  parseAchievements,
} from "../src/engine/achievements.ts";

const REPLY = {
  achievements: {
    defs: [
      {
        id: 1,
        api: "scenario_1",
        type: 1,
        typeName: "Scenario",
        value: 1,
        condition: 6,
        platform: 1,
      },
    ],
    account: [{ api: "scenario_1", achieved: true, current: 1, max: 1 }],
    save: {
      playTime: 21 * 3600 + 13 * 60 + 5,
      saveCount: 25,
      chests: 3,
      hiddenItems: 0,
      flags: { "6": [1, 0, 0, 0] },
      treasure: [
        { area: 12, name: "卡纳克城", type: 1, total: 5, open: 3 },
        { area: 12, name: "卡纳克城", type: 2, total: 1, open: 0 },
      ],
    },
  },
};

void test("achievementView carries the table, notes and treasure as data", () => {
  const data = parseAchievements(REPLY);
  const view = achievementView(data);
  assert.equal(view.title, "FF5 成就 · 当前存档");
  assert.deepEqual(view.summary, ["游戏时间 21:13:05,存过 25 次", view.summary[1]]);
  assert.match(view.summary[1] ?? "", /^本档达成 \d+ \/ 39 · Steam 已解锁 1 \/ 39$/);
  assert.equal(view.rows.length, 39);
  const row = view.rows.find((item) => item.name === "旅行的决心");
  assert.ok(row);
  assert.deepEqual(
    {
      description: row.description,
      save: row.save,
      done: row.done,
      steam: row.steam,
    },
    {
      description: "救助了蕾娜和加拉夫并一同踏上了旅程。",
      save: "✓",
      done: true,
      steam: true,
    },
  );
  assert.ok(view.notes.includes("桥插件还读不到这些成就的本档进度"));
  assert.ok(!("message" in view.treasure));
  if ("message" in view.treasure) return;
  assert.equal(view.treasure.header, "宝箱和隐藏道具(按地点) 宝箱 3 / 5 · 隐藏道具 0 / 1");
  assert.deepEqual(view.treasure.places, [
    { name: "卡纳克城", chests: "3 / 5", hidden: "0 / 1", lost: "—", done: false },
  ]);
  assert.equal(formatAchievements(data), formatAchievements(view));
});

void test("a save-less view has one summary line and no treasure table", () => {
  const view = achievementView(parseAchievements({ achievements: { save: null } }));
  assert.deepEqual(view.summary, ["还没读档，只能看 Steam 的解锁情况。"]);
  assert.deepEqual(view.treasure, { message: "桥插件还读不到按地点的宝箱数" });
  assert.ok(view.rows.every((row) => row.save === "—"));
});

function bestiaryReply(bestiary: unknown): Record<string, unknown> {
  return { achievements: { defs: [], account: [], save: null, bestiary } };
}

void test("one number in two areas is counted in both", () => {
  const data = parseAchievements(
    bestiaryReply({
      entries: [
        { number: 10, name: "风形魔", registered: false, areas: [8, 12] },
        { number: 12, name: "哥布林", registered: true, areas: [8] },
        { number: 20, name: "陆行鸟", registered: true, areas: [20] },
        { number: 21, name: "黑陆行鸟", registered: true, areas: [20] },
      ],
      areas: { "8": "风之神殿", "12": "卡纳克城", "20": "沃尔斯" },
    }),
  );
  const view = achievementView(data);
  assert.ok(!("message" in view.bestiary));
  if ("message" in view.bestiary) return;
  assert.equal(view.bestiary.header, "魔物图鉴(全账号共用) 已登记 3 / 4");
  assert.deepEqual(view.bestiary.areas, [
    {
      name: "风之神殿",
      count: "1 / 2",
      done: false,
      monsters: [
        { label: "No.010 风形魔", registered: false, status: null, details: [] },
        { label: "No.012 哥布林", registered: true, status: null, details: [] },
      ],
    },
    {
      name: "卡纳克城",
      count: "0 / 1",
      done: false,
      monsters: [{ label: "No.010 风形魔", registered: false, status: null, details: [] }],
    },
    {
      name: "沃尔斯",
      count: "2 / 2 ✓",
      done: true,
      monsters: [
        { label: "No.020 陆行鸟", registered: true, status: null, details: [] },
        { label: "No.021 黑陆行鸟", registered: true, status: null, details: [] },
      ],
    },
  ]);
  const text = formatAchievements(data);
  assert.ok(text.includes("魔物图鉴(全账号共用) 已登记 3 / 4"));
  assert.ok(text.includes("| 地点 | 已登记 | 未登记 | 不可再获得 |"));
  assert.ok(text.includes("| 风之神殿 | 1 / 2 | No.010 风形魔 |  |"));
  assert.ok(text.includes("| 沃尔斯 | 2 / 2 ✓ |  |  |"));
});

void test("two areas with one bestiary name share a row", () => {
  const data = parseAchievements(
    bestiaryReply({
      entries: [{ number: 10, name: "风形魔", registered: true, areas: [8, 12] }],
      areas: { "8": "风之神殿", "12": "风之神殿" },
    }),
  );
  const view = achievementView(data);
  assert.ok(!("message" in view.bestiary));
  if ("message" in view.bestiary) return;
  assert.deepEqual(view.bestiary.areas, [
    {
      name: "风之神殿",
      count: "1 / 1 ✓",
      done: true,
      monsters: [{ label: "No.010 风形魔", registered: true, status: null, details: [] }],
    },
  ]);
});

void test("a missing bestiary says the bridge cannot read it", () => {
  const view = achievementView(parseAchievements(bestiaryReply(null)));
  assert.deepEqual(view.bestiary, { message: "桥插件还读不到图鉴" });
  assert.ok(
    formatAchievements(parseAchievements(bestiaryReply(null))).includes("桥插件还读不到图鉴"),
  );
});

void test("area 0 without a name is the world map", () => {
  const view = achievementView(
    parseAchievements(
      bestiaryReply({
        entries: [{ number: 5, name: "杀人蜂", registered: false, areas: [0] }],
        areas: { "0": null },
      }),
    ),
  );
  assert.ok(!("message" in view.bestiary));
  if ("message" in view.bestiary) return;
  assert.deepEqual(view.bestiary.areas, [
    {
      name: "世界地图",
      count: "0 / 1",
      done: false,
      monsters: [{ label: "No.005 杀人蜂", registered: false, status: null, details: [] }],
    },
  ]);
});

const MONSTER_28 = {
  number: 28,
  monster: 28,
  name: "风形魔",
  lv: 5,
  hp: 40,
  mp: 0,
  exp: 12,
  gil: 6,
  boss: false,
  species: 1,
  resistanceAttribute: 1,
  resistanceCondition: 1,
  attributes: [{ id: 1, name: "火", type: 1 }],
  conditions: ["中毒"],
  drops: ["药草"],
  steals: ["凤凰之尾"],
};

function missableReply(registered: boolean): Record<string, unknown> {
  return {
    achievements: {
      defs: [
        {
          id: 1,
          api: "scenario_3",
          type: 1,
          typeName: "Scenario",
          value: 1,
          condition: 429,
          platform: 1,
        },
      ],
      account: [],
      save: { flags: { "429": [1, 0, 0, 0] } },
      bestiary: {
        entries: [{ number: 28, name: "风形魔", registered, areas: [71] }],
        areas: { "71": "沃尔斯塔" },
      },
    },
  };
}

void test("an unregistered missable carries its status and introduction into the view", () => {
  const view = achievementView(parseAchievements(missableReply(false)), [MONSTER_28], {
    monsterNote: (book) => (book === 28 ? "Beware the wind." : ""),
  });
  assert.ok(!("message" in view.bestiary));
  if ("message" in view.bestiary) return;
  assert.equal(view.bestiary.header, "魔物图鉴(全账号共用) 已登记 0 / 1 · 这个存档已错过 1 只");
  const monster = view.bestiary.areas[0]?.monsters[0];
  assert.ok(monster);
  assert.equal(monster.status, "不可再获得");
  assert.ok(monster.details.includes("出没：沃尔斯塔"));
  assert.ok(monster.details.includes("攻略：Beware the wind."));
  assert.equal(monster.details.at(-1), "不可再获得");
  const text = formatAchievements(parseAchievements(missableReply(false)));
  assert.ok(text.includes("| 地点 | 已登记 | 未登记 | 不可再获得 |"));
  assert.ok(text.includes("| 沃尔斯塔 | 0 / 1 · 已错过 1 | No.028 风形魔 | No.028 |"));
});

void test("a registered monster is never marked missable", () => {
  const view = achievementView(parseAchievements(missableReply(true)), [MONSTER_28]);
  assert.ok(!("message" in view.bestiary));
  if ("message" in view.bestiary) return;
  assert.equal(view.bestiary.header, "魔物图鉴(全账号共用) 已登记 1 / 1");
  assert.equal(view.bestiary.areas[0]?.monsters[0]?.status, null);
});
