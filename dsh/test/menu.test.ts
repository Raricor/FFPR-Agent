import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptEntry } from "./fake-pilot.ts";
import { FakePilot, recordedCalls, scriptReplies } from "./fake-pilot.ts";
import { FakeItemMenu } from "./fake-item-menu.ts";
import { FakeJobMenu } from "./fake-job-menu.ts";
import {
  cast,
  changeJob,
  leaveMenu,
  optimizeEquipment,
  useItem,
} from "../src/engine/skills/menu.ts";

interface Case {
  readonly name: string;
  readonly out: unknown;
  readonly calls: unknown[];
  readonly transcript: TranscriptEntry[];
}

interface Fixture {
  readonly cases: Case[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "menu", "menu.json"), "utf8"),
) as Fixture;

const runners: Record<string, (pilot: FakePilot) => Promise<unknown>> = {
  "cast from the field menu": (pilot) => cast(pilot, "蕾娜", "治疗", "巴兹"),
  "caster has no such target": (pilot) => cast(pilot, "蕾娜", "治疗", "加拉夫"),
  "strongest equipment for one member": (pilot) => optimizeEquipment(pilot),
  "leave the menu": (pilot) => leaveMenu(pilot),
  "leave fails": (pilot) => leaveMenu(pilot),
};

for (const item of fixture.cases) {
  void test(item.name, async () => {
    const run = runners[item.name] ?? assert.fail(`no runner for ${item.name}`);
    const pilot = new FakePilot();
    scriptReplies(pilot, item.transcript);
    assert.deepEqual(await run(pilot), item.out);
    assert.deepEqual(recordedCalls(pilot), item.calls);
  });
}

const PARTY = [
  { name: "巴兹", hp: 100, maxHp: 100 },
  { name: "蕾娜", hp: 80, maxHp: 100, status: ["Blind"] },
];

interface CastAbility {
  readonly name: string;
  readonly id: number;
  readonly mp: number;
  readonly usable?: boolean;
  readonly battleOnly?: boolean;
}

/** The bridge's magic window for a cast test: Tab → Magic → White → the ability list. */
function installCastMenu(pilot: FakePilot, mp: number, abilities: readonly CastAbility[]): void {
  let stage: "closed" | "top" | "types" | "list" = "closed";
  let topCursor = 0;
  const members = [
    { name: "蕾娜", hp: 100, maxHp: 100, mp, maxMp: 124 },
    { name: "加拉夫", hp: 60, maxHp: 100, mp: 20, maxMp: 20 },
  ];
  pilot.on("pos", { pos: { state: "Player" } });
  pilot.on("leave", { ok: true, presses: 1 });
  pilot.on("keys", (fields) => {
    const raw = fields.keys;
    const keys = Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === "string")
      : [];
    for (const spec of keys) {
      const [key = "", count] = spec.split("*");
      for (let i = 0; i < (count === undefined ? 1 : Number(count)); i++) {
        if (key === "Tab") stage = "top";
        else if (stage === "top") {
          if (key === "Down") topCursor = Math.min(0, topCursor + 1);
          if (key === "Up") topCursor = Math.max(0, topCursor - 1);
          if (key === "Enter") stage = "types";
        } else if (stage === "types" && key === "Enter") stage = "list";
      }
    }
    return { ok: true };
  });
  pilot.onQuery("sample", () => ({ sample: { party: members } }));
  pilot.onQuery("menu", () => {
    const top = {
      open: true,
      commands: [{ id: "Magic", name: "魔法" }],
      cursor: topCursor,
    };
    if (stage === "top") return { menu: top };
    if (stage === "types") {
      return {
        menu: {
          ...top,
          state: "Magic",
          magic: {
            character: "蕾娜",
            commands: [{ name: "白魔法", enabled: true }],
            commandCursor: 0,
          },
        },
      };
    }
    if (stage === "list") {
      return {
        menu: {
          ...top,
          state: "Magic",
          magic: {
            character: "蕾娜",
            state: "MagicList",
            abilities,
            contentIds: abilities.map((ability) => ability.id),
            abilityCursor: 0,
          },
        },
      };
    }
    return { menu: { open: false } };
  });
}

void test("useItem cures blindness from the field menu", async () => {
  const pilot = new FakePilot();
  const menu = new FakeItemMenu({
    items: [
      { name: "恢复药", count: 3 },
      { name: "解毒药", count: 1 },
      { name: "眼药", count: 2 },
    ],
    members: PARTY,
    target: "蕾娜",
    targetStatus: "Blind",
  });
  menu.install(pilot);
  assert.deepEqual(await useItem(pilot, "眼药", "蕾娜"), [
    true,
    "给 蕾娜 用了「眼药」:黑暗 治好了",
  ]);
  // The whole key flow: Tab → 道具 → 使用 → 眼药 → 蕾娜.
  assert.deepEqual(pilot.keys(), [
    ["Tab"],
    ["Down"],
    ["Enter"],
    ["Enter"],
    ["Down"],
    ["Enter"],
    ["Down"],
    ["Enter"],
  ]);
});

void test("useItem reaches a right-column item deep in a long list", async () => {
  const pilot = new FakePilot();
  const items = Array.from({ length: 11 }, (_, index) => ({
    name: `道具${index + 1}`,
    count: 1,
  }));
  items.push({ name: "眼药", count: 1 });
  const menu = new FakeItemMenu({
    items,
    members: PARTY,
    target: "蕾娜",
    targetStatus: "Blind",
  });
  menu.install(pilot);
  assert.deepEqual(await useItem(pilot, "眼药", "蕾娜"), [
    true,
    "给 蕾娜 用了「眼药」:黑暗 治好了",
  ]);
  const keys = pilot.keys().map((keys) => keys[0]);
  assert.equal(keys.filter((key) => key === "Down").length, 7); // top, five rows, 蕾娜
  assert.equal(keys.filter((key) => key === "Right").length, 1); // odd index: the right column
});

void test("cast says the caster is short of MP when a grey spell costs more", async () => {
  const pilot = new FakePilot();
  installCastMenu(pilot, 0, [{ name: "<IC_WMGC>治疗", id: 10, mp: 4, usable: false }]);
  assert.deepEqual(await cast(pilot, "蕾娜", "治疗", "加拉夫"), [
    false,
    "蕾娜 MP 0,不够放「治疗」(要 4)",
  ]);
});

void test("cast does not guess battle-only when the grey spell has no reason data", async () => {
  const pilot = new FakePilot();
  installCastMenu(pilot, 100, [{ name: "治疗", id: 10, mp: 4, usable: false }]);
  assert.deepEqual(await cast(pilot, "蕾娜", "治疗", "加拉夫"), [
    false,
    "菜单里「治疗」是灰的,原因读不到(可能是 MP 不够或这里不能用)",
  ]);
});

void test("cast says battle-only only when the bridge marks the spell that way", async () => {
  const pilot = new FakePilot();
  installCastMenu(pilot, 100, [{ name: "治疗", id: 10, mp: 4, usable: false, battleOnly: true }]);
  assert.deepEqual(await cast(pilot, "蕾娜", "治疗", "加拉夫"), [
    false,
    "现在用不了「治疗」:这个魔法在地图上不能用(只能在战斗里用)",
  ]);
});

void test("useItem reaches a late item on a long list", async () => {
  const pilot = new FakePilot();
  const items = Array.from({ length: 30 }, (_, index) => ({
    name: `道具${index + 1}`,
    count: 1,
  }));
  items[20] = { name: "眼药", count: 1 };
  const menu = new FakeItemMenu({
    items,
    members: PARTY,
    target: "蕾娜",
    targetStatus: "Blind",
  });
  menu.install(pilot);
  assert.deepEqual(await useItem(pilot, "眼药", "蕾娜"), [
    true,
    "给 蕾娜 用了「眼药」:黑暗 治好了",
  ]);
  assert.equal(menu.stage, "done");
});

void test("useItem moves right into the right column instead of pressing Down", async () => {
  const pilot = new FakePilot();
  const menu = new FakeItemMenu({
    items: [
      { name: "恢复药", count: 1 },
      { name: "解毒药", count: 1 },
      { name: "帐篷", count: 1 },
      { name: "眼药", count: 1 },
    ],
    members: PARTY,
    target: "蕾娜",
    targetStatus: "Blind",
  });
  menu.install(pilot);
  assert.deepEqual(await useItem(pilot, "眼药", "蕾娜"), [
    true,
    "给 蕾娜 用了「眼药」:黑暗 治好了",
  ]);
  assert.deepEqual(pilot.keys(), [
    ["Tab"],
    ["Down"],
    ["Enter"],
    ["Enter"],
    ["Down"],
    ["Right"],
    ["Enter"],
    ["Down"],
    ["Enter"],
  ]);
});

void test("useItem reaches the last row of an odd-length grid", async () => {
  const pilot = new FakePilot();
  const items = Array.from({ length: 30 }, (_, index) => ({
    name: `道具${index + 1}`,
    count: 1,
  }));
  items.push({ name: "眼药", count: 1 });
  const menu = new FakeItemMenu({
    items,
    members: PARTY,
    target: "蕾娜",
    targetStatus: "Blind",
  });
  menu.install(pilot);
  assert.deepEqual(await useItem(pilot, "眼药", "蕾娜"), [
    true,
    "给 蕾娜 用了「眼药」:黑暗 治好了",
  ]);
  assert.equal(menu.listCursor, 30);
  assert.equal(
    pilot
      .keys()
      .map((keys) => keys[0])
      .filter((key) => key === "Down").length,
    17, // top, fifteen rows, 蕾娜
  );
});

void test("useItem steers back from the end of the list to an early item", async () => {
  const pilot = new FakePilot();
  const items = Array.from({ length: 31 }, (_, index) => ({
    name: `道具${index + 1}`,
    count: 1,
  }));
  items[1] = { name: "眼药", count: 1 };
  const menu = new FakeItemMenu({
    items,
    members: PARTY,
    target: "蕾娜",
    targetStatus: "Blind",
    cursor: 30,
  });
  menu.install(pilot);
  assert.deepEqual(await useItem(pilot, "眼药", "蕾娜"), [
    true,
    "给 蕾娜 用了「眼药」:黑暗 治好了",
  ]);
  const keys = pilot.keys().map((keys) => keys[0]);
  assert.equal(keys.filter((key) => key === "Up").length >= 14, true);
  assert.equal(keys.includes("Left"), true);
});

void test("useItem infers a three-column list instead of hard-coding two", async () => {
  const pilot = new FakePilot();
  const items = Array.from({ length: 7 }, (_, index) => ({
    name: `道具${index + 1}`,
    count: 1,
  }));
  items[5] = { name: "眼药", count: 1 };
  const menu = new FakeItemMenu({
    items,
    members: PARTY,
    target: "蕾娜",
    targetStatus: "Blind",
    columns: 3,
  });
  menu.install(pilot);
  assert.deepEqual(await useItem(pilot, "眼药", "蕾娜"), [
    true,
    "给 蕾娜 用了「眼药」:黑暗 治好了",
  ]);
  assert.deepEqual(pilot.keys(), [
    ["Tab"],
    ["Down"],
    ["Enter"],
    ["Enter"],
    ["Down"],
    ["Right"],
    ["Right"],
    ["Enter"],
    ["Down"],
    ["Enter"],
  ]);
});

void test("useItem reports the stuck item rows and keys to the error log", async () => {
  const pilot = new FakePilot();
  const menu = new FakeItemMenu({
    items: [
      { name: "恢复药", count: 2 },
      { name: "解毒药", count: 1 },
      { name: "眼药", count: 1 },
    ],
    members: PARTY,
    target: "蕾娜",
    targetStatus: "Blind",
    stuck: true,
  });
  menu.install(pilot);
  const reports: string[] = [];
  assert.deepEqual(await useItem(pilot, "眼药", "蕾娜", (message) => reports.push(message)), [
    false,
    "光标没能移到「眼药」",
  ]);
  const text = reports.join("\n");
  assert.match(text, /use_item 定位失败:目标「眼药」第 2 行/);
  assert.match(text, /listCursor=0/);
  assert.match(text, /focus=无/);
  assert.match(text, /键=Tab→Down→Enter×2→Down×3/);
  assert.match(text, /道具行 1:0:恢复药×2,1:解毒药×1,2:眼药×1/);
});

void test("useItem says the bag has no such item", async () => {
  const pilot = new FakePilot();
  const menu = new FakeItemMenu({
    items: [{ name: "恢复药", count: 1 }],
    members: PARTY,
    target: "蕾娜",
    targetStatus: "Blind",
  });
  menu.install(pilot);
  assert.deepEqual(await useItem(pilot, "眼药", "蕾娜"), [false, "包里没有「眼药」,有:恢复药"]);
  assert.deepEqual(pilot.keys(), []);
});

void test("useItem says the target is not in the party", async () => {
  const pilot = new FakePilot();
  const menu = new FakeItemMenu({
    items: [{ name: "眼药", count: 1 }],
    members: PARTY,
    target: "蕾娜",
    targetStatus: "Blind",
  });
  menu.install(pilot);
  assert.deepEqual(await useItem(pilot, "眼药", "加拉夫"), [
    false,
    "队伍里没有「加拉夫」,有:巴兹、蕾娜",
  ]);
  assert.deepEqual(pilot.keys(), []);
});

const JOBS = [
  { name: "无职", id: 0 },
  { name: "骑士", id: 1 },
  { name: "武僧", id: 2 },
  { name: "盗贼", id: 3 },
  { name: "白魔法师", id: 4 },
  { name: "黑魔法师", id: 5 },
  { name: "时魔法师", id: 6 },
  { name: "召唤师", id: 7 },
  { name: "龙骑士", id: 8 },
  { name: "忍者", id: 9, enabled: false },
  { name: "武士", id: 10 },
  { name: "猎人", id: 11 },
];
const JOB_MEMBERS = [
  { name: "巴兹", jobName: "骑士" },
  { name: "蕾娜", jobName: "白魔法师" },
  { name: "加拉夫", jobName: "武僧" },
];

function jobMenu(): FakeJobMenu {
  return new FakeJobMenu({ members: JOB_MEMBERS, jobs: JOBS, columns: 4 });
}

void test("changeJob changes a job and puts the strongest equipment back on", async () => {
  const pilot = new FakePilot();
  const menu = jobMenu();
  menu.install(pilot);
  assert.deepEqual(await changeJob(pilot, "巴兹", "时魔法师"), [
    true,
    "巴兹 换成了时魔法师,已重新装备最强",
  ]);
  assert.equal(menu.members[0]?.jobName, "时魔法师");
});

void test("changeJob walks to a job on another row of the grid", async () => {
  const pilot = new FakePilot();
  const menu = jobMenu();
  menu.install(pilot);
  assert.deepEqual(await changeJob(pilot, "蕾娜", "武士"), [
    true,
    "蕾娜 换成了武士,已重新装备最强",
  ]);
  assert.equal(menu.members[1]?.jobName, "武士");
});

void test("changeJob says the member already has that job", async () => {
  const pilot = new FakePilot();
  const menu = jobMenu();
  menu.install(pilot);
  assert.deepEqual(await changeJob(pilot, "巴兹", "骑士"), [false, "巴兹 已经是「骑士」了"]);
  assert.deepEqual(pilot.keys(), []);
});

void test("changeJob says a job is not unlocked yet", async () => {
  const pilot = new FakePilot();
  const menu = jobMenu();
  menu.install(pilot);
  assert.deepEqual(await changeJob(pilot, "巴兹", "忍者"), [false, "忍者 还没解锁"]);
  assert.equal(menu.members[0]?.jobName, "骑士");
});

void test("changeJob lists the jobs it can see when the name does not match", async () => {
  const pilot = new FakePilot();
  const menu = jobMenu();
  menu.install(pilot);
  const [ok, detail] = await changeJob(pilot, "巴兹", "洋葱剑士");
  assert.equal(ok, false);
  assert.match(detail, /没有「洋葱剑士」这个职业,有:无职、骑士/);
  assert.equal(menu.members[0]?.jobName, "骑士");
});
