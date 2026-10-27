import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { CommandDefinition, CommandInvocation } from "@deepseek-ai/dsh-commands";
import { formatAchievements, parseAchievements, progressRows } from "../src/engine/achievements.ts";
import { LinkError } from "../src/engine/bridge.ts";
import type { BridgeLink } from "../src/engine/bridge.ts";
import type { PlayerEngine } from "../src/plugin/player.ts";
import { installCommands } from "../src/plugin/commands.ts";
import { FakePilot } from "./fake-pilot.ts";

const DEFS = [
  {
    id: 1,
    api: "scenario_1",
    type: 1,
    typeName: "Scenario",
    value: 1,
    condition: 6,
    platform: 1,
  },
  {
    id: 2,
    api: "scenario_2",
    type: 1,
    typeName: "Scenario",
    value: 1,
    condition: 7,
    platform: 1,
  },
  {
    id: 3,
    api: "treasure_box_21",
    type: 8,
    typeName: "ChestComplete",
    value: 21,
    condition: 0,
    platform: 1,
  },
  {
    id: 4,
    api: "treasure_box_112",
    type: 8,
    typeName: "ChestComplete",
    value: 112,
    condition: 0,
    platform: 1,
  },
  {
    id: 5,
    api: "picture_book_30",
    type: 4,
    typeName: "PictureBookComplete",
    value: 30,
    condition: 0,
    platform: 1,
  },
  {
    id: 6,
    api: "magic_learning_10",
    type: 20,
    typeName: "LearningBlueMagic",
    value: 10,
    condition: 0,
    platform: 1,
  },
  {
    id: 7,
    api: "monster_hunt_100",
    type: 3,
    typeName: "MonsterSubjugationCount",
    value: 100,
    condition: 0,
    platform: 1,
  },
  {
    id: 8,
    api: "job_master_1",
    type: 19,
    typeName: "JobMasters",
    value: 1,
    condition: 0,
    platform: 1,
  },
  {
    id: 9,
    api: "level_all_50",
    type: 6,
    typeName: "MemberLevel",
    value: 50,
    condition: 0,
    platform: 1,
  },
  {
    id: 10,
    api: "all_achievement",
    type: 9,
    typeName: "AllComplete",
    value: 39,
    condition: 0,
    platform: 1,
  },
  {
    id: 11,
    api: "total_gil_10000",
    type: 18,
    typeName: "SlotTotalGil",
    value: 0,
    condition: 0,
    platform: 1,
  },
];

const ACCOUNT = [
  { api: "scenario_1", achieved: true, current: 1, max: 1, name: "旅行的决心", description: "" },
  { api: "scenario_2", achieved: false, current: 0, max: 1, name: "", description: "" },
  { api: "treasure_box_21", achieved: true, current: 21, max: 21, name: "", description: "" },
  { api: "treasure_box_112", achieved: true, current: 112, max: 112, name: "", description: "" },
  { api: "picture_book_30", achieved: true, current: 45, max: 30, name: "", description: "" },
  { api: "monster_hunt_100", achieved: false, current: 312, max: 100, name: "", description: "" },
  { api: "all_achievement", achieved: false, current: 4, max: 38, name: "", description: "" },
];

const SAVE = {
  playTime: 21 * 3600 + 13 * 60 + 5,
  saveCount: 25,
  gil: 3036,
  totalGil: 155798,
  kills: 312,
  battles: 280,
  chests: 22,
  openChestCount: 22,
  hiddenItems: 3,
  treasure: [
    { area: 1, name: "风之神殿", type: 1, total: 204, open: 6 },
    { area: 12, name: "卡纳克城", type: 1, total: 5, open: 3 },
    { area: 12, name: "卡纳克城", type: 2, total: 1, open: 0 },
    { area: 13, name: "古代图书馆", type: 1, total: 16, open: 13 },
    { area: 13, name: "古代图书馆", type: 2, total: 39, open: 3 },
  ],
  members: [
    {
      id: 1,
      name: "巴兹",
      level: 22,
      jobs: [
        { id: 1, level: 3, mastered: false },
        { id: 2, level: 8, mastered: true },
      ],
    },
    {
      id: 2,
      name: "蕾娜",
      level: 20,
      jobs: [
        { id: 2, level: 8, mastered: true },
        { id: 3, level: 1, mastered: null },
      ],
    },
  ],
  releasedJobs: [1, 2, 3],
  magicTypes: { "1": { total: 32, owned: 6 } },
  flags: { "6": [1, 0, 0, 0], "7": [0, 0, 0, 0] },
};

function reply(
  overrides: { defs?: unknown; account?: unknown; save?: unknown } = {},
): Record<string, unknown> {
  return {
    type: "reply",
    op: "achievements",
    ok: true,
    achievements: {
      defs: overrides.defs ?? DEFS,
      account: overrides.account === undefined ? ACCOUNT : overrides.account,
      save: overrides.save === undefined ? SAVE : overrides.save,
    },
  };
}

function rowFor(api: string) {
  const row = progressRows(parseAchievements(reply())).find((item) => item.api === api);
  assert.ok(row, `no row for ${api}`);
  return row;
}

void test("a raised scenario flag is done and a clear one is not", () => {
  assert.deepEqual(
    { current: rowFor("scenario_1").current, done: rowFor("scenario_1").done },
    { current: 1, done: true },
  );
  assert.deepEqual(
    { current: rowFor("scenario_2").current, done: rowFor("scenario_2").done },
    { current: 0, done: false },
  );
  const text = formatAchievements(parseAchievements(reply()));
  assert.ok(text.includes("| 旅行的决心 | 救助了蕾娜和加拉夫并一同踏上了旅程。 | ✓ | ✓ |"));
  assert.ok(text.includes("| 风之心“探求” | 领取了风之水晶的力量。 | 未达成 |"));
});

void test("the save's chest count can trail Steam's unlocked flag", () => {
  const text = formatAchievements(parseAchievements(reply()));
  assert.ok(text.includes("| 新手宝物猎人 | 宝箱的回收率达到了10%。 | 22 / 21 ✓ | ✓ |"));
  assert.ok(text.includes("| 老练宝物猎人 | 宝箱的回收率达到了50%。 | 22 / 112 | ✓ |"));
});

void test("the bestiary is marked as account-wide", () => {
  const row = rowFor("picture_book_30");
  assert.equal(row.current, 45);
  assert.equal(row.done, true);
  assert.equal(row.accountWide, true);
  const text = formatAchievements(parseAchievements(reply()));
  assert.ok(text.includes("45 / 30 ✓(全账号)"));
  assert.ok(text.includes("图鉴全账号共用，没有本档进度"));
});

void test("a type outside the save table is unreadable and says so", () => {
  const row = rowFor("magic_learning_10");
  assert.equal(row.current, null);
  assert.equal(row.done, false);
  const text = formatAchievements(parseAchievements(reply()));
  assert.ok(text.includes("桥插件还读不到这些成就的本档进度"));
  assert.equal(text.includes("击杀：本档 312 只;Steam 的击杀数是全账号累计的"), true);
});

void test("no save shows only Steam's flags and a dash in the save column", () => {
  const text = formatAchievements(parseAchievements(reply({ save: null })));
  assert.ok(text.includes("还没读档，只能看 Steam 的解锁情况。"));
  assert.ok(text.includes("| 旅行的决心 | 救助了蕾娜和加拉夫并一同踏上了旅程。 | — | ✓ |"));
  assert.equal(text.includes("还没读档，只能看 Steam 的解锁情况。\n本档达成"), false);
});

void test("no account data still formats the save's progress", () => {
  const data = parseAchievements(reply({ account: null }));
  assert.equal(data.account, null);
  const text = formatAchievements(data);
  assert.ok(text.includes("Steam 进度读不到"));
  assert.ok(text.includes("本档达成"));
});

void test("a missing master value falls back to the number at the end of the API name", () => {
  assert.equal(rowFor("total_gil_10000").target, 10000);
  const noValue = reply({
    defs: [
      {
        id: 1,
        api: "treasure_box_225",
        type: 8,
        typeName: "ChestComplete",
        value: null,
        condition: 0,
        platform: 1,
      },
    ],
  });
  const row = progressRows(parseAchievements(noValue)).find(
    (item) => item.api === "treasure_box_225",
  );
  assert.ok(row);
  assert.equal(row.target, 225);
});

/** The shape of the 10-27 live dump: tiers share a stat name, other platforms have rows too. */
function liveShape(): Record<string, unknown> {
  const steam = (id: number, api: string, typeName: string, value: number, condition = 0) => ({
    id,
    api,
    type: 0,
    typeName,
    value,
    condition,
    platform: 1,
  });
  return {
    achievements: {
      defs: [
        steam(1, "all_achievement", "AllComplete", 0),
        steam(2, "scenario_1", "Scenario", 1, 6),
        steam(14, "get_sealed_weapon", "SpecificItems", 1),
        steam(26, "total_gil", "SlotTotalGil", 10000),
        steam(27, "total_gil", "SlotTotalGil", 100000),
        steam(28, "total_gil", "SlotTotalGil", 500000),
        steam(38, "get_hidden_item", "HiddenItems", 1),
        { ...steam(66, "ff5PR_achievement26", "SlotTotalGil", 10000), platform: 3 },
      ],
      account: [
        { api: "all_achievement", achieved: true, current: 0, max: 0 },
        { api: "scenario_1", achieved: true, current: 1, max: 1 },
        { api: "total_gil", achieved: true, current: 155798, max: 10000 },
        { api: "total_gil", achieved: true, current: 155798, max: 100000 },
        { api: "total_gil", achieved: false, current: 155798, max: 500000 },
      ],
      save: {
        totalGil: 105710,
        hiddenItems: 5,
        flags: { "6": [1, 0, 0, 0] },
        treasure: [
          { area: 55, name: "封印之间", type: 2, total: 12, open: 0 },
          { area: 79, name: "慕亚大森林", type: 1, total: 12, open: 2 },
          { area: 86, name: "慕亚大森林", type: 1, total: 12, open: 1 },
          { area: 90, name: "洞窟", type: 2, total: 43, open: 5 },
        ],
      },
    },
  };
}

void test("a tier is matched to its stat row by target, and other platforms are ignored", () => {
  const rows = progressRows(parseAchievements(liveShape()));
  assert.equal(rows.length, 39);
  const gil = rows.filter((row) => row.api.startsWith("total_gil_"));
  assert.deepEqual(
    gil.map((row) => [row.current, row.target, row.done, row.steam]),
    [
      [105710, 10000, true, true],
      [105710, 100000, true, true],
      [105710, 500000, false, false],
    ],
  );
});

void test("all achievements counts the other rows, not its own account flag", () => {
  const row = progressRows(parseAchievements(liveShape())).find(
    (item) => item.api === "all_achievement",
  );
  assert.ok(row);
  assert.equal(row.steam, false);
  assert.deepEqual([row.current, row.target, row.done], [3, 38, false]);
});

void test("hidden items aim at every hidden item and sealed weapons at 封印之间", () => {
  const rows = progressRows(parseAchievements(liveShape()));
  const hidden = rows.find((row) => row.api === "get_hidden_item");
  const sealed = rows.find((row) => row.api === "get_sealed_weapon");
  assert.deepEqual([hidden?.current, hidden?.target], [5, 55]);
  assert.deepEqual([sealed?.current, sealed?.target], [0, 12]);
});

void test("two areas with one name share a row", () => {
  const text = formatAchievements(parseAchievements(liveShape()));
  assert.ok(text.includes("| 慕亚大森林 | 3 / 24 | — |"));
  assert.equal(text.split("慕亚大森林").length, 2);
});

void test("an achievement listed once per platform shows once, from Steam's row", () => {
  const android = { ...DEFS[2], id: 103, value: 99, platform: 2 };
  const data = parseAchievements(reply({ defs: [android, ...DEFS] }));
  const rows = progressRows(data).filter((row) => row.api === "treasure_box_21");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.target, 21);
  const once = formatAchievements(parseAchievements(reply()));
  assert.equal(formatAchievements(data).split("\n")[1], once.split("\n")[1]);
});

void test("missing fields stay null instead of throwing", () => {
  const data = parseAchievements({ achievements: { defs: [{ api: "x" }] } });
  assert.equal(data.account, null);
  assert.equal(data.save, null);
  assert.deepEqual(
    {
      id: data.defs[0]?.id,
      typeName: data.defs[0]?.typeName,
      value: data.defs[0]?.value,
    },
    { id: null, typeName: null, value: null },
  );
});

function treasureText(treasure: unknown, save: Record<string, unknown> = SAVE): string {
  return formatAchievements(parseAchievements(reply({ save: { ...save, treasure } })));
}

void test("one place can hold both chests and hidden items", () => {
  const text = treasureText(
    [
      { area: 12, name: "卡纳克城", type: 1, total: 5, open: 3 },
      { area: 12, name: "卡纳克城", type: 2, total: 1, open: 0 },
    ],
    { ...SAVE, chests: 3, hiddenItems: 0 },
  );
  assert.ok(text.includes("**宝箱和隐藏道具(按地点)** 宝箱 3 / 5 · 隐藏道具 0 / 1"));
  assert.ok(text.includes("| 卡纳克城 | 3 / 5 | 0 / 1 |"));
});

void test("a place with only chests shows a dash for hidden items", () => {
  const text = treasureText([{ area: 7, name: "沃尔斯", type: 1, total: 5, open: 3 }], {
    ...SAVE,
    chests: 3,
    hiddenItems: 0,
  });
  assert.ok(text.includes("| 沃尔斯 | 3 / 5 | — |"));
});

void test("a completed place gets a check mark", () => {
  const text = treasureText([{ area: 1, name: "风之神殿", type: 1, total: 6, open: 6 }], {
    ...SAVE,
    chests: 6,
    hiddenItems: 0,
  });
  assert.ok(text.includes("| 风之神殿 | 6 / 6 ✓ | — |"));
});

void test("a missing area name falls back to its number", () => {
  const text = treasureText([{ area: 12, name: null, type: 1, total: 5, open: 3 }]);
  assert.ok(text.includes("| 地点 12 | 3 / 5 | — |"));
});

void test("an unreadable treasure flag keeps the total and says so", () => {
  const text = treasureText([{ area: 12, name: "卡纳克城", type: 1, total: 5, open: null }], {
    ...SAVE,
    chests: 3,
    hiddenItems: 0,
  });
  assert.ok(text.includes("| 卡纳克城 | 读不到 / 5 | — |"));
  assert.ok(text.includes("**宝箱和隐藏道具(按地点)** 宝箱 3 / 5 · 隐藏道具 0 / 0"));
});

void test("missing treasure data says the bridge cannot read it", () => {
  const text = treasureText(null);
  assert.ok(text.includes("桥插件还读不到按地点的宝箱数"));
  assert.equal(text.includes("| 地点 | 宝箱 | 隐藏道具 |"), false);
  const absent = formatAchievements(
    parseAchievements(reply({ save: { ...SAVE, treasure: undefined } })),
  );
  assert.ok(absent.includes("桥插件还读不到按地点的宝箱数"));
});

function engineWith(bridge: BridgeLink | undefined): PlayerEngine {
  return { bridge } as unknown as PlayerEngine;
}

interface Registered {
  readonly definitions: CommandDefinition[];
  readonly disposers: (() => void)[];
}

function fakeContext(): { ctx: Context; registered: Registered } {
  const registered: Registered = { definitions: [], disposers: [] };
  const ctx = {
    commands: {
      register: (definition: CommandDefinition) => {
        registered.definitions.push(definition);
        const dispose = (): void => undefined;
        registered.disposers.push(dispose);
        return dispose;
      },
    },
    effect: (start: () => () => void) => {
      registered.disposers.push(start());
    },
  } as unknown as Context;
  return { ctx, registered };
}

function invocation(): CommandInvocation {
  return { signal: new AbortController().signal } as unknown as CommandInvocation;
}

void test("/ach registers on ctx and answers with the formatted table", async () => {
  const { ctx, registered } = fakeContext();
  const pilot = new FakePilot().onQuery("achievements", reply());
  installCommands(ctx, engineWith({} as BridgeLink), () => pilot);
  const definition = registered.definitions[0];
  assert.ok(definition);
  assert.equal(definition.name, "ach");
  assert.equal(definition.description, "当前存档的成就进度(对照 Steam 解锁情况)");
  assert.ok(registered.disposers.length > 0);
  const result = await definition.handler(invocation());
  assert.equal(result.kind, "success");
  assert.ok(result.text?.includes("| 成就 | 条件 | 本档 | Steam |"));
  assert.deepEqual(pilot.calls, [{ kind: "query", q: "achievements", fields: {} }]);
});

void test("/ach says the bridge is down when the game is not open", async () => {
  const { ctx, registered } = fakeContext();
  let asked = false;
  installCommands(ctx, engineWith(undefined), () => {
    asked = true;
    return new FakePilot();
  });
  const definition = registered.definitions[0];
  assert.ok(definition);
  assert.deepEqual(await definition.handler(invocation()), {
    kind: "error",
    text: "连不上桥插件，游戏可能没开",
  });
  assert.equal(asked, false);
});

class FailingPilot extends FakePilot {
  override query(): Promise<Record<string, unknown>> {
    return Promise.reject(new LinkError("连不上 ws://127.0.0.1:47800/v1/query:测试"));
  }
}

void test("/ach turns a link failure into the same error", async () => {
  const { ctx, registered } = fakeContext();
  installCommands(ctx, engineWith({} as BridgeLink), () => new FailingPilot());
  const definition = registered.definitions[0];
  assert.ok(definition);
  assert.deepEqual(await definition.handler(invocation()), {
    kind: "error",
    text: "连不上桥插件，游戏可能没开",
  });
});

/** Walse Tower (area 71) and Karnak Castle (area 24), with the water crystal flag as given. */
function oneTimeText(waterCrystal: number, walseOpen: number): string {
  return formatAchievements(
    parseAchievements({
      achievements: {
        defs: [
          {
            id: 4,
            api: "scenario_3",
            type: 1,
            typeName: "Scenario",
            value: 1,
            condition: 429,
            platform: 1,
          },
        ],
        account: [],
        save: {
          flags: { "429": [waterCrystal, 0, 0, null] },
          treasure: [
            { area: 24, name: "卡纳克城", type: 1, total: 15, open: 0 },
            { area: 71, name: "沃尔斯塔", type: 1, total: 4, open: walseOpen },
            { area: 80, name: "风之神殿", type: 1, total: 4, open: 3 },
          ],
        },
      },
    }),
  );
}

void test("boxes left in a one-time place are missed once its story flag is set", () => {
  const text = oneTimeText(1, 2);
  assert.ok(text.includes("| 沃尔斯塔 | 2 / 4 | — | 已错过 2 |"));
  assert.ok(text.includes("已错过 2 个宝箱，这个存档拿不到「传奇宝物猎人」(100%)"));
});

void test("a one-time place before its deadline only warns", () => {
  const text = oneTimeText(0, 2);
  assert.ok(text.includes("| 沃尔斯塔 | 2 / 4 | — | 限时:打倒塔顶首领前 |"));
  assert.ok(text.includes("| 卡纳克城 | 0 / 15 | — | 限时:火力船首领后的 10 分钟逃脱里 |"));
  assert.equal(text.includes("个宝箱，这个存档拿不到"), false);
});

void test("a one-time place taken in full and an ordinary place show no loss", () => {
  const text = oneTimeText(1, 4);
  assert.ok(text.includes("| 沃尔斯塔 | 4 / 4 ✓ | — | — |"));
  assert.ok(text.includes("| 风之神殿 | 3 / 4 | — | — |"));
});
