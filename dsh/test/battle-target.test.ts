import assert from "node:assert/strict";
import test from "node:test";
import type { ElementLearner, EnemyResistances } from "../src/engine/elements.ts";
import { isRecord, text } from "../src/engine/values.ts";
import { fight } from "../src/engine/skills/battle.ts";
import { FakePilot } from "./fake-pilot.ts";

interface Enemy {
  name: string;
  book: number;
  hp: number;
  maxHp: number;
}

const PARTY = [{ name: "法利斯", hp: 100, maxHp: 100, mp: 20, jobName: "黑魔法师" }];
const ABILITIES = [
  { id: 1, name: "火炎", mp: 4 },
  { id: 2, name: "冰结", mp: 4 },
  { id: 3, name: "闪雷", mp: 4 },
];

class TargetBattle {
  readonly pilot = new FakePilot();
  targetCursor = 0;
  abilityCursor = 0;
  lastAbility = "";
  private phase: "command" | "ability" | "target" = "command";
  private turns = 0;

  private readonly enemies: Enemy[];
  private readonly targetState: "Enemys" | "EnemyAll";

  constructor(enemies: Enemy[], targetState: "Enemys" | "EnemyAll" = "Enemys") {
    this.enemies = enemies;
    this.targetState = targetState;
    this.pilot.onQuery("battlemenu", () => ({ battlemenu: this.menu() }));
    this.pilot.onQuery("items", { items: { normal: [] } });
    this.pilot.on("keys", (fields) => {
      const raw = fields.keys;
      const keys = Array.isArray(raw)
        ? raw.filter((key): key is string => typeof key === "string")
        : [];
      for (const spec of keys) {
        const [key = "", count] = spec.split("*");
        for (let i = 0; i < (count === undefined ? 1 : Number(count)); i++) this.press(key);
      }
      return this.menu();
    });
  }

  private menu(): Record<string, unknown> {
    if (this.turns >= 1) return { battle: false };
    const common: Record<string, unknown> = {
      battle: true,
      menuState: "CommandSelecting",
      actor: "法利斯",
      commands: [
        { name: "黑魔法", enabled: true },
        { name: "攻击", enabled: true },
      ],
      cursor: 0,
      players: PARTY,
      enemies: this.enemies,
    };
    if (this.phase === "command") return common;
    common.abilityState = "AbilitySelecting";
    common.abilities = ABILITIES;
    common.shown = ABILITIES;
    common.abilityCursor = this.abilityCursor;
    if (this.phase === "target") {
      common.target = { state: this.targetState, cursor: this.targetCursor };
    }
    return common;
  }

  private press(key: string): void {
    if (this.phase === "command") {
      if (key === "Enter") this.phase = "ability";
    } else if (this.phase === "ability") {
      if (key === "Enter") this.phase = "target";
      else if (key === "Down" || key === "Right") {
        this.abilityCursor = Math.min(ABILITIES.length - 1, this.abilityCursor + 1);
      } else if (key === "Up" || key === "Left") {
        this.abilityCursor = Math.max(0, this.abilityCursor - 1);
      }
    } else if (key === "Enter") {
      const enemy = this.enemies.filter((item) => item.hp > 0)[this.targetCursor];
      this.lastAbility = ABILITIES[this.abilityCursor]?.name ?? "";
      if (enemy !== undefined) enemy.hp -= 10;
      this.turns += 1;
      this.phase = "command";
    } else if (this.targetState === "Enemys" && (key === "Down" || key === "Right")) {
      this.targetCursor = Math.min(
        this.enemies.filter((item) => item.hp > 0).length - 1,
        this.targetCursor + 1,
      );
    } else if (this.targetState === "Enemys" && (key === "Up" || key === "Left")) {
      this.targetCursor = Math.max(0, this.targetCursor - 1);
    }
  }
}

function elementsWith(...absorbing: string[]): ElementLearner {
  return {
    lookup: (enemy: unknown): EnemyResistances | null => {
      if (!isRecord(enemy)) return null;
      const name = text(enemy.name) ?? "";
      if (name === "冰吸收怪") return { weak: ["火"], absorb: ["冰"], immune: [] };
      if (absorbing.includes(name)) return { weak: [], absorb: ["火"], immune: [] };
      return { weak: [], absorb: [], immune: [] };
    },
    learnAbsorb: () => Promise.resolve(null),
  };
}

void test("an enemy-name target moves the cursor to that living enemy", async () => {
  const script = new TargetBattle([
    { name: "甲", book: 1, hp: 100, maxHp: 100 },
    { name: "乙", book: 2, hp: 100, maxHp: 100 },
    { name: "丙", book: 3, hp: 100, maxHp: 100 },
  ]);
  const result = await fight(
    script.pilot,
    { 法利斯: [{ do: "黑魔法:火炎", target: "敌人:丙" }] },
    30,
  );
  assert.equal(result.ok, true);
  assert.equal(script.targetCursor, 2);
  assert.deepEqual(result.turns, ["法利斯→黑魔法:火炎→丙"]);
});

void test("an all-enemy spell leaves the cursor alone", async () => {
  const script = new TargetBattle(
    [
      { name: "甲", book: 1, hp: 100, maxHp: 100 },
      { name: "乙", book: 2, hp: 100, maxHp: 100 },
    ],
    "EnemyAll",
  );
  const result = await fight(
    script.pilot,
    { 法利斯: [{ do: "黑魔法:火炎", target: "敌人:乙" }] },
    30,
  );
  assert.equal(result.ok, true);
  assert.equal(script.targetCursor, 0);
});

void test("最强 chooses the spell against the chosen enemy's resistance", async () => {
  const script = new TargetBattle([
    { name: "火吸收怪", book: 10, hp: 100, maxHp: 100 },
    { name: "冰吸收怪", book: 11, hp: 100, maxHp: 100 },
  ]);
  const result = await fight(
    script.pilot,
    { 法利斯: [{ do: "黑魔法:最强", target: "敌人:冰吸收怪" }] },
    30,
    () => undefined,
    elementsWith("火吸收怪"),
  );
  assert.equal(result.ok, true);
  assert.equal(script.lastAbility, "火炎");
  assert.deepEqual(result.turns, ["法利斯→黑魔法:火炎→冰吸收怪"]);
});
