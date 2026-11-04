/**
 * Battle records (task 36): one JSON line per battle under .deps/ds/battles-<game>.jsonl, the
 * live battle kept in memory for the sidebar, and the last 30 records as summaries. The record
 * says which table fought the battle, every rule hit and skipped rule, and the HP/MP/status
 * changes each turn saw, so a wipe can be explained without reading probe logs afterwards.
 *
 * Data comes from the battle menu skills/battle.ts already reads; nothing here queries a bridge.
 * The bridge may later push enemy actions as `events`; the shape is fixed now and the array
 * stays empty until then.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describeError, isMissingFile } from "./errors.ts";
import * as gambit from "./skills/gambit.ts";
import {
  isRecord,
  list,
  num,
  pyRound,
  record,
  records,
  text,
  truthy,
  type Json,
} from "./values.ts";

export type BattleResult = "ok" | "hard" | "wipe" | "timeout";

export const RESULT_TEXT: Readonly<Record<BattleResult, string>> = {
  ok: "赢",
  hard: "吃力",
  wipe: "全灭",
  timeout: "超时",
};

/** The enemies and party as the battle menu shows them; `hp` etc. are the starting readings. */
export interface BattleUnit {
  readonly name: string;
  readonly id: number | null;
  /** Bestiary number, when the bridge sent one (0.6.9+); old records may lack it. */
  readonly book?: number | null;
  readonly maxHp: number;
  readonly hp: number;
  readonly mp: number | null;
  readonly status: readonly string[];
  readonly boss: boolean;
}

/** Which table fought the battle: a map's numbered table, the boss table, or a fallback. */
export type BattleTable =
  | { readonly kind: "map"; readonly mapId: number | null; readonly table: number | null }
  | { readonly kind: "default"; readonly mapId: number | null }
  | { readonly kind: "boss"; readonly mapId: number | null }
  | { readonly kind: "manual"; readonly mapId: number | null };

/** A condition as it read at that turn, e.g. `ally.hp_pct(38) < 50`; "" for the fallback. */
export interface BattleSkipped {
  readonly rule: number;
  readonly condition: string;
  readonly why: string;
  /** 对策 1 / 阶段「合翅膀」第 2 条 / 规则 3 (task 41); absent on older records. */
  readonly basis?: string;
  /** The rule in Chinese. */
  readonly text?: string;
}

/** What fight() hands a session for one completed turn. */
export interface BattleTurnInput {
  readonly actor: string;
  readonly rule: number;
  readonly condition: string;
  /** Which reaction / phase rule / fallback was used (task 41). */
  readonly basis?: string;
  /** The rule in Chinese, as describeRule / describeReaction wrote it. */
  readonly text?: string;
  readonly skipped: readonly BattleSkipped[];
  readonly command: string;
  readonly ability: string;
  readonly targetName: string;
  readonly done: string;
  /** The item actually used, already resolved from the bag name; null for other actions. */
  readonly item: string | null;
  readonly beforeEnemies: readonly Json[];
  readonly afterEnemies: readonly Json[];
  readonly beforePlayers: readonly Json[];
  readonly afterPlayers: readonly Json[];
}

/** Field changes of one unit in one turn; a field is absent when it did not change. */
export interface UnitChange {
  readonly side: "party" | "enemy";
  readonly name: string;
  readonly id: number | null;
  readonly hp?: { readonly from: number; readonly to: number };
  readonly mp?: { readonly from: number; readonly to: number };
  readonly status?: { readonly from: readonly string[]; readonly to: readonly string[] };
}

export interface BattleTurnRecord {
  /** Seconds since the battle started, one decimal. */
  readonly at: number;
  readonly actor: string;
  /** 1-based rule that chose the action; 0 for the fallback attack. */
  readonly rule: number;
  readonly condition: string;
  /** 对策 1 / 阶段「合翅膀」第 2 条 / 规则 3 / 兜底; absent on older records. */
  readonly basis?: string;
  /** The rule in Chinese; absent on older records. */
  readonly text?: string;
  readonly action: string;
  readonly target: string;
  readonly item: string | null;
  readonly done: string;
  readonly skipped: readonly BattleSkipped[];
  readonly changes: readonly UnitChange[];
}

export interface BattleRuleHit {
  readonly actor: string;
  readonly rule: number;
  readonly count: number;
}

export interface BattleSummary {
  readonly rules: readonly BattleRuleHit[];
  readonly items: Readonly<Record<string, number>>;
  /** HP lost by the party this battle, as a positive number. */
  readonly damageTaken: number;
  /** HP lost by enemies this battle, as a positive number. */
  readonly damageDealt: number;
  /** Rules whose item ran out at least twice; absent on records from before task 41. */
  readonly gaps?: readonly BattleGap[];
}

/**
 * A bridge push folded into the battle record (task 40, bridge 0.13): `battle.act` when an
 * action starts and `battle.hit` for each target it settles. The record keeps both so the
 * live timeline can show the enemy's actions between the party's turns and mark counters.
 */
export interface BattleEvent {
  /** Seconds since the battle started. */
  readonly at: number;
  readonly kind: "battle.act" | "battle.hit";
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  /** Hit type / conditions, already one short Chinese line. */
  readonly detail?: string;
  readonly counter: boolean;
  /** HP/MP number from `battle.hit`; positive values, sign chosen by `heal`. */
  readonly value: number | null;
  readonly heal: boolean;
  /** Whether the action was magic, for strategy `used(any_magic)` (task 41). */
  readonly magic?: boolean;
}

/** A rule skipped twice because its item ran out (task 41); shown in the record and the result. */
export interface BattleGap {
  readonly item: string;
  readonly held: number;
  readonly basis: string;
  readonly skips: number;
}

export interface BattleRewrite {
  readonly reason: string;
  readonly ok: boolean;
  readonly summary: string;
}

export interface BattleRecord {
  readonly id: number;
  readonly game: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly mapId: number | null;
  readonly mapName: string;
  readonly kind: "regular" | "boss";
  readonly enemies: readonly BattleUnit[];
  readonly table: BattleTable;
  readonly rewrites: readonly BattleRewrite[];
  readonly result: BattleResult;
  readonly detail: string;
  readonly seconds: number;
  readonly turns: readonly BattleTurnRecord[];
  readonly summary: BattleSummary;
  readonly events: readonly BattleEvent[];
}

export interface BattleStart {
  readonly mapId: number | null;
  readonly mapName: string;
  readonly boss: boolean;
  readonly enemies: readonly BattleUnit[];
  readonly party: readonly BattleUnit[];
  readonly table: BattleTable;
  readonly startedAt?: string;
  readonly startedMs?: number;
}

export interface BattleUnitView {
  readonly name: string;
  readonly idText: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly hpText: string;
  readonly mpText: string;
  readonly statusText: string;
}

export interface BattleTurnView {
  readonly atText: string;
  readonly line: string;
  readonly basis: string;
  readonly skippedText: string;
}

export interface BattleEventView {
  readonly atText: string;
  readonly line: string;
  readonly counter: boolean;
}

export interface BattleLiveView {
  readonly id: number;
  readonly title: string;
  readonly enemies: readonly BattleUnitView[];
  readonly party: readonly BattleUnitView[];
  readonly turns: readonly BattleTurnView[];
  /** Enemy pushes, interleaved with `turns` by the page's timeline. */
  readonly events: readonly BattleEventView[];
}

export interface BattleSummaryView {
  readonly id: number;
  readonly atText: string;
  readonly line: string;
  readonly result: BattleResult;
  readonly resultText: string;
  readonly seconds: number;
}

export interface BattleRecordView {
  readonly id: number;
  readonly title: string;
  readonly result: BattleResult;
  readonly resultText: string;
  readonly tableText: string;
  readonly summaryText: string;
  readonly turns: readonly BattleTurnView[];
  readonly events: readonly BattleEventView[];
  readonly hits: readonly string[];
}

/** One battle in progress: mutable, kept by the log and shown by the sidebar. */
export class BattleSession {
  readonly id: number;
  readonly startedMs: number;
  private readonly log: BattleLog;
  private readonly game: string;
  private readonly startedAt: string;
  private readonly mapId: number | null;
  private readonly mapName: string;
  private readonly kind: "regular" | "boss";
  private readonly table: BattleTable;
  private readonly enemiesAtStart: readonly BattleUnit[];
  private party: BattleUnit[];
  private enemies: BattleUnit[];
  private readonly turns: BattleTurnRecord[] = [];
  private readonly events: BattleEvent[] = [];
  private gapNotes: readonly BattleGap[] = [];
  private rewrites: readonly BattleRewrite[] = [];
  private finished: BattleRecord | null = null;

  constructor(log: BattleLog, id: number, game: string, start: BattleStart) {
    this.log = log;
    this.id = id;
    this.game = game;
    this.startedMs = start.startedMs ?? Date.now();
    this.startedAt = start.startedAt ?? new Date().toISOString();
    this.mapId = start.mapId;
    this.mapName = start.mapName;
    this.kind = start.boss ? "boss" : "regular";
    this.table = start.table;
    this.party = [...start.party];
    this.enemies = [...start.enemies];
    this.enemiesAtStart = [...start.enemies];
  }

  /** Add one completed turn; `nowMs` is the pilot clock so tests can fake time. */
  turn(input: BattleTurnInput, nowMs: number): void {
    const changes = [
      ...changesFor("party", input.beforePlayers, input.afterPlayers),
      ...changesFor("enemy", input.beforeEnemies, input.afterEnemies),
    ];
    this.turns.push({
      at: Math.max(0, pyRound((nowMs - this.startedMs) / 1000, 1)),
      actor: input.actor,
      rule: input.rule,
      condition: input.condition,
      ...(input.basis === undefined ? {} : { basis: input.basis }),
      ...(input.text === undefined ? {} : { text: input.text }),
      action: input.command + (input.ability !== "" ? `:${input.ability}` : ""),
      target: input.targetName,
      item: input.item,
      done: input.done,
      skipped: [...input.skipped],
      changes,
    });
    if (input.afterPlayers.length > 0) this.party = battleUnits(input.afterPlayers);
    if (input.afterEnemies.length > 0) this.enemies = battleUnits(input.afterEnemies);
  }

  /** Write the record once and keep it in the recent list; repeated calls return the same one. */
  async finish(
    nowMs: number,
    result: BattleResult,
    detail: string,
    rewrites: readonly BattleRewrite[] = [],
  ): Promise<BattleRecord> {
    if (this.finished !== null) return this.finished;
    this.rewrites = [...rewrites];
    const record: BattleRecord = {
      id: this.id,
      game: this.game,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      mapId: this.mapId,
      mapName: this.mapName,
      kind: this.kind,
      enemies: this.enemiesAtStart,
      table: this.table,
      rewrites: this.rewrites,
      result,
      detail,
      seconds: Math.max(0, pyRound((nowMs - this.startedMs) / 1000, 0)),
      turns: [...this.turns],
      summary: {
        ...summarize(this.turns),
        ...(this.gapNotes.length > 0 ? { gaps: this.gapNotes } : {}),
      },
      events: [...this.events],
    };
    this.finished = record;
    await this.log.complete(this, record);
    return record;
  }

  view(): BattleLiveView {
    return {
      id: this.id,
      title: [this.kind === "boss" ? "首领战" : "普通战斗", mapText(this.mapId, this.mapName)]
        .filter((part) => part !== "")
        .join(" · "),
      enemies: this.enemies.map(unitView),
      party: this.party.map(unitView),
      turns: this.turns.slice(-10).map(turnView),
      events: this.events.slice(-20).map(eventView),
    };
  }

  /** The pushes so far, oldest first, for the strategy snapshot (task 41). */
  recentEvents(): readonly BattleEvent[] {
    return [...this.events];
  }

  /** Remember the gaps the executor found; the record's summary carries them. */
  noteGaps(gaps: readonly BattleGap[]): void {
    this.gapNotes = [...gaps];
  }

  /** The gaps found so far, for the boss rewrite's fact sheet. */
  gaps(): readonly BattleGap[] {
    return this.gapNotes;
  }

  /** Fold one bridge `battle.act` / `battle.hit` into this battle; unknown records are ignored. */
  addEvent(raw: Json, nowMs = Date.now()): BattleEvent | null {
    const parsed = parseBattleEvent(raw, Math.max(0, pyRound((nowMs - this.startedMs) / 1000, 1)));
    if (parsed === null) return null;
    this.events.push(parsed);
    return parsed;
  }
}

/** The battle log of one game: the record in progress, the last 30, and the file they append to. */
export class BattleLog {
  readonly game: string;
  readonly path: string | undefined;
  private nextId = 1;
  private session: BattleSession | null = null;
  private readonly records: BattleRecord[] = [];

  private constructor(game: string, path: string | undefined) {
    this.game = game;
    this.path = path;
  }

  /** Read the existing file, if any, so ids keep counting and recent battles survive a restart. */
  static async load(
    game: string,
    path: string | undefined,
    signal?: AbortSignal,
  ): Promise<BattleLog> {
    const log = new BattleLog(game, path);
    for (const record of await log.read(signal)) log.records.push(record);
    log.records.splice(0, Math.max(0, log.records.length - 30));
    log.nextId = log.records.reduce((max, record) => Math.max(max, record.id), 0) + 1;
    return log;
  }

  start(start: BattleStart): BattleSession {
    const session = new BattleSession(this, this.nextId, this.game, start);
    this.nextId += 1;
    this.session = session;
    return session;
  }

  currentView(): BattleLiveView | null {
    return this.session?.view() ?? null;
  }

  /** Fold one bridge push into the battle in progress; no current battle means no-op. */
  noteEvent(raw: Json, nowMs = Date.now()): BattleEvent | null {
    return this.session?.addEvent(raw, nowMs) ?? null;
  }

  /** The newest records, oldest first; the panel uses them for per-rule hit counts. */
  recentRecords(): readonly BattleRecord[] {
    return this.records;
  }

  /** Every record on disk, for the save-local bestiary's backfill; memory-only in tests. */
  async allRecords(signal?: AbortSignal): Promise<readonly BattleRecord[]> {
    if (this.path === undefined) return this.records;
    return await this.read(signal);
  }

  recentViews(): BattleSummaryView[] {
    return [...this.records].reverse().map(summaryView);
  }

  async recordView(id: number): Promise<BattleRecordView | null> {
    const inMemory = this.records.find((record) => record.id === id);
    const record = inMemory ?? (await this.read()).find((item) => item.id === id);
    return record === undefined ? null : recordView(record);
  }

  /** Called by a session once; appends one JSON line and keeps the last 30 in memory. */
  async complete(session: BattleSession, record: BattleRecord): Promise<void> {
    this.records.push(record);
    this.records.splice(0, Math.max(0, this.records.length - 30));
    if (this.session === session) this.session = null;
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await appendFile(this.path, JSON.stringify(record) + "\n", "utf8");
    } catch (error) {
      throw new Error(`写不了战斗记录 ${this.path}:${describeError(error)}`, { cause: error });
    }
  }

  private async read(signal?: AbortSignal): Promise<BattleRecord[]> {
    if (this.path === undefined) return [];
    let body: string;
    try {
      body = await readFile(this.path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return [];
      signal?.throwIfAborted();
      throw new Error(`读不了战斗记录 ${this.path}:${describeError(error)}`, { cause: error });
    }
    const out: BattleRecord[] = [];
    for (const line of body.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A crash can leave the last line half written; the rest of the file is still usable.
        continue;
      }
      if (!isBattleRecord(parsed)) continue;
      out.push(parsed);
    }
    return out;
  }
}

function isBattleRecord(value: unknown): value is BattleRecord {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.startedAt === "string" &&
    typeof value.endedAt === "string" &&
    typeof value.seconds === "number" &&
    typeof value.result === "string" &&
    value.result in RESULT_TEXT &&
    Array.isArray(value.enemies) &&
    Array.isArray(value.turns) &&
    isRecord(value.summary) &&
    isRecord(value.table)
  );
}

export function battleUnits(rows: readonly Json[]): BattleUnit[] {
  const out: BattleUnit[] = [];
  for (const row of rows) {
    const unit = battleUnit(row);
    if (unit !== null) out.push(unit);
  }
  return out;
}

function battleUnit(row: Json): BattleUnit | null {
  const name = text(row.name) ?? "";
  if (name === "") return null;
  const maxHp = num(row.maxHp) ?? num(row.hp) ?? 0;
  return {
    name,
    id: num(row.id) ?? null,
    book: num(row.book) ?? null,
    maxHp,
    hp: num(row.hp) ?? 0,
    mp: num(row.mp) ?? null,
    status: gambit.statuses(row),
    boss: truthy(row.boss),
  };
}

function changesFor(
  side: "party" | "enemy",
  beforeRows: readonly Json[],
  afterRows: readonly Json[],
): UnitChange[] {
  const before = records(beforeRows);
  const after = records(afterRows);
  const out: UnitChange[] = [];
  for (let index = 0; index < after.length; index++) {
    const afterUnit = battleUnit(after[index] ?? {});
    if (afterUnit === null) continue;
    const beforeRow = before[index];
    let beforeUnit = beforeRow === undefined ? null : battleUnit(beforeRow);
    if (beforeUnit === null || !sameUnit(beforeUnit, afterUnit)) {
      beforeUnit =
        before
          .map((row) => battleUnit(row))
          .find((unit) => unit !== null && sameUnit(unit, afterUnit)) ?? null;
    }
    if (beforeUnit === null) continue;
    const change: {
      side: "party" | "enemy";
      name: string;
      id: number | null;
      hp?: { from: number; to: number };
      mp?: { from: number; to: number };
      status?: { from: readonly string[]; to: readonly string[] };
    } = { side, name: afterUnit.name, id: afterUnit.id };
    let changed = false;
    if (beforeUnit.hp !== afterUnit.hp) {
      change.hp = { from: beforeUnit.hp, to: afterUnit.hp };
      changed = true;
    }
    if (beforeUnit.mp !== afterUnit.mp && beforeUnit.mp !== null && afterUnit.mp !== null) {
      change.mp = { from: beforeUnit.mp, to: afterUnit.mp };
      changed = true;
    }
    if (!sameStatus(beforeUnit.status, afterUnit.status)) {
      change.status = { from: beforeUnit.status, to: afterUnit.status };
      changed = true;
    }
    if (changed) out.push(change);
  }
  return out;
}

function sameUnit(a: BattleUnit, b: BattleUnit): boolean {
  if (a.id !== null && b.id !== null) return a.id === b.id;
  return a.name === b.name;
}

function sameStatus(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((status, index) => status === b[index]);
}

function summarize(turns: readonly BattleTurnRecord[]): BattleSummary {
  const counts = new Map<string, BattleRuleHit>();
  const items: Record<string, number> = {};
  let damageTaken = 0;
  let damageDealt = 0;
  for (const turn of turns) {
    const key = `${turn.actor}\u0000${turn.rule}`;
    const hit = counts.get(key);
    if (hit === undefined) counts.set(key, { actor: turn.actor, rule: turn.rule, count: 1 });
    else counts.set(key, { ...hit, count: hit.count + 1 });
    if (turn.item !== null && turn.item !== "") items[turn.item] = (items[turn.item] ?? 0) + 1;
    for (const change of turn.changes) {
      if (change.hp === undefined) continue;
      const delta = change.hp.from - change.hp.to;
      if (delta <= 0) continue;
      if (change.side === "party") damageTaken += delta;
      else damageDealt += delta;
    }
  }
  return {
    rules: [...counts.values()],
    items,
    damageTaken,
    damageDealt,
  };
}

function parseBattleEvent(raw: Json, fallbackAt: number): BattleEvent | null {
  const type = text(raw.type);
  if (type !== "battle.act" && type !== "battle.hit") return null;
  const act = record(raw.act);
  const actorRow = record(type === "battle.hit" ? act.actor : raw.actor);
  const actor = text(actorRow.name) ?? "";
  if (actor === "") return null;
  const command = text(record(type === "battle.hit" ? act.command : raw.command).name) ?? "";
  const abilities = list(type === "battle.hit" ? act.abilities : raw.abilities)
    .map((item) => text(record(item).name) ?? "")
    .filter((name) => name !== "");
  const action = abilities[0] ?? command;
  const targets = type === "battle.hit" ? [raw.target] : list(raw.targets);
  const target = targets
    .map((item) => text(record(item).name) ?? "")
    .filter((name) => name !== "")
    .join("、");
  const counter = truthy(type === "battle.hit" ? act.counter : raw.counter);
  const at = num(raw.at) ?? fallbackAt;
  const magic =
    /魔法|召唤|青魔法|时魔法|白魔法|黑魔法/u.test(command) ||
    /炎|冰|雷|风|水|土|毒|神圣|核融|陨石|究极|治疗|复活|护盾|加速|减速|沉默|睡眠|麻痹|混乱/u.test(
      action,
    );
  if (type === "battle.act") {
    return {
      at,
      kind: type,
      actor,
      action,
      target,
      counter,
      value: null,
      heal: false,
      magic,
    };
  }
  const value = num(raw.value) ?? null;
  const hit = text(raw.hit) ?? "";
  const heal = truthy(raw.heal) || hit === "Recovery";
  const miss = truthy(raw.miss) || hit === "Miss";
  const conditions = list(raw.conditions)
    .map((item) => text(record(item).name) ?? "")
    .filter((name) => name !== "");
  const detail = [miss ? "落空" : "", hit, ...conditions].filter((part) => part !== "").join("·");
  return {
    at,
    kind: type,
    actor,
    action,
    target,
    counter,
    value,
    heal,
    magic,
    ...(detail === "" ? {} : { detail }),
  };
}

function eventClock(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function eventView(event: BattleEvent): BattleEventView {
  const amount =
    event.value === null || event.value === 0 ? "" : ` ${event.heal ? "+" : "-"}${event.value}`;
  const target = event.target === "" ? "" : ` → ${event.target}${amount}`;
  const counter = event.counter ? "（反击）" : "";
  const detail =
    event.kind === "battle.hit" && event.detail !== undefined ? ` (${event.detail})` : "";
  return {
    atText: eventClock(event.at),
    line: `${eventClock(event.at)} ${event.actor} → ${event.action}${target}${detail}${counter}`,
    counter: event.counter,
  };
}

/** One rule's hit/skip counts for one map table, keyed by `actor\0rule` (1-based). */
export interface RuleStat {
  readonly hits: number;
  readonly skips: readonly { readonly why: string; readonly count: number }[];
}

export function ruleStats(
  records: readonly BattleRecord[],
  mapId: number,
  table: number,
): Map<string, RuleStat> {
  const counts = new Map<string, { hits: number; skips: Map<string, number> }>();
  const entry = (key: string): { hits: number; skips: Map<string, number> } => {
    const found = counts.get(key);
    if (found !== undefined) return found;
    const created = { hits: 0, skips: new Map<string, number>() };
    counts.set(key, created);
    return created;
  };
  for (const record of records) {
    if (record.table.kind !== "map") continue;
    if (record.table.mapId !== mapId || record.table.table !== table) continue;
    for (const turn of record.turns) {
      if (turn.rule > 0) entry(`${turn.actor}\u0000${turn.rule}`).hits += 1;
      for (const skip of turn.skipped) {
        const skips = entry(`${turn.actor}\u0000${skip.rule}`).skips;
        skips.set(skip.why, (skips.get(skip.why) ?? 0) + 1);
      }
    }
  }
  const out = new Map<string, RuleStat>();
  for (const [key, value] of counts) {
    out.set(key, {
      hits: value.hits,
      skips: [...value.skips].map(([why, count]) => ({ why, count })),
    });
  }
  return out;
}

/** 「缺口:解毒药 0 个,规则 3 跳过了 2 次」 for one battle's summary text. */
export function gapText(gaps: readonly BattleGap[]): string {
  return gaps
    .map((gap) => `缺口:${gap.item} ${gap.held} 个,${gap.basis} 跳过了 ${gap.skips} 次`)
    .join(";");
}

function unitView(unit: BattleUnit): BattleUnitView {
  return {
    name: unit.name,
    idText: unit.id === null ? "" : `#${unit.id}`,
    hp: unit.hp,
    maxHp: unit.maxHp,
    hpText: `${unit.hp}/${unit.maxHp}`,
    mpText: unit.mp === null ? "" : `MP ${unit.mp}`,
    statusText: unit.status.join("、"),
  };
}

function turnView(turn: BattleTurnRecord): BattleTurnView {
  const atText = `${turn.at} 秒`;
  const target = turn.target === "" ? "" : ` → ${turn.target}`;
  return {
    atText,
    line: `${atText} ${turn.actor} → ${turn.action}${target}${changeText(turn.changes, turn.target)}`,
    basis: `${
      turn.basis ??
      (turn.rule === 0 ? "兜底" : turn.condition === "" ? `规则 ${turn.rule}` : `规则 ${turn.rule}`)
    }${turn.condition === "" ? "" : `:${turn.condition}`}`,
    skippedText:
      turn.skipped.length === 0
        ? ""
        : "跳过:" +
          turn.skipped.map((skip) => `${skip.basis ?? `规则 ${skip.rule}`}(${skip.why})`).join(";"),
  };
}

function changeText(changes: readonly UnitChange[], target: string): string {
  const notes: string[] = [];
  // The acted-on unit first, so 「打谁(HP 变化)」 reads next to the target's name.
  const ordered = [...changes].sort(
    (a, b) => Number(b.name === target) - Number(a.name === target),
  );
  for (const change of ordered) {
    const parts: string[] = [];
    if (change.hp !== undefined) parts.push(`HP ${signed(change.hp.to - change.hp.from)}`);
    if (change.mp !== undefined) parts.push(`MP ${signed(change.mp.to - change.mp.from)}`);
    if (change.status !== undefined) {
      parts.push(`状态 ${statusText(change.status.from)}→${statusText(change.status.to)}`);
    }
    if (parts.length === 0) continue;
    notes.push(change.name === target ? parts.join(" ") : `${change.name} ${parts.join(" ")}`);
  }
  return notes.length > 0 ? `(${notes.join("; ")})` : "";
}

function statusText(statuses: readonly string[]): string {
  return statuses.length === 0 ? "无" : statuses.join("、");
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function mapText(mapId: number | null, name: string): string {
  const where = mapId === null ? "" : `地图 ${mapId}`;
  return [where, name].filter((part) => part !== "").join(" ");
}

function tableLabel(table: BattleTable): string {
  switch (table.kind) {
    case "map": {
      const where = `地图 ${table.mapId ?? "?"}`;
      return table.table === null ? `${where} 的策略` : `${where} 第 ${table.table} 套`;
    }
    case "default":
      return "默认规则";
    case "boss":
      return "首领表";
    case "manual":
      return "手动规则表";
  }
}

function enemyLabel(enemies: readonly BattleUnit[]): string {
  const counts = new Map<string, number>();
  for (const enemy of enemies) {
    counts.set(enemy.name, (counts.get(enemy.name) ?? 0) + 1);
  }
  const labels = [...counts].map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
  return labels.length === 0 ? "未知敌人" : labels.join("、");
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function summaryView(record: BattleRecord): BattleSummaryView {
  const resultText = RESULT_TEXT[record.result];
  const items = Object.entries(record.summary.items)
    .map(([name, count]) => `${name}×${count}`)
    .join("、");
  const atText = clock(record.startedAt);
  return {
    id: record.id,
    atText,
    result: record.result,
    resultText,
    seconds: record.seconds,
    line:
      `${atText} ${enemyLabel(record.enemies)} ${resultText} ${record.seconds} 秒` +
      (items === "" ? "" : ` 道具:${items}`),
  };
}

function recordView(record: BattleRecord): BattleRecordView {
  const resultText = RESULT_TEXT[record.result];
  const items = Object.entries(record.summary.items)
    .map(([name, count]) => `${name}×${count}`)
    .join("、");
  const gaps = gapText(record.summary.gaps ?? []);
  return {
    id: record.id,
    title: `第 ${record.id} 场 · ${clock(record.startedAt)} · ${enemyLabel(record.enemies)} · ${resultText} · ${record.seconds} 秒`,
    result: record.result,
    resultText,
    tableText: tableLabel(record.table),
    summaryText:
      `${record.detail};共 ${record.turns.length} 回合,造成伤害 ${record.summary.damageDealt},` +
      `受到伤害 ${record.summary.damageTaken},道具:${items === "" ? "无" : items}` +
      (gaps === "" ? "" : `;${gaps}`),
    turns: record.turns.map(turnView),
    events: (Array.isArray(record.events) ? record.events : []).map(eventView),
    hits: record.summary.rules.map(
      (hit) => `${hit.actor} ${hit.rule === 0 ? "兜底" : `规则 ${hit.rule}`}:${hit.count} 次`,
    ),
  };
}
