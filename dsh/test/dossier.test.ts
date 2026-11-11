import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BattleRecord } from "../src/engine/battle-record.ts";
import type { ElementKnowledge } from "../src/engine/elements.ts";
import type { Guide } from "../src/engine/guide/kb.ts";
import type { MonsterInfo } from "../src/engine/bestiary.ts";
import {
  MonsterAiCache,
  monsterDossierLines,
  monsterStatuses,
  readBag,
  readParty,
} from "../src/engine/dossier.ts";
import { FakePilot } from "./fake-pilot.ts";

const WINGS: MonsterInfo = {
  number: 229,
  monster: 123,
  name: "巨翼猛禽",
  lv: 5,
  hp: 500,
  mp: 0,
  exp: 0,
  gil: 0,
  boss: true,
  species: null,
  resistanceAttribute: null,
  resistanceCondition: null,
  attributes: [
    { id: 2, name: "对冰属性抵抗力低", type: 1 },
    { id: 5, name: null, type: 4 },
  ],
  conditions: ["毒"],
  drops: [],
  steals: [],
};

const ELEMENTS: ElementKnowledge = {
  lookup: () => ({ weak: ["冰"], absorb: ["风"], immune: [] }),
};

const GUIDE = {
  monsterNote: () => "合翅膀的时候攻击会遭到利爪的反击;它的爪子带毒。",
} as unknown as Guide;

const RECORD = {
  kind: "boss",
  result: "wipe",
  detail: "首领战全灭",
  enemies: [{ name: "巨翼猛禽", id: 282, book: 229 }],
  turns: [
    {
      rule: 1,
      skipped: [{ rule: 2, why: "没有这个指令" }],
      changes: [
        { side: "party", name: "蕾娜", hp: { from: 100, to: 0 } },
        { side: "enemy", name: "巨翼猛禽", hp: { from: 500, to: 450 } },
      ],
    },
  ],
  events: [
    {
      kind: "battle.act",
      actor: "巨翼猛禽",
      action: "利爪",
      counter: true,
      detail: "",
    },
    {
      kind: "battle.act",
      actor: "巨翼猛禽",
      action: "风之刃",
      counter: false,
      detail: "",
    },
  ],
  summary: {
    gaps: [{ item: "不死鸟之尾", held: 0, basis: "规则 2", skips: 2 }],
  },
} as unknown as BattleRecord;

async function cacheWithWings(): Promise<MonsterAiCache> {
  const cache = await MonsterAiCache.load("ff5");
  const pilot = new FakePilot();
  pilot.onQuery("monsterai", {
    monsterai: [
      {
        monster: 123,
        name: "巨翼猛禽",
        scriptName: "sc_ai_123",
        script: '{"Mnemonics":[{"mnemonic":"CounterAct"}]}',
        abilities: [
          { id: 1, name: "合翅膀", opcode: "Act", rate: 65, table: 0 },
          { id: 2, name: "利爪", opcode: "Act", rate: 35, table: 0 },
        ],
      },
    ],
  });
  await cache.ensure(pilot, [123]);
  return cache;
}

void test("a monster's dossier lists its script, seen moves, counter, form, guide and last fight", async () => {
  const cache = await cacheWithWings();
  const lines = monsterDossierLines({
    monsters: [{ name: "巨翼猛禽", book: 229, id: 281, maxHp: 500, info: WINGS }],
    ai: cache,
    elements: ELEMENTS,
    guide: GUIDE,
    records: [RECORD],
  }).join("\n");
  assert.match(lines, /- 巨翼猛禽\(编号 281\) 图鉴 #229 HP 500 弱 冰;吸收 风/);
  assert.match(lines, /会用的招\(AI 脚本\):第 0 组:合翅膀\(65%\)、利爪\(35%\)/);
  assert.match(lines, /实战见过:风之刃/);
  assert.match(lines, /反击:有/);
  assert.match(lines, /变身:编号 281 → 282/);
  assert.match(lines, /攻略:合翅膀的时候攻击会遭到利爪的反击/);
  assert.match(lines, /上次和它打:首领战:全灭\(首领战全灭\)/);
  assert.match(lines, /缺口:不死鸟之尾 0 个/);
  assert.match(lines, /它用过:利爪\(反击\)、风之刃/);
  assert.match(lines, /先倒:蕾娜/);
  assert.deepEqual(
    monsterStatuses({
      monsters: [{ name: "巨翼猛禽", book: 229, id: 281, maxHp: 500, info: WINGS }],
      ai: cache,
      elements: ELEMENTS,
      guide: GUIDE,
      records: [RECORD],
    }),
    ["毒"],
  );
});

void test("the AI cache saves, reloads and also keeps battle.ai pushes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-ai-"));
  const path = join(directory, "monsterai-ff5.json");
  try {
    const cache = await MonsterAiCache.load("ff5", path);
    const pilot = new FakePilot();
    pilot.onQuery("monsterai", {
      monsterai: [
        {
          monster: 123,
          name: "巨翼猛禽",
          scriptId: 7,
          source: "cache",
          script: '{"Mnemonics":[]}',
          abilities: [{ id: 1, name: "合翅膀", opcode: "Act", rate: 100, table: 0 }],
        },
      ],
    });
    await cache.ensure(pilot, [123]);
    cache.recordEvent({
      type: "battle.ai",
      monster: 124,
      scriptId: 8,
      scriptName: "sc_ai_124",
    });
    await cache.save();
    const reloaded = await MonsterAiCache.load("ff5", path);
    assert.equal(reloaded.entry(123)?.name, "巨翼猛禽");
    assert.equal(reloaded.entry(123)?.abilities[0]?.rate, 100);
    assert.equal(reloaded.entry(124)?.scriptId, 8);
    assert.equal(reloaded.entry(124)?.event, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("party commands and the bag are read from the same sample the fact sheet uses", () => {
  const party = readParty({
    party: [
      {
        name: "蕾娜",
        jobName: "白魔法师",
        lv: 17,
        hp: 300,
        maxHp: 400,
        mp: 90,
        maxMp: 120,
        abilities: [{ name: "<IC_WMGC>治疗", type: 1, mp: 4 }],
        equipment: { slots: [{ item: "白袍" }] },
      },
    ],
  });
  const first = party[0];
  assert.ok(first);
  assert.deepEqual(first.commands, ["攻击", "防御", "道具", "白魔法"]);
  assert.deepEqual(first.equipment, ["白袍"]);
  const bag = readBag({ 恢复药: 3, 不死鸟之尾: 2, 眼药: 1 });
  assert.equal(bag.count("不死鸟之尾"), 2);
  assert.equal(bag.revive.length, 1);
  assert.equal(bag.heal.length, 1);
  assert.equal(bag.cures.length, 1);
});
