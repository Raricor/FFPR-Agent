import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TacticianPlan } from "../src/engine/facts.ts";
import { Game } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import { num, text, type Json } from "../src/engine/values.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = {
  host: "laptop",
  user: "player",
  key: "/tmp/key",
  root: "C:/ffpr",
};
const DIALOG = "如果在合并翅膀的时候进行攻击,可是会遭到利爪的反击哦!!";
const PARTY: readonly Json[] = [
  {
    name: "巴兹",
    jobName: "骑士",
    lv: 10,
    hp: 200,
    maxHp: 200,
    mp: 20,
    maxMp: 20,
  },
  {
    name: "蕾娜",
    jobName: "白魔法师",
    lv: 10,
    hp: 180,
    maxHp: 180,
    mp: 30,
    maxMp: 30,
  },
];
const WINGS: readonly Json[] = [
  { name: "巨翼猛禽", book: 229, id: 281, hp: 500, maxHp: 500, boss: true },
];

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface SimOptions {
  readonly damages: boolean;
  /** Change the enemy's id to the next value after each attack (281 → 282 → 283 ...). */
  readonly forms: boolean;
  readonly maxTurns: number;
  /** The party wipes: the menu shows everyone down until a confirm leaves the battle. */
  readonly wiped?: boolean;
  readonly onGuard?: (guards: number, sim: BossBattle) => void;
  readonly onAttack?: (attacks: number, sim: BossBattle) => void;
}

/** A battle whose command list and turns are enough for fight() to drive it. */
class BossBattle {
  readonly pilot = new FakePilot();
  readonly enemies: Json[] = WINGS.map((enemy) => ({ ...enemy }));
  readonly party: readonly Json[] = PARTY.map((member) => ({ ...member }));
  readonly actions: string[] = [];
  readonly dialog: string[] = [];
  private readonly options: SimOptions;
  private actor = 0;
  private waits = 0;
  private defending = false;
  private target = false;
  private turns = 0;
  private guards = 0;
  private attacks = 0;
  private form = 0;
  private left = false;

  constructor(options: SimOptions) {
    this.options = options;
    this.pilot.on("pos", () => ({
      pos: this.left
        ? { state: "Player", battle: false, map: 30, cell: [38, 13] }
        : { state: "Battle", battle: true, map: 30, cell: [1, 2] },
    }));
    this.pilot.on("keys", (fields) => this.keys(fields));
    this.pilot.on("wait", { ok: true });
    this.pilot.on("entities", { entities: { total: 0, entities: [] } });
    this.pilot.onQuery("items", {
      items: {
        normal: [
          { name: "恢复药", count: 2 },
          { name: "不死鸟之尾", count: 2 },
        ],
        important: [],
      },
    });
    this.pilot.onQuery("battlemenu", () => ({ battlemenu: this.menu() }));
    this.pilot.onQuery("sample", () => ({ sample: this.sample() }));
  }

  setForm(id: number): void {
    const enemy = this.enemies[0];
    if (enemy !== undefined) enemy.id = id;
  }

  /** Drop one member to `hp`, for the "party lost over half in one round" trigger (task 41). */
  setHp(index: number, hp: number): void {
    const member = this.party[index];
    if (member !== undefined) member.hp = hp;
  }

  private copy(rows: readonly Json[]): Json[] {
    return rows.map((row) => ({ ...row }));
  }

  private sample(): Json {
    return {
      user: { mapId: 30, areaText: "风之神殿" },
      scene: { state: this.left ? "Player" : "Battle" },
      party: this.copy(this.party),
      battle: {
        active: !this.left,
        boss: true,
        enemies: this.copy(this.enemies),
        players: this.copy(this.party),
      },
      dialog: { open: false, lines: [...this.dialog] },
    };
  }

  private menu(): Json {
    if (this.options.wiped === true) {
      if (this.left) return { battle: false };
      return {
        battle: true,
        menuState: "Waiting",
        actor: null,
        target: { state: "None" },
        players: this.copy(this.party).map((member) => ({
          ...member,
          hp: 0,
          status: ["UnableFight"],
        })),
        enemies: this.copy(this.enemies),
      };
    }
    const living = this.enemies.filter((enemy) => (num(enemy.hp) ?? 0) > 0);
    if (this.turns >= this.options.maxTurns || living.length === 0) return { battle: false };
    if (this.waits > 0) {
      this.waits -= 1;
      return {
        battle: true,
        menuState: "Waiting",
        actor: null,
        target: { state: "None" },
        players: this.copy(this.party),
        enemies: this.copy(this.enemies),
      };
    }
    const actor = text(this.party[this.actor]?.name) ?? "";
    return {
      battle: true,
      menuState: "CommandSelecting",
      commandState: this.defending ? "Defence" : "Command",
      actor,
      commands: this.defending
        ? [{ name: "防御", enabled: true }]
        : [
            { name: "攻击", enabled: true },
            { name: "道具", enabled: true },
          ],
      cursor: 0,
      target: { state: this.target ? "Enemys" : "None", cursor: 0 },
      players: this.copy(this.party),
      enemies: this.copy(this.enemies),
    };
  }

  private keys(fields: Json): Json {
    const raw = fields.keys;
    const keys = Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === "string")
      : [];
    for (const key of keys) {
      if (this.options.wiped === true) {
        if (key === "Enter") this.left = true;
        continue;
      }
      if (this.target) {
        if (key === "Enter") {
          this.hit();
          this.finish("攻击");
        }
        continue;
      }
      if (key === "Right" && !this.defending) {
        this.defending = true;
        continue;
      }
      if (key === "Enter") {
        if (this.defending) this.finish("防御");
        else this.target = true;
      }
    }
    return this.menu();
  }

  private hit(): void {
    const enemy = this.enemies.find((row) => (num(row.hp) ?? 0) > 0);
    if (enemy === undefined) return;
    this.target = false;
    this.attacks += 1;
    if (this.options.damages) {
      const hp = num(enemy.hp) ?? 0;
      enemy.hp = Math.max(0, hp - 10);
    }
    if (this.options.forms) {
      this.form += 1;
      this.setForm(281 + this.form);
    }
    this.options.onAttack?.(this.attacks, this);
  }

  private finish(done: string): void {
    const actor = text(this.party[this.actor]?.name) ?? "";
    this.actions.push(`${actor}→${done}`);
    this.turns += 1;
    if (done === "防御") {
      this.guards += 1;
      this.options.onGuard?.(this.guards, this);
    }
    this.defending = false;
    this.target = false;
    this.waits = 2;
    this.actor = (this.actor + 1) % this.party.length;
  }
}

interface Harness {
  readonly game: Game;
  readonly battle: BossBattle;
  readonly facts: string[];
  readonly calls: () => number;
  readonly close: () => Promise<void>;
}

async function harness(
  options: SimOptions,
  plan: (call: number) => TacticianPlan | Promise<TacticianPlan>,
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-boss-"));
  const facts: string[] = [];
  let calls = 0;
  const game = await Game.create({
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    atlasFile: join(directory, "atlas.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    tacticianBoss: true,
    tactician: (fact) => {
      const call = calls;
      calls += 1;
      facts.push(fact);
      return Promise.resolve(plan(call));
    },
  });
  const battle = new BossBattle(options);
  return {
    game,
    battle,
    facts,
    calls: () => calls,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

const ATTACK: TacticianPlan = {
  tables: [{ 巴兹: [{ do: "攻击" }], 蕾娜: [{ do: "攻击" }] }],
  walkerNotes: "先打",
  askUp: "",
};

const GUARD: TacticianPlan = {
  tables: [{ 巴兹: [{ do: "防御" }], 蕾娜: [{ do: "防御" }] }],
  walkerNotes: "先防",
  askUp: "",
};

const FORM_TABLE: TacticianPlan = {
  tables: [
    {
      巴兹: [{ if: "enemy.id.282 >= 1", do: "防御" }, { do: "攻击" }],
      蕾娜: [{ if: "enemy.id.282 >= 1", do: "防御" }, { do: "攻击" }],
    },
  ],
  walkerNotes: "合翅膀就防御",
  askUp: "",
};

void test("a boss form change rewrites the table; waiting turns defend and the new table uses ids", async () => {
  const rewrite = deferred<TacticianPlan>();
  const h = await harness(
    {
      damages: true,
      forms: false,
      maxTurns: 9,
      onAttack: (attacks, battle) => {
        if (attacks === 1) battle.setForm(282);
      },
      onGuard: (guards, battle) => {
        if (guards === 3) rewrite.resolve(FORM_TABLE);
        if (guards === 4) battle.setForm(281);
      },
    },
    (call) => (call === 0 ? ATTACK : rewrite.promise),
  );
  h.battle.dialog.push(DIALOG);
  try {
    const result = await h.game.settle(h.battle.pilot);
    assert.equal(h.calls(), 2);
    assert.match(h.facts[1] ?? "", /### 战斗到现在/);
    assert.match(h.facts[1] ?? "", /编号 282/);
    assert.match(h.facts[1] ?? "", /敌人变了编号/);
    assert.match(h.facts[1] ?? "", /如果在合并翅膀的时候进行攻击/);
    assert.match(result, /中途重新写表 2 次/);
    assert.match(result, /成功/);
    assert.match(result, /新表:巴兹:enemy\.id\.282 >= 1 防御\/攻击、蕾娜:/);
    const plan = h.game.lastBossPlan();
    assert.ok(plan);
    const rewrites = plan.rewrites ?? [];
    assert.equal(rewrites.length, 2);
    const opening = rewrites[0];
    assert.ok(opening);
    assert.match(opening.reason, /开打时还没有首领表/);
    assert.equal(opening.ok, true);
    const first = rewrites[1];
    assert.ok(first);
    assert.equal(first.ok, true);
    assert.match(plan.result, /中途重新写表 2 次/);
    assert.deepEqual(plan.table, FORM_TABLE.tables[0]);
    // 281 → 282 is the form change; the next three turns wait and defend.
    assert.match(h.battle.actions[0] ?? "", /攻击/);
    for (const action of h.battle.actions.slice(1, 4)) assert.match(action, /防御/);
    // The new table defends at 282; after the form returns to 281 it attacks.
    assert.match(h.battle.actions[4] ?? "", /防御/);
    assert.match(h.battle.actions[5] ?? "", /攻击/);
    assert.equal(h.battle.enemies[0]?.id, 281);
  } finally {
    await h.close();
  }
});

void test("three attacks with no HP loss rewrite the table", async () => {
  const h = await harness({ damages: false, forms: false, maxTurns: 10 }, () => ATTACK);
  h.battle.setForm(282);
  try {
    const result = await h.game.settle(h.battle.pilot);
    assert.equal(h.calls(), 3);
    assert.match(h.facts[1] ?? "", /连续 3 次攻击,首领的 HP 都没有减少/);
    assert.match(result, /中途重新写表 3 次/);
    const plan = h.game.lastBossPlan();
    assert.ok(plan);
    const rewrites = plan.rewrites ?? [];
    assert.equal(rewrites.length, 3);
    const first = rewrites[1];
    assert.ok(first);
    assert.match(first.reason, /连续 3 次攻击/);
    assert.equal(first.ok, true);
  } finally {
    await h.close();
  }
});

void test("the opening table does not use up the two mid-battle rewrites", async () => {
  const h = await harness({ damages: true, forms: true, maxTurns: 12 }, () => ATTACK);
  try {
    const result = await h.game.settle(h.battle.pilot);
    assert.equal(h.calls(), 3);
    assert.match(result, /中途重新写表 3 次/);
    const plan = h.game.lastBossPlan();
    assert.ok(plan);
    const rewrites = plan.rewrites ?? [];
    assert.equal(rewrites.length, 3);
    assert.match(rewrites[0]?.reason ?? "", /开打时还没有首领表/);
    const first = rewrites[1];
    const second = rewrites[2];
    assert.ok(first);
    assert.ok(second);
    assert.match(first.reason, /编号 282/);
    assert.match(second.reason, /编号 283/);
  } finally {
    await h.close();
  }
});

void test("a tactician failure returns to the old table and says why", async () => {
  const rewrite = deferred<TacticianPlan>();
  const h = await harness(
    {
      damages: true,
      forms: false,
      maxTurns: 9,
      onAttack: (attacks, battle) => {
        if (attacks === 1) battle.setForm(282);
      },
      onGuard: (guards) => {
        if (guards === 2) rewrite.reject(new Error("战术官超时"));
      },
    },
    (call) => (call === 0 ? ATTACK : rewrite.promise),
  );
  h.battle.setForm(281);
  try {
    const result = await h.game.settle(h.battle.pilot);
    assert.equal(h.calls(), 2);
    assert.match(result, /战术官没有回答:战术官超时/);
    assert.match(result, /没有换成/);
    const plan = h.game.lastBossPlan();
    assert.ok(plan);
    const rewrites = plan.rewrites ?? [];
    assert.equal(rewrites.length, 2);
    const first = rewrites[1];
    assert.ok(first);
    assert.equal(first.ok, false);
    // The old table is back: the turns after the two waiting defends attack again.
    assert.match(h.battle.actions[1] ?? "", /防御/);
    assert.match(h.battle.actions[2] ?? "", /防御/);
    assert.match(h.battle.actions[3] ?? "", /攻击/);
  } finally {
    await h.close();
  }
});

void test("a boss battle wipe says 首领战全灭 and records where the game put the party", async () => {
  const h = await harness({ damages: true, forms: false, maxTurns: 5, wiped: true }, () => ATTACK);
  try {
    const result = await h.game.settle(h.battle.pilot);
    assert.match(result, /首领战全灭/);
    assert.doesNotMatch(result, /战斗没打完/);
    assert.match(result, /游戏把队伍放回了地图 30 的 \(38,13\)/);
    const plan = h.game.lastBossPlan();
    assert.ok(plan);
    assert.match(plan.result, /首领战全灭/);
    assert.match(plan.result, /地图 30 的 \(38,13\)/);
  } finally {
    await h.close();
  }
});

void test("an enemy's first skill the table never mentions asks for a rewrite", async () => {
  const rewrite = deferred<TacticianPlan>();
  let h: Harness | null = null;
  h = await harness(
    {
      damages: true,
      forms: false,
      maxTurns: 8,
      onAttack: (attacks) => {
        if (attacks !== 1 || h === null) return;
        h.game.battles.noteEvent(
          {
            type: "battle.act",
            actor: { name: "巨翼猛禽" },
            command: { name: "攻击" },
            abilities: [{ name: "翼" }],
            targets: [{ name: "巴兹" }],
            counter: false,
          },
          h.battle.pilot.now(),
        );
      },
      onGuard: (guards) => {
        if (guards === 1) rewrite.resolve(ATTACK);
      },
    },
    (call) => (call === 0 ? ATTACK : rewrite.promise),
  );
  try {
    const result = await h.game.settle(h.battle.pilot);
    assert.equal(h.calls(), 2);
    assert.match(h.facts[1] ?? "", /没提到的招式「翼」/);
    assert.match(result, /中途重新写表 2 次/);
  } finally {
    await h.close();
  }
});

void test("losing over half the party HP in one round asks for a rewrite", async () => {
  const rewrite = deferred<TacticianPlan>();
  const h = await harness(
    {
      damages: true,
      forms: false,
      maxTurns: 8,
      onAttack: (attacks, battle) => {
        if (attacks !== 1) return;
        battle.setHp(0, 0);
        battle.setHp(1, 100);
      },
      onGuard: (guards) => {
        if (guards === 1) rewrite.resolve(ATTACK);
      },
    },
    (call) => (call === 0 ? ATTACK : rewrite.promise),
  );
  try {
    const result = await h.game.settle(h.battle.pilot);
    assert.equal(h.calls(), 2);
    assert.match(h.facts[1] ?? "", /掉了超过一半的 HP/);
    assert.match(result, /中途重新写表 2 次/);
  } finally {
    await h.close();
  }
});

void test("a boss battle starts before the tactician answers and uses its table from the next turn", async () => {
  const rewrite = deferred<TacticianPlan>();
  const h = await harness(
    {
      damages: true,
      forms: false,
      maxTurns: 20,
      onAttack: (attacks, battle) => {
        if (attacks !== 2) return;
        // The tactician took three seconds; the first two turns were already chosen.
        battle.pilot.advance(3000);
        rewrite.resolve(GUARD);
      },
    },
    () => rewrite.promise,
  );
  await h.game.tactics.set(30, [ATTACK.tables[0] ?? {}], ["哥布林"]);
  // Give the background tactician a real turn between battle turns; the fake clock alone
  // would let fight() run every turn before the rewrite chain leaves the microtask queue.
  const query = h.battle.pilot.query.bind(h.battle.pilot);
  h.battle.pilot.query = async (q, fields) => {
    if (q === "battlemenu") await new Promise((resolve) => setTimeout(resolve, 1));
    return query(q, fields);
  };
  try {
    const result = await h.game.settle(h.battle.pilot);
    assert.equal(h.calls(), 1);
    assert.match(result, /开打时用的是本图的普通战斗表/);
    assert.match(result, /开打时还没有首领表,战术官写好后换上/);
    const switched = /第 (\d+) 回合换上/.exec(result);
    assert.ok(switched);
    const turn = Number(switched[1] ?? "");
    assert.ok(turn >= 2);
    // Every turn before the switch used the regular table; every turn after it used the new
    // boss table. Only the first table read happens after the tactician answered.
    for (let index = 0; index < turn - 1; index++) {
      assert.match(h.battle.actions[index] ?? "", /攻击/);
    }
    for (let index = turn - 1; index < h.battle.actions.length; index++) {
      assert.match(h.battle.actions[index] ?? "", /防御/);
    }
    const plan = h.game.lastBossPlan();
    assert.ok(plan);
    assert.deepEqual(plan.table, GUARD.tables[0]);
    const rewrites = plan.rewrites ?? [];
    assert.equal(rewrites.length, 1);
    const opening = rewrites[0];
    assert.ok(opening);
    assert.match(opening.reason, /开打时还没有首领表/);
    assert.equal(opening.ok, true);
    assert.match(opening.summary, /第 \d+ 回合换上/);
  } finally {
    await h.close();
  }
});

void test("a boss battle won before the opening table arrives keeps that table for the map", async () => {
  const rewrite = deferred<TacticianPlan>();
  const h = await harness(
    {
      damages: true,
      forms: false,
      maxTurns: 4,
      onAttack: (attacks) => {
        if (attacks === 1)
          setTimeout(() => {
            rewrite.resolve(GUARD);
          }, 0);
      },
    },
    () => rewrite.promise,
  );
  const enemy = h.battle.enemies[0];
  if (enemy === undefined) throw new Error("假首领不见了");
  enemy.hp = 10;
  try {
    const result = await h.game.settle(h.battle.pilot);
    assert.equal(h.calls(), 1);
    assert.match(result, /开打时没有现成的表,全员普通攻击/);
    assert.match(result, /战斗结束/);
    assert.match(result, /战斗已经结束,存成这张图的首领表/);
    const boss = h.game.tactics.boss(30);
    assert.ok(boss);
    assert.deepEqual(boss.table, GUARD.tables[0]);
    assert.equal(boss.prepared, undefined);
  } finally {
    await h.close();
  }
});

void test("a boss battle without a prepared table starts on the map's last boss table", async () => {
  const rewrite = deferred<TacticianPlan>();
  const h = await harness(
    {
      damages: true,
      forms: false,
      maxTurns: 4,
      onGuard: (guards) => {
        if (guards === 1)
          setTimeout(() => {
            rewrite.resolve(ATTACK);
          }, 0);
      },
    },
    () => rewrite.promise,
  );
  const old = GUARD.tables[0];
  assert.ok(old);
  await h.game.tactics.setBoss(30, {
    table: old,
    result: "上一次的首领战",
    at: new Date().toISOString(),
  });
  try {
    const result = await h.game.settle(h.battle.pilot);
    assert.equal(h.calls(), 1);
    assert.match(result, /开打时用的是这张图上次的首领表/);
    assert.match(h.battle.actions[0] ?? "", /防御/);
    assert.match(result, /战斗已经结束,存成这张图的首领表/);
    const boss = h.game.tactics.boss(30);
    assert.ok(boss);
    assert.deepEqual(boss.table, ATTACK.tables[0]);
  } finally {
    await h.close();
  }
});

void test("a prepared boss table is used without calling the tactician", async () => {
  const h = await harness({ damages: true, forms: false, maxTurns: 3 }, () => {
    throw new Error("有 prepared 的表时不该叫战术官");
  });
  const table = GUARD.tables[0];
  assert.ok(table);
  await h.game.tactics.setBoss(30, {
    table,
    result: "首领战前准备",
    at: new Date().toISOString(),
    prepared: true,
  });
  try {
    const result = await h.game.settle(h.battle.pilot);
    assert.equal(h.calls(), 0);
    assert.match(result, /用首领战前写好的表/);
    assert.match(h.battle.actions[0] ?? "", /防御/);
    const plan = h.game.lastBossPlan();
    assert.ok(plan);
    assert.equal((plan.rewrites ?? []).length, 0);
  } finally {
    await h.close();
  }
});
