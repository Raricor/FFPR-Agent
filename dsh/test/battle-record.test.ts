import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BattleLog } from "../src/engine/battle-record.ts";
import { fight, judgePlayers } from "../src/engine/skills/battle.ts";
import type { Json } from "../src/engine/values.ts";
import { FakePilot } from "./fake-pilot.ts";

const PARTY: readonly Json[] = [
  { name: "巴兹", hp: 50, maxHp: 100, mp: 10 },
  { name: "蕾娜", hp: 80, maxHp: 100, mp: 20 },
];
const GOBLIN: readonly Json[] = [{ name: "哥布林", id: 1, hp: 100, maxHp: 100 }];

/** A two-turn battle: everyone attacks, the goblin loses 10 HP, the actor loses 2. */
class TwoTurnBattle {
  readonly pilot = new FakePilot();
  readonly enemies: Json[] = GOBLIN.map((enemy) => ({ ...enemy }));
  readonly party: Json[] = PARTY.map((member) => ({ ...member }));
  private actor = 0;
  private stage: "command" | "target" = "command";
  private waits = 0;
  private turns = 0;
  private closing = false;
  private closingReads = 0;
  private left = false;

  constructor() {
    this.pilot.on("keys", (fields) => this.keys(fields.keys));
    this.pilot.onQuery("battlemenu", () => ({ battlemenu: this.menu() }));
    this.pilot.onQuery("items", { items: { normal: [] } });
  }

  private copy(rows: readonly Json[]): Json[] {
    return rows.map((row) => ({ ...row }));
  }

  private waiting(): Json {
    return {
      battle: true,
      menuState: "Waiting",
      actor: null,
      target: { state: "None" },
      players: this.copy(this.party),
      enemies: this.copy(this.enemies),
    };
  }

  private menu(): Json {
    if (this.left) return { battle: false };
    if (this.waits > 0) {
      this.waits -= 1;
      return this.waiting();
    }
    if (this.closing) {
      // The turn's after-reading (and the wait before it) still see the last HP; only the
      // next loop's reading sees the battle gone.
      if (this.closingReads >= 2) {
        this.left = true;
        return { battle: false };
      }
      this.closingReads += 1;
      return this.waiting();
    }
    const actor = this.party[this.actor]?.name;
    return {
      battle: true,
      menuState: "CommandSelecting",
      actor,
      commands: [{ name: "攻击", enabled: true }],
      cursor: 0,
      target: { state: this.stage === "target" ? "Enemys" : "None", cursor: 0 },
      players: this.copy(this.party),
      enemies: this.copy(this.enemies),
    };
  }

  private keys(raw: unknown): Json {
    const keys = Array.isArray(raw) ? raw.filter((key) => typeof key === "string") : [];
    for (const key of keys) {
      if (this.stage === "command" && key === "Enter") {
        this.stage = "target";
      } else if (this.stage === "target" && key === "Enter") {
        this.hit();
      }
    }
    return { ok: true };
  }

  private hit(): void {
    const enemy = this.enemies.find((row) => (Number(row.hp) || 0) > 0);
    if (enemy !== undefined) enemy.hp = Math.max(0, (Number(enemy.hp) || 0) - 10);
    const actor = this.party[this.actor];
    if (actor !== undefined) actor.hp = Math.max(0, (Number(actor.hp) || 0) - 2);
    this.stage = "command";
    this.turns += 1;
    this.waits = 1;
    if (this.turns >= 2) this.closing = true;
    this.actor = (this.actor + 1) % this.party.length;
  }
}

void test("a fight records every turn, the skipped rule and the HP changes into one JSON line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-battles-"));
  const path = join(directory, "battles-ff5.jsonl");
  try {
    const log = await BattleLog.load("ff5", path);
    const sim = new TwoTurnBattle();
    const session = log.start({
      mapId: 229,
      mapName: "北山",
      boss: false,
      enemies: [
        {
          name: "哥布林",
          id: 1,
          maxHp: 100,
          hp: 100,
          mp: null,
          status: [],
          boss: false,
        },
      ],
      party: [
        {
          name: "巴兹",
          id: null,
          maxHp: 100,
          hp: 50,
          mp: 10,
          status: [],
          boss: false,
        },
        {
          name: "蕾娜",
          id: null,
          maxHp: 100,
          hp: 80,
          mp: 20,
          status: [],
          boss: false,
        },
      ],
      table: { kind: "map", mapId: 229, table: 2 },
      startedAt: "2026-11-03T10:00:00.000Z",
      startedMs: sim.pilot.now(),
    });
    const plan = {
      巴兹: [{ if: "ally.hp_pct < 90", do: "黑魔法:火炎" }, { do: "攻击" }],
      蕾娜: [{ if: "enemy.hp_pct < 100", do: "攻击" }, { do: "防御" }],
    };
    const result = await fight(sim.pilot, plan, 300, () => undefined, null, {
      record: session,
    });
    assert.equal(result.ok, true);
    assert.equal(result.turns.length, 2);

    const live = log.currentView();
    assert.ok(live);
    assert.equal(live.turns.length, 2);
    assert.equal(live.enemies[0]?.hp, 80);
    assert.equal(live.party[0]?.hp, 48);

    const [verdict, detail] = judgePlayers(result.players);
    const outcome = verdict === "lost" ? "wipe" : verdict === "hard" ? "hard" : "ok";
    await session.finish(sim.pilot.now(), outcome, detail);

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0] ?? "") as Json;
    assert.equal(record.id, 1);
    assert.equal(record.mapId, 229);
    assert.equal(record.mapName, "北山");
    assert.equal(record.kind, "regular");
    assert.deepEqual(record.table, { kind: "map", mapId: 229, table: 2 });
    assert.equal(record.result, "ok");
    assert.equal(record.seconds, 0);
    const turns = record.turns as Json[];
    assert.equal(turns.length, 2);

    const first = turns[0];
    assert.ok(first);
    assert.equal(first.actor, "巴兹");
    assert.equal(first.rule, 2);
    assert.equal(first.condition, "");
    const skipped = first.skipped as Json[];
    assert.equal(skipped.length, 1);
    const firstSkip = skipped[0];
    assert.ok(firstSkip);
    assert.equal(firstSkip.rule, 1);
    assert.match(String(firstSkip.condition), /ally\.hp_pct\(50\) < 90/);
    assert.match(String(firstSkip.why), /没有这个指令/);
    const firstChanges = first.changes as Json[];
    const goblin = firstChanges.find((change) => change.name === "哥布林");
    assert.deepEqual(goblin?.hp, { from: 100, to: 90 });
    const baz = firstChanges.find((change) => change.name === "巴兹");
    assert.deepEqual(baz?.hp, { from: 50, to: 48 });

    const second = turns[1];
    assert.ok(second);
    assert.equal(second.actor, "蕾娜");
    assert.equal(second.rule, 1);
    assert.equal(second.condition, "enemy.hp_pct(90) < 100");

    const summary = record.summary as Json;
    assert.deepEqual(summary.rules, [
      { actor: "巴兹", rule: 2, count: 1 },
      { actor: "蕾娜", rule: 1, count: 1 },
    ]);
    assert.equal(summary.damageDealt, 20);
    assert.equal(summary.damageTaken, 4);
    assert.deepEqual(summary.items, {});
    const rewrites = record.rewrites as Json[];
    assert.deepEqual(rewrites, []);
    const events = record.events as Json[];
    assert.deepEqual(events, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the summary counts items separately from damage", async () => {
  const log = await BattleLog.load("ff5", undefined);
  const session = log.start({
    mapId: null,
    mapName: "",
    boss: false,
    enemies: [],
    party: [],
    table: { kind: "default", mapId: null },
    startedAt: "2026-11-03T10:00:00.000Z",
    startedMs: 0,
  });
  session.turn(
    {
      actor: "蕾娜",
      rule: 1,
      condition: "ally.hp_pct(30) < 50",
      skipped: [],
      command: "道具",
      ability: "恢复药",
      targetName: "巴兹",
      done: "道具:恢复药→巴兹",
      item: "恢复药",
      beforeEnemies: [{ name: "哥布林", hp: 100, maxHp: 100 }],
      afterEnemies: [{ name: "哥布林", hp: 80, maxHp: 100 }],
      beforePlayers: [
        { name: "巴兹", hp: 30, maxHp: 100 },
        { name: "蕾娜", hp: 50, maxHp: 100 },
      ],
      afterPlayers: [
        { name: "巴兹", hp: 60, maxHp: 100 },
        { name: "蕾娜", hp: 50, maxHp: 100 },
      ],
    },
    1000,
  );
  const record = await session.finish(2000, "ok", "全队 HP 55%");
  assert.deepEqual(record.summary.items, { 恢复药: 1 });
  assert.equal(record.summary.damageDealt, 20);
  assert.equal(record.summary.damageTaken, 0);
  assert.equal(record.seconds, 2);
});
