import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Elements } from "../src/engine/elements.ts";
import { parse } from "../src/engine/guide/ludo.ts";
import type { Fields, Reply } from "../src/engine/pilot.ts";
import { fight } from "../src/engine/skills/battle.ts";
import { FakePilot } from "./fake-pilot.ts";

const PAGE = `<h1>Test</h1><div>Monsters in Test Area:</div>
<div>039 Defeater (Level 18, HP 260, Weak: Lightning)</div>`;

const PARTY = [
  { name: "法利斯", hp: 140, maxHp: 140, mp: 20, jobName: "黑魔法师" },
  { name: "巴兹", hp: 197, maxHp: 197, mp: 20, jobName: "黑魔法师" },
];
const ABILITIES = [
  { id: 1, name: "火炎", mp: 4 },
  { id: 2, name: "冰结", mp: 4 },
  { id: 3, name: "闪雷", mp: 4 },
];

/**
 * A one-enemy battle that only accepts the keys a rule table presses. The first ice spell
 * heals the enemy (it absorbs ice); the second turn should then pick thunder.
 */
class BattleScript {
  readonly pilot = new FakePilot();
  private actor = "法利斯";
  private phase: "command" | "ability" | "target" = "command";
  private commandCursor = 0;
  private abilityCursor = 0;
  private targetCursor = 0;
  private readonly enemies: Enemy[];
  private readonly effect: Effect;
  private readonly maxTurns: number;
  private turns = 0;

  constructor(
    maxTurns = 2,
    enemies: Enemy[] = [{ name: "败怨魔", book: 39, hp: 100, maxHp: 100 }],
    effect: Effect = iceHeals,
  ) {
    this.maxTurns = maxTurns;
    this.enemies = enemies;
    this.effect = effect;
    this.pilot.onQuery("battlemenu", () => ({ battlemenu: this.menu() }));
    this.pilot.onQuery("items", { items: { normal: [] } });
    this.pilot.on("keys", (fields) => this.press(fields));
  }

  private menu(): Reply {
    if (this.turns >= this.maxTurns) return { battle: false };
    const common: Reply = {
      battle: true,
      menuState: "CommandSelecting",
      actor: this.actor,
      commands: [
        { name: "黑魔法", enabled: true },
        { name: "攻击", enabled: true },
      ],
      cursor: this.commandCursor,
      players: PARTY,
      enemies: this.enemies,
    };
    if (this.phase === "command") return common;
    common.abilityState = "AbilitySelecting";
    common.abilities = ABILITIES;
    common.shown = ABILITIES;
    common.abilityCursor = this.abilityCursor;
    if (this.phase === "target") common.target = { state: "Enemys", cursor: this.targetCursor };
    return common;
  }

  private press(fields: Fields): Reply {
    const keys = Array.isArray(fields.keys) ? fields.keys : [];
    const key = String(keys[0] ?? "").split("*")[0] ?? "";
    if (key === "Enter") this.enter();
    else if (key === "Down" || key === "Right") this.move(1);
    else if (key === "Up" || key === "Left") this.move(-1);
    else if (key === "Backspace") this.phase = "command";
    return this.menu();
  }

  private enter(): void {
    if (this.phase === "command") {
      if (this.commandCursor === 0) {
        this.phase = "ability";
        this.abilityCursor = 0;
      } else {
        this.phase = "target";
        this.targetCursor = 0;
      }
    } else if (this.phase === "ability") {
      this.phase = "target";
      this.targetCursor = 0;
    } else {
      this.cast();
      this.turns += 1;
      this.phase = "command";
      this.actor = "巴兹";
    }
  }

  private move(step: number): void {
    if (this.phase === "command") {
      this.commandCursor = Math.max(0, Math.min(1, this.commandCursor + step));
    } else if (this.phase === "ability") {
      this.abilityCursor = Math.max(0, Math.min(ABILITIES.length - 1, this.abilityCursor + step));
    } else {
      this.targetCursor = Math.max(0, this.targetCursor + step);
    }
  }

  private cast(): void {
    const ability = ABILITIES[this.abilityCursor];
    // The target cursor counts living enemies, as in the game.
    const enemy = this.enemies.filter((e) => e.hp > 0)[this.targetCursor];
    if (enemy === undefined) return;
    if (this.commandCursor === 1) {
      enemy.hp -= 10;
      return;
    }
    if (ability === undefined) return;
    this.effect(ability.name, enemy, this.enemies);
  }
}

interface Enemy {
  name: string;
  book: number;
  hp: number;
  maxHp: number;
}

type Effect = (spell: string, target: Enemy, all: Enemy[]) => void;

/** The default script: the first ice hit is the absorb the first test is about. */
function iceHeals(spell: string, enemy: Enemy): void {
  if (spell === "冰结") enemy.hp += 20;
  else if (spell === "闪雷") enemy.hp -= 30;
  else enemy.hp -= 10;
}

void test("a battle learns an absorbed element and stops casting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-battle-elements-"));
  const path = join(directory, "elements-ff5.json");
  try {
    const elements = await Elements.load(
      path,
      [parse("test", PAGE)],
      undefined,
      new Map([[39, "Defeater"]]),
    );
    const script = new BattleScript();
    const result = await fight(
      script.pilot,
      {
        法利斯: [{ do: "黑魔法:冰结" }, { do: "黑魔法:最强" }],
        巴兹: [{ do: "黑魔法:最强" }],
      },
      30,
      () => undefined,
      elements,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.turns, ["法利斯→黑魔法:冰结", "巴兹→黑魔法:闪雷"]);
    assert.deepEqual(result.learned, ["败怨魔 吸收冰,以后不对它用冰"]);
    assert.deepEqual(elements.lookup({ book: 39 })?.absorb, ["冰"]);
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.ok(JSON.stringify(saved).includes("冰"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("when every attack element is absorbed the next rule attacks", async () => {
  const elements = Elements.fromChapters([parse("test", PAGE)]);
  for (const element of ["火", "冰", "雷"]) {
    await elements.learnAbsorb({ book: 39, name: "败怨魔" }, element);
  }
  const script = new BattleScript(1);
  const result = await fight(
    script.pilot,
    { 法利斯: [{ do: "黑魔法:最强" }, { do: "攻击" }] },
    30,
    () => undefined,
    elements,
  );
  assert.equal(result.ok, true);
  assert.equal(result.turns.length, 1);
  assert.match(result.turns[0] ?? "", /^法利斯→攻击\(跳过:黑魔法:最强 目标吸收/);
});

void test("a hard-coded spell is skipped when the target absorbs it", async () => {
  const elements = Elements.fromChapters([parse("test", PAGE)]);
  await elements.learnAbsorb({ book: 39, name: "败怨魔" }, "冰");
  const script = new BattleScript(1);
  const result = await fight(
    script.pilot,
    { 法利斯: [{ do: "黑魔法:冰结" }, { do: "攻击" }] },
    30,
    () => undefined,
    elements,
  );
  assert.equal(result.ok, true);
  assert.equal(result.turns[0], "法利斯→攻击(跳过:黑魔法:冰结 目标吸收冰,不放这个属性)");
});

void test("a target that dies while another of its kind lives teaches nothing", async () => {
  // 10-27: a Motor Trap died to Thunder, the next Motor Trap with full HP was compared with
  // it, and "陷阱机器人 吸收雷" was learned.
  const elements = Elements.fromChapters([]);
  const traps = [
    { name: "陷阱机器人", book: 40, hp: 30, maxHp: 240 },
    { name: "陷阱机器人", book: 40, hp: 240, maxHp: 240 },
  ];
  const script = new BattleScript(2, traps, (spell, target) => {
    if (spell === "闪雷") target.hp = 0;
  });
  const result = await fight(
    script.pilot,
    { 法利斯: [{ do: "黑魔法:闪雷" }], 巴兹: [{ do: "攻击" }] },
    30,
    () => undefined,
    elements,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.learned, []);
  assert.equal(elements.lookup({ book: 40 })?.absorb.includes("雷") ?? false, false);
});

void test("an HP rise the guide contradicts is not learned as an absorb", async () => {
  // The guide says the Defeater is weak to lightning: a rise after Thunder is a mix-up.
  const elements = Elements.fromChapters([parse("test", PAGE)]);
  const script = new BattleScript(
    2,
    [{ name: "败怨魔", book: 39, hp: 100, maxHp: 260 }],
    (spell, target) => {
      if (spell === "闪雷") target.hp += 20;
    },
  );
  const result = await fight(
    script.pilot,
    { 法利斯: [{ do: "黑魔法:闪雷" }], 巴兹: [{ do: "攻击" }] },
    30,
    () => undefined,
    elements,
  );
  assert.deepEqual(result.learned, []);
  assert.deepEqual(elements.lookup({ book: 39 })?.absorb, []);
});
