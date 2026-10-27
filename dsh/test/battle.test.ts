import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptEntry } from "./fake-pilot.ts";
import { FakePilot, recordedCalls, scriptReplies } from "./fake-pilot.ts";
import { FakeItemMenu } from "./fake-item-menu.ts";
import {
  act,
  heldItems,
  judge,
  listOpen,
  patchUp,
  ready,
  situationOf,
  targetOpen,
} from "../src/engine/skills/battle.ts";
import * as gambit from "../src/engine/skills/gambit.ts";

interface Case {
  readonly name: string;
  readonly out: unknown;
  readonly calls: unknown[];
  readonly transcript: TranscriptEntry[];
}

interface MenuCase {
  readonly menu: Record<string, unknown>;
  readonly ready: boolean;
  readonly targetOpen: boolean;
  readonly listOpen: boolean;
}

interface Fixture {
  readonly cases: Case[];
  readonly menus: MenuCase[];
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "battle", "battle.json"), "utf8"),
) as Fixture;

const PARTY = [
  { name: "巴兹", hp: 8, maxHp: 197, mp: 19 },
  { name: "蕾娜", hp: 60, maxHp: 142, mp: 16 },
  { name: "加拉夫", hp: 0, maxHp: 215, mp: 19 },
  { name: "法利斯", hp: 140, maxHp: 140, mp: 2 },
];
const CRAB = [{ name: "龙虾", hp: 500, maxHp: 650, boss: 1 }];

const runners: Record<string, (pilot: FakePilot) => Promise<unknown>> = {
  "judge reads the party after a battle": async (pilot) => {
    const out: [string, string][] = [];
    for (let i = 0; i < 4; i++) out.push(await judge(pilot));
    return out;
  },
  "items ordered this battle count as used": async (pilot) => {
    const menu = { players: PARTY, enemies: CRAB };
    const limited = await situationOf(pilot, menu, "蕾娜", 1, { 恢复药: 3 }, { 恢复药: 2 });
    const plain = await situationOf(pilot, menu, "蕾娜", 2);
    return {
      limited: {
        actor: limited.actor,
        turn: limited.turn,
        boss: limited.boss,
        items: limited.items,
      },
      plain: { actor: plain.actor, turn: plain.turn, boss: plain.boss, items: plain.items },
      held: await heldItems(pilot),
    };
  },
  "older bridges read both sides from the sample": async (pilot) => {
    const situation = await situationOf(pilot, {}, "蕾娜", 1);
    return {
      players: situation.players,
      enemies: situation.enemies,
      boss: situation.boss,
    };
  },
};

void test("battle menu states decide which window has the keys", () => {
  for (const item of fixture.menus) {
    assert.equal(ready(item.menu), item.ready);
    assert.equal(targetOpen(item.menu), item.targetOpen);
    assert.equal(listOpen(item.menu), item.listOpen);
  }
});

for (const item of fixture.cases) {
  void test(item.name, async () => {
    const run = runners[item.name] ?? assert.fail(`no runner for ${item.name}`);
    const pilot = new FakePilot();
    scriptReplies(pilot, item.transcript);
    assert.deepEqual(await run(pilot), item.out);
    assert.deepEqual(recordedCalls(pilot), item.calls);
  });
}

void test("patchUp uses eye drops when no one can cast the cure", async () => {
  const pilot = new FakePilot();
  const menu = new FakeItemMenu({
    items: [{ name: "眼药", count: 2 }],
    members: [
      { name: "巴兹", hp: 100, maxHp: 100 },
      { name: "蕾娜", hp: 100, maxHp: 100, status: ["Blind"] },
    ],
    target: "蕾娜",
    targetStatus: "Blind",
  });
  menu.install(pilot);
  assert.deepEqual(await patchUp(pilot), ["给 蕾娜 用了「眼药」:黑暗 治好了"]);
});

void test("patchUp presses nothing when neither spell nor item cures", async () => {
  const pilot = new FakePilot();
  const menu = new FakeItemMenu({
    items: [],
    members: [{ name: "蕾娜", hp: 100, maxHp: 100, status: ["Blind"] }],
    target: "蕾娜",
  });
  menu.install(pilot);
  assert.deepEqual(await patchUp(pilot), []);
  assert.deepEqual(pilot.keys(), []);
});

void test("a battle rule missing its cure item says what it wanted", async () => {
  const pilot = new FakePilot();
  type Stage = "commands" | "items" | "target";
  let stage: Stage = "commands";
  let cursor = 1; // 道具
  const menu = (): Record<string, unknown> => ({
    actor: "蕾娜",
    commands: [{ name: "攻击" }, { name: "道具" }],
    cursor,
    menuState: "CommandSelecting",
    target: { state: stage === "target" ? "Enemys" : "None", cursor: 0 },
    itemState: stage === "items" ? "UseSelect" : "None",
    items: stage === "items" ? [{ name: "恢复药", count: 1 }] : null,
    itemCursor: 0,
  });
  pilot.onQuery("battlemenu", () => ({ battlemenu: menu() }));
  pilot.on("keys", (fields) => {
    const raw = fields.keys;
    const keys = Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === "string")
      : [];
    for (const spec of keys) {
      const [key = "", count] = spec.split("*");
      for (let i = 0; i < (count === undefined ? 1 : Number(count)); i++) {
        if (key === "Backspace") stage = "commands";
        else if (stage === "commands") {
          if (key === "Down") cursor = Math.min(1, cursor + 1);
          if (key === "Up") cursor = Math.max(0, cursor - 1);
          if (key === "Enter") stage = cursor === 1 ? "items" : "target";
        } else if (stage === "items" && key === "Enter") {
          stage = "target";
        } else if (stage === "target" && key === "Enter") {
          stage = "commands";
        }
      }
    }
    return { ok: true };
  });
  const situation = new gambit.Situation(
    "蕾娜",
    [{ name: "蕾娜", hp: 10, maxHp: 10, status: ["Blind"] }],
    [{ name: "哥布林", hp: 10, maxHp: 10 }],
  );
  const done = await act(
    pilot,
    menu(),
    [{ if: "ally.status.黑暗 >= 1", do: "道具:眼药", target: "状态:黑暗" }],
    situation,
  );
  assert.match(done, /想用「眼药」治黑暗,包里没有/);
});
