/**
 * Battles by rule table (control plan §4.6; the rules and the choice are skills/gambit.ts).
 * At each character's turn the first rule that holds and can be done is done; one that cannot
 * (no such command, spell not learned, MP short) is backed out of and the next rule tried.
 *
 * Every step is checked against the battle menu the bridge reads: the command list from 0.4.0,
 * and from 0.6.0 which window has the keys (menuState, commandState) and the target cursor.
 * Older bridges get the game's default target and a fixed pause after each command. Ported from
 * ffpr_agent/skills/battle.py.
 */

import type { Pilot, Reply } from "../pilot.ts";
import { describeError } from "../errors.ts";
import { placeName, sceneStatus } from "../status.ts";
import { isRecord, list, num, pyRound, records, record, text, truthy } from "../values.ts";
import type { Element, ElementLearner, EnemyResistances } from "../elements.ts";
import { moveCursor, pick, steer } from "./cursor.ts";
import * as gambit from "./gambit.ts";
import { cast, partyState, useItem } from "./menu.ts";
import { loadGame } from "./save.ts";
import {
  battleUnits,
  gapText,
  type BattleEvent as RecordedEvent,
  type BattleGap,
  type BattleLog,
  type BattleSession,
  type BattleSkipped,
  type BattleTurnInput,
} from "../battle-record.ts";
import {
  cureAilmentOf,
  enemyIndex,
  fallbackSteps,
  snapshotEvents,
  strategyFor,
  StrategyRuntime,
  type InstinctOptions,
  type StrategyChoice,
  type StrategyStep,
} from "../strategy/execute.ts";
import { StrategyError as StrategyFailure } from "../strategy/types.ts";
import type { BattleSnapshot, SnapshotUnit, Strategy } from "../strategy/types.ts";

type Say = (line: string) => void;

export const ICON = /^<[^>]+>/; // 「<IC_WMGC>治疗」 → 「治疗」
export const HIDDEN: ReadonlyMap<string, readonly [string, string]> = new Map([
  ["防御", ["Right", "Defence"]],
  ["换列", ["Left", "Change"]],
]);
export const UNDO: ReadonlyMap<string, string> = new Map([
  ["Right", "Left"],
  ["Left", "Right"],
]);

/** While the tactician writes, every actor defends instead of following the broken table. */
const HOLD_STRATEGY: Strategy = {
  version: 2,
  roles: {},
  reactions: [],
  phases: [],
  rules: [{ who: "all", do: "防御" }],
};

/** A table that cannot be read still gets the fallback; nobody loses a turn to the parser. */
const EMPTY_STRATEGY: Strategy = {
  version: 2,
  roles: {},
  reactions: [],
  phases: [],
  rules: [],
};

/** The Game's hooks: the table in use for a map's monsters, where the result goes, and what
 * battles learned about enemy elements. */
export interface BattleHooks {
  tableFor?: (mapId: number | null) => unknown;
  /** Which of the map's tables tableFor returned, 0-based; null when it is not a player table. */
  tableIndexFor?: (mapId: number | null) => number | null;
  /** Where battle records go (task 36); absent in tests that only drive the keys. */
  recorder?: BattleLog;
  report?: (mapId: number | null, verdict: string, detail: string) => string | Promise<string>;
  /** Task 82: the activity log sink for a refused item-cursor move after battle. */
  onIncident?: (message: string) => void;
  elements?: ElementLearner;
  /** Task 91: the after-battle HP/MP thresholds and reserve from Config. */
  heal?: PatchUpOptions;
  /**
   * Task 104: the in-battle instinct knobs. game.ts cannot change in this task, so the plugin
   * sets this on the same hooks object Game keeps in moveState (see plugin/player.ts).
   */
  instinct?: InstinctOptions;
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  if (isRecord(value)) {
    const pairs = Object.entries(value).map(([key, item]) => `'${key}': ${show(item)}`);
    return `{${pairs.join(", ")}}`;
  }
  return JSON.stringify(value);
}

function iconName(value: unknown): string {
  return (text(value) ?? "").replace(ICON, "");
}

export async function battleMenu(pilot: Pilot): Promise<Reply> {
  return record((await pilot.query("battlemenu")).battlemenu);
}

/** Poll the battle menu until `test` holds; returns the last reading either way. */
export async function waitFor(
  pilot: Pilot,
  test: (menu: Reply) => boolean,
  seconds = 1.5,
): Promise<Reply> {
  const end = pilot.now() + seconds * 1000;
  let menu = await battleMenu(pilot);
  while (!test(menu) && pilot.now() < end) {
    await pilot.sleep(80);
    menu = await battleMenu(pilot);
  }
  return menu;
}

// The bridge translates UnableFight to 战斗不能; a bridge that sends the game's own Chinese
// words sends 无法战斗. Either means the member cannot act.
const DOWN_STATUS = ["战斗不能", "无法战斗"];

function fallen(unit: Reply): boolean {
  const hp = num(unit.hp);
  if (hp !== undefined && hp <= 0) return true;
  return gambit.statuses(unit).some((status) => DOWN_STATUS.some((word) => status.includes(word)));
}

/** Nobody in the party can act: every member has no HP or the game's "cannot fight" state. */
export function partyWiped(players: readonly Reply[]): boolean {
  return players.length > 0 && players.every(fallen);
}

/** The party from the battle menu, or from the sample on bridges that leave players out. */
async function battlePlayers(pilot: Pilot, menu: Reply): Promise<Reply[]> {
  if (Array.isArray(menu.players) && menu.players.length > 0) return records(menu.players);
  const battle = record(record((await pilot.query("sample")).sample).battle);
  return records(battle.players);
}

/** The enemy names for a wipe report, once each. */
export function enemyNames(enemies: readonly Reply[]): string {
  return [
    ...new Set(
      enemies.map((enemy) => text(enemy.name)).filter((name): name is string => name !== undefined),
    ),
  ].join("、");
}

/** Someone's command list has the keys. */
export function ready(menu: Reply): boolean {
  if (!truthy(menu.actor) || !truthy(menu.commands)) return false;
  if ("menuState" in menu && menu.menuState !== "CommandSelecting") return false;
  const state = record(menu.target).state;
  return state === null || state === undefined || state === "None";
}

export function targetOpen(menu: Reply): boolean {
  const state = record(menu.target).state;
  return state !== null && state !== undefined && state !== "None";
}

export function listOpen(menu: Reply): boolean {
  return ["abilityState", "itemState"].some((key) => {
    const value = menu[key];
    return value !== null && value !== undefined && value !== "None";
  });
}

/**
 * The command list has the keys, with no magic/item list drawn over it. ready() alone was
 * true while an item list was open (the battle menu keeps CommandSelecting underneath), so a
 * failed item rule left the list open and the next keys passed the turn (task 41).
 */
export function commandReady(menu: Reply): boolean {
  return ready(menu) && !listOpen(menu);
}

/**
 * 11-05: FF5 escapes with L1+R1 held down for a moment. The bridge's `hold` keeps a virtual
 * gamepad button down for at most 5 s; renewing before that keeps both held. How long the game
 * needs, and whether an open command window swallows the keys, is not verified on the real
 * game yet (11-05 was already a game-over screen), so both are constants to tune there.
 */
export const FLEE_HOLD_MS = 2500;
export const FLEE_TIMEOUT_MS = 20_000;
export const FLEE_POLL_MS = 250;
/** Renew the hold this long before it lapses, so L1+R1 never let go (11-05 live: 8 s held). */
export const FLEE_RENEW_MARGIN_MS = 1000;
/**
 * Close an open magic/item list or target cursor before holding L1+R1. Never press cancel on
 * the command list itself: that passes the turn to the next character (10-20).
 */
export const FLEE_CLOSE_MENU = false;

export interface FleeOptions {
  /** Close an open magic/item list before holding, when FLEE_CLOSE_MENU is tuned to true. */
  readonly closeMenu?: boolean;
}

export interface FleeResult {
  readonly fled: boolean;
  /** Seconds from the first hold to the battle scene ending. */
  readonly seconds: number;
  /** Why it did not escape; "" when it did. */
  readonly reason: string;
}

function secondsText(seconds: number): string {
  return String(pyRound(seconds, 1));
}

/** Let go of both shoulders; the hold's own deadline would release them anyway. */
async function releaseFlee(pilot: Pilot): Promise<void> {
  try {
    await pilot.send("stop", {}, 5000);
  } catch (error) {
    // Cancellation belongs to dsh, not to a failed release: let the tool boundary see it.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // A failed release is harmless: the bridge drops a held button when its ms runs out.
  }
}

/**
 * Hold L1+R1 until the battle scene is gone or `timeoutMs` runs out. Returns what happened;
 * the caller decides whether the encounter could be fled at all.
 */
export async function flee(
  pilot: Pilot,
  timeoutMs = FLEE_TIMEOUT_MS,
  options: FleeOptions = {},
): Promise<FleeResult> {
  const started = pilot.now();
  const before = await battleMenu(pilot);
  if (!truthy(before.battle)) {
    return { fled: false, seconds: 0, reason: "战斗已经结束" };
  }
  if (options.closeMenu === true && (listOpen(before) || targetOpen(before))) {
    await backToCommands(pilot);
  }
  let reason = "";
  while (pilot.now() - started < timeoutMs) {
    const holdMs = Math.min(FLEE_HOLD_MS, timeoutMs - (pilot.now() - started));
    const left = await pilot.send(
      "hold",
      { key: "PadL1", down: true, ms: holdMs, via: "game" },
      10_000,
    );
    const right = await pilot.send(
      "hold",
      { key: "PadR1", down: true, ms: holdMs, via: "game" },
      10_000,
    );
    if (!truthy(left.ok) || !truthy(right.ok)) {
      reason = `按住 L1/R1 失败:${show(left.error ?? right.error)}`;
      break;
    }
    const renewAt = pilot.now() + Math.max(FLEE_POLL_MS, holdMs - FLEE_RENEW_MARGIN_MS);
    while (pilot.now() < renewAt && pilot.now() - started < timeoutMs) {
      await pilot.sleep(FLEE_POLL_MS);
      if (!truthy((await battleMenu(pilot)).battle)) {
        const seconds = (pilot.now() - started) / 1000;
        await releaseFlee(pilot);
        return { fled: true, seconds, reason: "" };
      }
    }
  }
  const seconds = (pilot.now() - started) / 1000;
  await releaseFlee(pilot);
  return {
    fled: false,
    seconds,
    reason: reason === "" ? `按了 ${secondsText(seconds)} 秒还没逃掉` : reason,
  };
}

/**
 * Press `key` until the reading shows `done`: a window that just opened ignores keys for
 * a moment (its inputWait), so a press can be lost (10-20, the target confirm).
 */
export async function pressUntil(
  pilot: Pilot,
  key: string,
  done: (menu: Reply) => boolean,
  tries = 3,
): Promise<Reply> {
  let menu: Reply = {};
  for (let i = 0; i < tries; i++) {
    await pilot.send("keys", { keys: [key], gap: 100 });
    menu = await waitFor(pilot, done, 0.7);
    if (done(menu)) break;
  }
  return menu;
}

export interface FightResult {
  readonly ok: boolean;
  readonly turns: string[];
  readonly error?: string;
  /** What this battle learned about enemy elements, for the result text. */
  readonly learned: string[];
  /** The last party and enemies read from the battle menu, for judging without another query. */
  readonly players: readonly Reply[];
  readonly enemies: readonly Reply[];
  /** Rules that kept hitting a missing item (task 41). */
  readonly gaps: readonly BattleGap[];
  /** 11-05: the party escaped; no result judging and no patch-up after it. */
  readonly fled?: boolean;
  readonly fledSeconds?: number;
}

/** One completed turn, for a caller watching the battle (boss rewrites, task 34; records 36). */
export interface FightTurn extends BattleTurnInput {
  readonly target: string;
}

/** What act() decided and why, kept for the battle record. */
export interface ActDecision {
  readonly action: gambit.Action;
  readonly condition: string;
  /** 对策 1 / 阶段「合翅膀」第 2 条 / 规则 3 / 兜底 (task 41). */
  readonly basis: string;
  /** The rule in Chinese, as describeRule / describeReaction wrote it. */
  readonly text: string;
  readonly skipped: readonly BattleSkipped[];
  readonly done: boolean;
  /** 11-05: this turn's 逃跑 rule got the party out. */
  readonly fled?: boolean;
  readonly fledSeconds?: number;
}

/**
 * Let the caller change the table while the battle is running. `onTurn` must not await: the
 * ATB keeps moving, and every actor defends while `hold` is true (the tactician is writing).
 */
export interface FightOptions {
  table?: () => unknown;
  hold?: () => boolean;
  onTurn?: (turn: FightTurn) => void;
  /** The live record this battle writes to; each turn is added as it is read. */
  record?: BattleSession;
  /** Bridge battle.act / battle.hit pushes for the strategy snapshot; the record supplies them. */
  events?: () => readonly RecordedEvent[];
  /** Task 104: timer flee and the emergency potion, from Config. */
  instinct?: InstinctOptions;
}

/** One elemental spell about to land on an enemy, remembered until the next menu reading. */
interface ElementalCast {
  readonly element: Element;
  readonly name: string;
  readonly book: number | null;
  readonly slot: number;
  readonly beforeHp: number;
}

type CastListener = (casts: readonly ElementalCast[]) => void;

/**
 * Fight a battle with a rule table ({角色: [规则...]}, or the older {角色: "指令"}).
 * Characters without rules attack. Returns {"ok", "turns"}; turns say who did what.
 */
export async function fight(
  pilot: Pilot,
  plan: unknown,
  timeout = 300,
  say: Say = () => undefined,
  elements: ElementLearner | null = null,
  options: FightOptions = {},
): Promise<FightResult> {
  const deadline = pilot.now() + timeout * 1000;
  const battleStarted = pilot.now();
  const runtime = new StrategyRuntime();
  const turns: string[] = [];
  const learned: string[] = [];
  let lastPlayers: Reply[] = [];
  let lastEnemies: Reply[] = [];
  let pending: ElementalCast[] = [];
  const count = new Map<string, number>();
  // Items ordered this battle: ATB queues commands before they act, so the bag still shows
  // them (10-20: three potions went where one was meant).
  const ordered = new Map<string, number>();
  const bag = await heldItems(pilot);
  let idleSince = pilot.now();
  while (pilot.now() < deadline) {
    const menu = await battleMenu(pilot);
    // Compare on the next command list, not during the animation: right after a command the
    // menu closes before the damage lands, so an early reading still shows the old HP.
    if (elements !== null && pending.length > 0 && (ready(menu) || !truthy(menu.battle))) {
      await checkCasts(pending, menu, elements, learned);
      pending = [];
    }
    if (!truthy(menu.battle))
      return {
        ok: true,
        turns,
        learned,
        players: lastPlayers,
        enemies: lastEnemies,
        gaps: runtime.gaps(),
      };
    if (partyWiped(await battlePlayers(pilot, menu))) {
      await passWipe(pilot);
      return {
        ok: false,
        error: "wiped",
        turns,
        learned,
        players: lastPlayers,
        enemies: lastEnemies,
        gaps: runtime.gaps(),
      };
    }
    if (!commandReady(menu)) {
      const stuck = pilot.now() - idleSince > 2500;
      if (stuck && targetOpen(menu)) {
        // a target cursor left open: confirm it
        await pilot.send("keys", { keys: ["Enter"], gap: 100 });
        idleSince = pilot.now();
        continue;
      }
      if (stuck && listOpen(menu)) {
        // a magic list left open: back out of it
        await backToCommands(pilot);
        idleSince = pilot.now();
        continue;
      }
      // Enemy turns and animations; on the result screens Enter moves on. Never press it
      // while a command list is up: it would choose whatever is highlighted.
      const idle = pilot.now() - idleSince > 2500;
      if (idle && menu.menuState !== "CommandSelecting" && !truthy(menu.actor)) {
        await pilot.send("keys", { keys: ["Enter"], gap: 100 });
        idleSince = pilot.now();
      }
      await pilot.sleep(150);
      continue;
    }
    const actor = show(menu.actor);
    const turn = (count.get(actor) ?? 0) + 1;
    count.set(actor, turn);
    const situation = await situationOf(
      pilot,
      menu,
      actor,
      turn,
      bag,
      Object.fromEntries(ordered),
      elements,
    );
    // Task 104: the sample carries the countdown and the party's jobs/spells, which the battle
    // menu does not. Read it each turn so a countdown that starts mid-battle also counts.
    const info = await sampleInfo(pilot);
    // Read the table each turn: a rewrite may have replaced it (task 34). While the tactician
    // writes, everyone defends instead of following the table that is not working.
    const snapshot: BattleSnapshot = {
      allies: withPartyInfo(snapshotUnits(records(situation.players)), info.party),
      enemies: snapshotUnits(records(situation.enemies)),
      items: situation.items,
      actor,
      turn,
      seconds: Math.max(0, (pilot.now() - battleStarted) / 1000),
      boss: situation.boss,
      notEscape: situation.notEscape,
      timerActive: info.timerActive,
      events: snapshotEvents(eventsOf(options)),
    };
    const table = options.hold?.() === true ? HOLD_STRATEGY : (options.table?.() ?? plan);
    const taken: { action: gambit.Action | null } = { action: null };
    const decided: { value: ActDecision | null } = { value: null };
    const done = await act(
      pilot,
      menu,
      table,
      situation,
      (casts) => {
        pending.push(...casts);
      },
      (chosenAction) => {
        taken.action = chosenAction;
      },
      (made) => {
        decided.value = made;
      },
      { runtime, snapshot, instinct: options.instinct },
    );
    if (decided.value?.fled === true) {
      // 11-05: the escape animation is over and the battle menu is gone. Stop here rather than
      // judging a party that never finished the fight; the turn still belongs in the record.
      turns.push(`${actor}→${done}`);
      say(`  ${actor}:${done}`);
      return {
        ok: true,
        fled: true,
        fledSeconds: decided.value.fledSeconds ?? 0,
        turns,
        learned,
        players: records(situation.players),
        enemies: records(situation.enemies),
        gaps: runtime.gaps(),
      };
    }
    let usedItem: string | null = null;
    if (done.startsWith("道具:")) {
      const item = iconName((done.slice("道具:".length).split("→")[0] ?? "").split("(")[0] ?? "");
      usedItem = item;
      ordered.set(item, (ordered.get(item) ?? 0) + 1);
    }
    turns.push(`${actor}→${done}`);
    say(`  ${actor}:${done}`);
    await turnOver(pilot, actor);
    lastPlayers = records(situation.players);
    lastEnemies = records(situation.enemies);
    if (options.onTurn !== undefined || options.record !== undefined) {
      const after = await battleMenu(pilot);
      const afterEnemies = records(after.enemies);
      const afterPlayers = records(after.players);
      const action = decided.value?.action ?? taken.action;
      const living = aliveEnemyRows(situation.enemies);
      const targeted =
        action === null
          ? ""
          : (action.whom ??
            (action.enemy !== null
              ? (text(living[action.enemy]?.name) ?? "")
              : action.target === gambit.ENEMY
                ? (text(living[0]?.name) ?? "")
                : ""));
      const payload: FightTurn = {
        actor,
        rule: decided.value?.action.rule ?? 0,
        condition: decided.value?.condition ?? "",
        basis: decided.value?.basis ?? "兜底",
        text: decided.value?.text ?? "",
        skipped: decided.value?.skipped ?? [],
        command: action?.command ?? "",
        ability: action?.ability ?? "",
        target: action?.target ?? "",
        targetName: targeted,
        done,
        item: usedItem,
        beforeEnemies: records(situation.enemies),
        afterEnemies: afterEnemies.length > 0 ? afterEnemies : records(situation.enemies),
        beforePlayers: records(situation.players),
        afterPlayers: afterPlayers.length > 0 ? afterPlayers : records(situation.players),
      };
      lastEnemies = [...payload.afterEnemies];
      lastPlayers = [...payload.afterPlayers];
      options.onTurn?.(payload);
      options.record?.turn(payload, pilot.now());
    }
    options.record?.noteGaps(runtime.gaps());
    idleSince = pilot.now();
  }
  return {
    ok: false,
    error: "timeout",
    turns,
    learned,
    players: lastPlayers,
    enemies: lastEnemies,
    gaps: runtime.gaps(),
  };
}

export async function heldItems(pilot: Pilot): Promise<Record<string, number>> {
  const held = record((await pilot.query("items")).items);
  const items = records(held.normal);
  const out: Record<string, number> = {};
  for (const item of items) {
    out[iconName(item.name)] = num(item.count) ?? 0;
  }
  return out;
}

/** What one sample adds to the battle snapshot: the countdown and the party's jobs/spells. */
interface SampleInfo {
  readonly timerActive: boolean;
  readonly party: readonly Reply[];
}

/**
 * The sample's timer (bridge 0.14.3+) and party abilities (task 104). A test pilot or an old
 * bridge may not answer `sample`; then there is no countdown to flee and no job data, which is
 * exactly the old behaviour.
 */
async function sampleInfo(pilot: Pilot): Promise<SampleInfo> {
  try {
    const sample = record((await pilot.query("sample")).sample);
    return {
      timerActive: truthy(record(sample.timer).active),
      party: records(sample.party),
    };
  } catch {
    return { timerActive: false, party: [] };
  }
}

/** Add the sample party's current job and learned spells to the battle rows, by name. */
function withPartyInfo(units: readonly SnapshotUnit[], party: readonly Reply[]): SnapshotUnit[] {
  return units.map((unit) => {
    const row = party.find((member) => text(member.name) === unit.name);
    if (row === undefined) return unit;
    const jobName = text(row.jobName);
    const abilities = records(row.abilities)
      .map((ability) => {
        const name = text(ability.name) ?? "";
        const mp = num(ability.mp);
        const type = num(ability.type);
        return {
          name,
          ...(mp === undefined ? {} : { mp }),
          ...(type === undefined ? {} : { type }),
        };
      })
      .filter((ability) => ability.name !== "");
    return {
      ...unit,
      ...(jobName === undefined || jobName === "" ? {} : { jobName }),
      ...(Array.isArray(row.abilities) ? { abilities } : {}),
    };
  });
}

/** Battle-menu rows as snapshot units; statuses are the game's Chinese words. */
function snapshotUnits(rows: readonly Reply[]): SnapshotUnit[] {
  const out: SnapshotUnit[] = [];
  for (const row of rows) {
    const name = text(row.name) ?? "";
    if (name === "") continue;
    out.push({
      name,
      ...(num(row.id) === undefined ? {} : { id: num(row.id) }),
      hp: num(row.hp) ?? 0,
      ...(num(row.maxHp) === undefined ? {} : { maxHp: num(row.maxHp) }),
      ...(num(row.mp) === undefined ? {} : { mp: num(row.mp) }),
      ...(num(row.maxMp) === undefined ? {} : { maxMp: num(row.maxMp) }),
      status: gambit.statuses(row),
      boss: truthy(row.boss),
    });
  }
  return out;
}

function snapshotOfSituation(
  situation: gambit.Situation,
  seconds: number,
  events: readonly RecordedEvent[],
): BattleSnapshot {
  return {
    allies: snapshotUnits(situation.players),
    enemies: snapshotUnits(situation.enemies),
    items: situation.items,
    actor: situation.actor,
    turn: situation.turn,
    seconds,
    boss: situation.boss,
    notEscape: situation.notEscape,
    events: snapshotEvents(events),
  };
}

/** The bridge pushes this turn, from the live record or the test's own provider. */
function eventsOf(options: FightOptions): readonly RecordedEvent[] {
  if (options.events !== undefined) return options.events();
  return options.record?.recentEvents() ?? [];
}

/**
 * What the rules read. Items count what is in the bag less what was already ordered this
 * battle (`bag` as it began, `ordered` since), whichever is fewer.
 */
export async function situationOf(
  pilot: Pilot,
  menu: Reply,
  actor: string,
  turn: number,
  bag: Record<string, number> = {},
  ordered: Record<string, number> = {},
  elements: ElementLearner | null = null,
): Promise<gambit.Situation> {
  let players = menu.players;
  let enemies = menu.enemies;
  let sampleNotEscape = false;
  if (players === null || players === undefined) {
    // bridge before 0.6.0: the sample has both sides
    const battle = record(record((await pilot.query("sample")).sample).battle);
    players = battle.players;
    enemies = battle.enemies;
    sampleNotEscape = truthy(battle.notEscape);
  }
  const playerRows = records(players);
  const enemyRows = records(enemies);
  const boss = enemyRows.some((enemy) => truthy(enemy.boss)) || truthy(menu.boss);
  // The battlemenu keeps Battle()'s fields (party, notEscape, boss) next to the units.
  const notEscape = truthy(menu.notEscape) || sampleNotEscape;
  let items = await heldItems(pilot);
  if (Object.keys(bag).length > 0 && Object.keys(ordered).length > 0) {
    const reduced: Record<string, number> = {};
    for (const [name, count] of Object.entries(items)) {
      const remaining = Math.max(0, Math.min(count, (bag[name] ?? count) - (ordered[name] ?? 0)));
      reduced[name] = remaining;
    }
    items = reduced;
  }
  return new gambit.Situation(actor, playerRows, enemyRows, turn, boss, items, elements, notEscape);
}

/** This rule cannot be done now (the reason is the message); try the next one. */
export class CannotDo extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CannotDo";
  }
}

/** Extra data one turn hands act(): the shared runtime, the snapshot and instinct options. */
export interface ActContext {
  readonly runtime?: StrategyRuntime;
  readonly snapshot?: BattleSnapshot;
  readonly instinct?: InstinctOptions;
}

/**
 * Do the first rule that can be done; returns what was done, with why earlier rules were
 * passed over. A 2.0 strategy and the old per-actor rule list both go through the same
 * executor (task 41); the old list is converted with fromLegacy.
 */
export async function act(
  pilot: Pilot,
  menu: Reply,
  table: unknown,
  situation: gambit.Situation,
  onCast: CastListener = () => undefined,
  onAction: (action: gambit.Action) => void = () => undefined,
  onDecision: (decision: ActDecision) => void = () => undefined,
  context: ActContext = {},
): Promise<string> {
  const runtime = context.runtime ?? new StrategyRuntime();
  let read: Strategy | string[];
  try {
    read = Array.isArray(table)
      ? strategyFor({ [situation.actor]: table }, situation.actor)
      : strategyFor(table, situation.actor);
  } catch (error) {
    // Task 53: a table that cannot even be read must not break the battle.
    if (!(error instanceof StrategyFailure)) throw error;
    read = [error.message];
  }
  if (Array.isArray(read)) runtime.noteTableProblem(read);
  const strategy = Array.isArray(read) ? EMPTY_STRATEGY : read;
  const snapshot = context.snapshot ?? snapshotOfSituation(situation, 0, []);
  runtime.observe(snapshot, pilot.now());
  let choice: StrategyChoice;
  try {
    choice = runtime.choices(strategy, snapshot, context.instinct);
  } catch (error) {
    // Task 53: never let a broken expression escape the executor; fall back to an attack.
    if (!(error instanceof StrategyFailure)) throw error;
    runtime.noteProblem("策略执行", error.message);
    choice = { steps: fallbackSteps(strategy, snapshot, context.instinct), skipped: [] };
  }
  const { steps, skipped } = choice;
  const passed: string[] = [];
  const legacy = legacyRules(table, situation.actor);
  const tried: BattleSkipped[] = skipped.map((skip) => ({
    rule: skip.rule,
    condition: skip.text,
    why: skip.why,
    basis: skip.basis,
    text: skip.text,
  }));
  let reading = menu;
  for (const step of steps) {
    if (reading.actor !== situation.actor) {
      // Never press on: these would be someone else's commands (10-20).
      return "回合已经轮到别人" + note(passed);
    }
    if (step.action.command === "逃跑") {
      const escaped = await flee(pilot, FLEE_TIMEOUT_MS, { closeMenu: FLEE_CLOSE_MENU });
      if (escaped.fled) {
        runtime.done(step, snapshot, pilot.now());
        const action: gambit.Action = {
          command: "逃跑",
          ability: "",
          target: gambit.SELF,
          whom: null,
          enemy: null,
          rule: step.ruleIndex,
        };
        onAction(action);
        onDecision({
          action,
          condition: conditionFor(step, legacy, situation),
          basis: step.basis,
          text: step.text,
          skipped: [...tried],
          done: true,
          fled: true,
          fledSeconds: escaped.seconds,
        });
        return `逃跑成功(用了 ${secondsText(escaped.seconds)} 秒)` + note(passed);
      }
      const why = `逃跑失败:${escaped.reason}`;
      passed.push(why);
      if (step.ruleIndex > 0) {
        tried.push({
          rule: step.ruleIndex,
          condition: conditionFor(step, legacy, situation) || step.text,
          why,
          basis: step.basis,
          text: step.text,
        });
      }
      await backToCommands(pilot);
      continue;
    }
    if (step.effect === "revive" && !(step.target?.kind === "unit" && step.target.unit.hp <= 0)) {
      tried.push({
        rule: step.ruleIndex,
        condition: step.text,
        why: "没有倒下的人",
        basis: step.basis,
        text: step.text,
      });
      continue;
    }
    const action = stepAction(step, snapshot);
    try {
      const done = await attempt(pilot, reading, action, situation, onCast);
      runtime.done(step, snapshot, pilot.now());
      onAction(action);
      onDecision({
        action,
        condition: conditionFor(step, legacy, situation),
        basis: step.basis,
        text: step.text,
        skipped: [...tried],
        done: true,
      });
      const suffix = step.ruleIndex > 0 && step.source !== "fallback" ? "" : "(兜底)";
      return done + suffix + note(passed);
    } catch (error) {
      if (!(error instanceof CannotDo)) throw error;
      const label = `${step.action.command}:${step.action.ability}`.replace(/:$/u, "");
      const why = missingItemWhy(step, error.message) ?? `${label} ${error.message}`;
      passed.push(why);
      if (step.ruleIndex > 0) {
        tried.push({
          rule: step.ruleIndex,
          condition:
            conditionFor(step, legacy, situation) === ""
              ? step.text
              : conditionFor(step, legacy, situation),
          why,
          basis: step.basis,
          text: step.text,
        });
      }
      runtime.noteSkip(step, error.message, snapshot);
      await backToCommands(pilot);
    }
    reading = await waitFor(pilot, commandReady);
  }
  onDecision({
    action: {
      command: "攻击",
      ability: "",
      target: gambit.ENEMY,
      whom: null,
      enemy: null,
      rule: 0,
    },
    condition: "",
    basis: "兜底",
    text: "兜底:攻击",
    skipped: [...tried],
    done: false,
  });
  return "什么也没做成" + note(passed);
}

/** The old per-actor rule list behind a table, for the record's value-filled condition. */
function legacyRules(table: unknown, actor: string): readonly Reply[] | null {
  if (Array.isArray(table)) return records(table);
  if (!isRecord(table) || table.version === 2) return null;
  return records(gambit.normalize(table)[actor] ?? []);
}

/** A legacy rule's condition with this turn's values, as the record always showed it. */
function conditionFor(
  step: StrategyStep,
  legacy: readonly Reply[] | null,
  situation: gambit.Situation,
): string {
  if (legacy !== null && step.ruleIndex > 0) {
    const rule = legacy[step.ruleIndex - 1];
    const condition = isRecord(rule) ? rule.if : undefined;
    if (typeof condition === "string" && condition.trim() !== "") {
      try {
        return gambit.explain(condition, situation);
      } catch {
        return step.condition;
      }
    }
  }
  return step.condition;
}

/** The old action shape attempt() presses keys for, from a 2.0 step. */
function stepAction(step: StrategyStep, snapshot: BattleSnapshot): gambit.Action {
  const command = step.action.command;
  const ability = step.action.ability;
  let target = gambit.ENEMY;
  let whom: string | null = null;
  let enemy: number | null = null;
  if (step.target?.kind === "unit") {
    if (step.target.side === "ally") {
      target = gambit.SELF;
      whom = step.target.unit.name;
    } else {
      enemy = enemyIndex(snapshot, step.target.unit);
    }
  } else if (step.target?.kind === "all" && step.target.side === "enemy") {
    target = gambit.ENEMY;
  }
  if (step.effect === "revive") {
    target = gambit.FALLEN;
    if (whom === null && step.target?.kind === "unit" && step.target.side === "ally") {
      whom = step.target.unit.name;
    }
  } else if (step.effect === "cure") {
    target = gambit.AILING;
  } else if (step.effect === "heal") {
    target = gambit.WEAKEST;
  }
  return { command, ability, target, whom, enemy, rule: step.ruleIndex };
}

/** 「想用「眼药」治黑暗,包里没有」 for an item the bag ran out of; null for other failures. */
function missingItemWhy(step: StrategyStep, message: string): string | null {
  if (step.action.command !== "道具" || !message.startsWith("没有")) return null;
  const ability = step.action.ability;
  const ailment = step.effect === "cure" ? (cureAilmentOf(ability) ?? "") : "";
  return ailment === "" ? `想用「${ability}」,包里没有` : `想用「${ability}」治${ailment},包里没有`;
}

function note(passed: readonly string[]): string {
  return passed.length > 0 ? `(跳过:${passed.join(";")})` : "";
}

/**
 * Choose the command, the ability and the target; raises CannotDo when this action cannot
 * be done now (the caller then backs out to the command list).
 */
async function attempt(
  pilot: Pilot,
  initial: Reply,
  action: gambit.Action,
  situation: gambit.Situation,
  onCast: CastListener = () => undefined,
): Promise<string> {
  let menu = initial;
  let names = records(menu.commands).map((command) => text(command.name));
  let index = pick(names, action.command);
  const hidden = HIDDEN.get(action.command);
  if (index === null && hidden) {
    // Defend and row change sit behind Right / Left on the command list (10-20). With
    // several characters waiting the same key may move to another one instead (Galuf,
    // 10-20), so press once, and undo it when the command set did not change.
    const [key, state] = hidden;
    await pilot.send("keys", { keys: [key], gap: 120 });
    menu = await waitFor(pilot, (m) => m.commandState === state, 0.8);
    if (menu.commandState !== state) {
      const undo = UNDO.get(key);
      if (undo !== undefined) await pilot.send("keys", { keys: [undo], gap: 120 });
      await waitFor(pilot, ready, 0.8);
      throw new CannotDo(`按 ${key} 没有切出「${action.command}」`);
    }
    names = records(menu.commands).map((command) => text(command.name));
    index = pick(names, action.command);
  }
  if (index === null) {
    throw new CannotDo(`没有这个指令(有:${names.filter(Boolean).join("、")})`);
  }
  if (records(menu.commands)[index]?.enabled === false) {
    throw new CannotDo("现在不能用");
  }
  await moveCursor(pilot, num(menu.cursor) ?? 0, index);
  // A command opens a magic list or a target cursor (Defend does neither and ends the turn).
  // 10-20/task 41: `!ready` during the menu's transition used to end this wait early, so the
  // Enter that should have opened the item list was never pressed and the turn was lost.
  // A command that opens a list must see the list, not merely a menu that is not ready yet.
  const wantsList = action.command === "道具" || action.ability !== "";
  await pressUntil(
    pilot,
    "Enter",
    wantsList
      ? (m) => listOpen(m) || targetOpen(m)
      : (m) => listOpen(m) || targetOpen(m) || !ready(m),
    wantsList ? 1 : 3,
  );
  let used = names[index] ?? action.command;
  let castSpell = "";
  const target: EnemyResistances | null =
    action.target === gambit.ENEMY ? resistanceOf(situation, action.enemy) : null;
  if (action.ability && action.command === "道具") {
    used = `${used}:${await chooseItem(pilot, action.ability)}`;
  } else if (action.ability) {
    castSpell = await chooseAbility(
      pilot,
      action.ability,
      num(situation.me().mp),
      target,
      action.command,
    );
    used = `${used}:${castSpell}`;
  }
  // With the target cursor open the game has picked the enemy the spell will hit; remember
  // its HP so the next menu reading can tell an absorb (HP rose) from a normal hit.
  const aimed = await aim(pilot, action, situation);
  // A revive aimed at the wrong party member is worse than not acting at all (task 41).
  if (!aimed) throw new CannotDo(`没对准${action.whom ?? ""}`);
  const casts = castSpell ? castsFrom(await battleMenu(pilot), situation, castSpell) : [];
  // 防御 and 换列 have no target cursor and already ended the turn; pressing Enter here would
  // choose the next actor's highlighted command (10-20's class of bug, seen in task 34's tests).
  if (hidden === undefined) await pressUntil(pilot, "Enter", (m) => !targetOpen(m));
  if (casts.length > 0) onCast(casts);
  const enemyName =
    action.enemy === null
      ? ""
      : (text(aliveEnemyRows(situation.enemies)[action.enemy]?.name) ?? "");
  return used + (truthy(action.whom) ? `→${action.whom}` : enemyName !== "" ? `→${enemyName}` : "");
}

/** What the rules know about the chosen living enemy; the default cursor is the first one. */
function resistanceOf(situation: gambit.Situation, enemy: number | null): EnemyResistances | null {
  if (situation.elements === null) return null;
  const living = aliveEnemyRows(situation.enemies);
  const target = enemy === null ? living[0] : living[enemy];
  return target === undefined ? null : situation.elements.lookup(target);
}

function aliveEnemyRows(value: unknown): Reply[] {
  return records(value).filter((enemy) => (num(enemy.hp) ?? 0) > 0);
}

/** The enemies a just-opened target cursor is on, with the slot each occupies. */
function castsFrom(menu: Reply, situation: gambit.Situation, spell: string): ElementalCast[] {
  const element = gambit.elementOf(spell);
  if (element === null) return [];
  const state = record(menu.target).state;
  if (state !== "Enemys" && state !== "EnemyAll") return [];
  const inMenu = records(menu.enemies);
  const all = inMenu.length > 0 ? inMenu : records(situation.enemies);
  const enemies = aliveEnemyRows(all);
  const aimed =
    state === "EnemyAll"
      ? enemies.map((_enemy, index) => index)
      : [num(record(menu.target).cursor) ?? 0];
  const out: ElementalCast[] = [];
  for (const index of aimed) {
    const enemy = enemies[index];
    if (enemy === undefined) continue;
    out.push({
      element,
      name: text(enemy.name) ?? "",
      book: num(enemy.book) ?? null,
      // The cursor counts living enemies only; the bridge keeps dead ones in place, so the
      // index in the whole list follows this one enemy even when others die before it.
      slot: all.indexOf(enemy),
      beforeHp: num(enemy.hp) ?? 0,
    });
  }
  return out;
}

/** Compare remembered casts with this menu: an enemy whose HP rose absorbed that element. */
async function checkCasts(
  pending: readonly ElementalCast[],
  menu: Reply,
  elements: ElementLearner,
  learned: string[],
): Promise<void> {
  const enemies = records(menu.enemies);
  for (const cast of pending) {
    const target = castTarget(enemies, cast);
    if (target === undefined) continue;
    const after = num(target.hp) ?? 0;
    if (after <= cast.beforeHp) continue;
    // A rise against what the guide says (weak to it) is a mix-up, not an absorb.
    if (elements.lookup(target)?.weak.includes(cast.element) === true) continue;
    const note = await elements.learnAbsorb(target, cast.element);
    if (note !== null) learned.push(note);
  }
}

/**
 * The enemy the cast hit, if it is still there: the same slot holding the same monster. No
 * fallback to another of its kind (10-27: a Motor Trap died to Thunder, the next Motor Trap
 * with full HP was taken for it, and "陷阱机器人 吸收雷" was learned; the guide says weak).
 */
function castTarget(enemies: readonly Reply[], cast: ElementalCast): Reply | undefined {
  const bySlot = enemies[cast.slot];
  const alive = bySlot !== undefined && (num(bySlot.hp) ?? 0) > 0;
  return alive && sameEnemy(bySlot, cast) ? bySlot : undefined;
}

function sameEnemy(enemy: Reply, cast: ElementalCast): boolean {
  const book = num(enemy.book);
  if (cast.book !== null && book !== undefined) return book === cast.book;
  return (text(enemy.name) ?? "") === cast.name;
}

/** Drop what the target absorbs or is immune to, and put its elemental weaknesses first. */
function preferWeak(names: readonly string[], target: EnemyResistances | null): string[] {
  if (target === null) return [...names];
  const usable = names.filter((name) => {
    const element = gambit.elementOf(name);
    if (element === null) return true;
    return !target.absorb.includes(element) && !target.immune.includes(element);
  });
  const weak = usable.filter((name) => {
    const element = gambit.elementOf(name);
    return element !== null && target.weak.includes(element);
  });
  return [...weak, ...usable.filter((name) => !weak.includes(name))];
}

/**
 * Highlight `wanted` in the open magic list and press Enter; returns its name. The list is
 * a grid of every slot of the magic type, three to a row, unlearned ones blank (10-20);
 * `abilities` holds the slots in order and `abilityCursor` indexes them. The learned ones,
 * with their names, are `shown` (0.6.1+).
 */
export async function chooseAbility(
  pilot: Pilot,
  wanted: string,
  mp: number | undefined,
  target: EnemyResistances | null = null,
  command = "",
): Promise<string> {
  const menu = await waitFor(
    pilot,
    (m) => listOpen(m) && m.shown !== null && m.shown !== undefined,
  );
  const shownRaw = menu.shown;
  if (!listOpen(menu) || shownRaw === null || shownRaw === undefined) {
    throw new CannotDo("魔法列表没有打开(或桥插件早于 0.6.1)");
  }
  // A blank slot keeps the text it last drew (Lenna's list read 冰结, 10-20): only names
  // whose spell is one of this list's slots count.
  const slots = records(menu.abilities).map((ability) => ability.id);
  const shown = records(shownRaw).filter((entry) => slots.includes(entry.id));
  const names = shown.map((entry) => iconName(entry.name));
  // 「治疗+」「最强」 (gambit.abilityCandidates): the best one known and affordable. With a
  // target, elements it absorbs or is immune to are gone and its weaknesses come first.
  // Task 104: on the summon command the opened list is itself the summon list, so 最强 takes
  // its top entry (the game lists spells weakest first) whatever the Chinese names are.
  const bestSummon = command === "召唤" && wanted === gambit.BEST;
  const allKnown = bestSummon
    ? [...new Set(names)].reverse()
    : gambit
        .abilityCandidates(wanted, null, command)
        .filter((candidate) => names.includes(candidate));
  const known = bestSummon
    ? preferWeak([...new Set(names)].reverse(), target)
    : gambit
        .abilityCandidates(wanted, target, command)
        .filter((candidate) => names.includes(candidate));
  if (known.length === 0) {
    if (allKnown.length > 0 && target !== null) {
      throw new CannotDo(`目标${resistReason(allKnown, target)},不放这个属性`);
    }
    throw new CannotDo(`没学会(会的:${names.join("、") || "无"})`);
  }
  const affordable = known.filter((candidate) => {
    if (mp === undefined) return true;
    const cost = num(shown[names.indexOf(candidate)]?.mp) ?? 0;
    return cost <= mp;
  });
  if (affordable.length === 0) {
    const need = shown[names.indexOf(known[known.length - 1] ?? wanted)]?.mp;
    throw new CannotDo(`MP 不够(${show(need)} > ${show(mp)})`);
  }
  const k = names.indexOf(affordable[0] ?? wanted);
  const entry = shown[k];
  if (
    entry === undefined ||
    !(await steer(
      async () => num((await battleMenu(pilot)).abilityCursor) ?? null,
      async (key) => {
        await pilot.send("keys", { keys: [key], gap: 120 });
      },
      slots.indexOf(entry.id),
    ))
  ) {
    throw new CannotDo("光标移不过去");
  }
  await pressUntil(pilot, "Enter", targetOpen);
  return names[k] ?? wanted;
}

/** Why the known spells were all refused: 吸收冰、无效火. */
function resistReason(candidates: readonly string[], target: EnemyResistances): string {
  const absorbed = new Set<string>();
  const immune = new Set<string>();
  for (const spell of candidates) {
    const element = gambit.elementOf(spell);
    if (element === null) continue;
    if (target.absorb.includes(element)) absorbed.add(element);
    if (target.immune.includes(element)) immune.add(element);
  }
  const parts: string[] = [];
  if (absorbed.size > 0) parts.push(`吸收${[...absorbed].join("、")}`);
  if (immune.size > 0) parts.push(`无效${[...immune].join("、")}`);
  return parts.length > 0 ? parts.join("、") : "不吃这些属性";
}

/**
 * Highlight `wanted` in the open item list (bridge 0.6.2+: what is held, in list order,
 * and the cursor) and press Enter; returns its name.
 */
export async function chooseItem(pilot: Pilot, wanted: string): Promise<string> {
  let menu = await waitFor(pilot, (m) => m.itemState === "UseSelect" && truthy(m.items), 0.9);
  if (menu.itemState !== "UseSelect" || !truthy(menu.items)) {
    // The Enter that should have opened the list may have landed in its inputWait. Retry once,
    // and only from the command list: pressing Enter on a stray window chooses things.
    if (commandReady(await battleMenu(pilot))) {
      await pressUntil(pilot, "Enter", (m) => listOpen(m) || targetOpen(m), 1);
      menu = await waitFor(pilot, (m) => m.itemState === "UseSelect" && truthy(m.items), 0.9);
    }
  }
  if (menu.itemState !== "UseSelect" || !truthy(menu.items)) {
    throw new CannotDo("道具列表没有打开(或桥插件早于 0.6.2)");
  }
  const items = records(menu.items);
  const names = items.map((item) => iconName(item.name));
  const k = pick(names, wanted);
  if (k === null || (num(items[k]?.count) ?? 0) <= 0) {
    throw new CannotDo(`没有「${wanted}」`);
  }
  if (
    !(await steer(
      async () => num((await battleMenu(pilot)).itemCursor) ?? null,
      async (key) => {
        await pilot.send("keys", { keys: [key], gap: 120 });
      },
      k,
    ))
  ) {
    throw new CannotDo("光标移不过去");
  }
  await pressUntil(pilot, "Enter", targetOpen);
  return iconName(names[k]);
}

/**
 * Cancel out of a magic list or target cursor until the command list has the
 * keys. Only while one is open: on the command list itself the cancel key passes the turn to
 * the next character (10-20).
 */
export async function backToCommands(pilot: Pilot): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const menu = await waitFor(pilot, (m) => commandReady(m) || listOpen(m) || targetOpen(m), 1.0);
    if (commandReady(menu)) return;
    if (!(listOpen(menu) || targetOpen(menu))) return;
    await pilot.send("keys", { keys: ["Backspace"], gap: 150 });
  }
}

/**
 * Put the target cursor on the ally the rule names (bridge 0.6.0+). Enemies, and older
 * bridges, keep the game's default target.
 */
async function aim(
  pilot: Pilot,
  action: gambit.Action,
  situation: gambit.Situation,
): Promise<boolean> {
  if (action.enemy !== null) {
    const menu = await waitFor(pilot, targetOpen, 1.0);
    const state = record(menu.target).state;
    if (state === "EnemyAll") return true;
    if (state !== "Enemys") return false;
    return await steer(
      async () => num(record((await battleMenu(pilot)).target).cursor) ?? null,
      async (key) => {
        await pilot.send("keys", { keys: [key], gap: 120 });
      },
      action.enemy,
    );
  }
  if (action.target === gambit.ENEMY || action.whom === null) return true;
  const stateOf = (m: Reply): unknown => record(m.target).state;
  let menu = await waitFor(
    pilot,
    (m) => {
      const state = stateOf(m);
      return state !== null && state !== undefined && state !== "None";
    },
    1.0,
  );
  let state = stateOf(menu);
  if (state === null || state === undefined || state === "None") return false;
  for (const side of ["Right", "Left"]) {
    // from the enemies over to the party
    state = stateOf(menu);
    if (state !== "Enemys" && state !== "EnemyAll") break;
    await pilot.send("keys", { keys: [side], gap: 120 });
    menu = await battleMenu(pilot);
  }
  const row = situation.players.findIndex((player) => player.name === action.whom);
  if (row < 0) return false;
  return await steer(
    async () => num(record((await battleMenu(pilot)).target).cursor) ?? null,
    async (key) => {
      await pilot.send("keys", { keys: [key], gap: 120 });
    },
    row,
  );
}

/** Wait until this actor's command is in, so the next reading is someone else's turn. */
export async function turnOver(pilot: Pilot, actor: string): Promise<void> {
  await waitFor(pilot, (m) => !ready(m) || m.actor !== actor, 3.0);
}

/**
 * On a wipe screen, press confirm until the battle scene is gone. The game stops on a message
 * and waits for a key; 30 seconds at most, checking after each press so a later press cannot
 * skip a menu that has already opened.
 */
export async function passWipe(pilot: Pilot): Promise<boolean> {
  const deadline = pilot.now() + 30_000;
  while (pilot.now() < deadline) {
    await pilot.send("keys", { keys: ["Enter"], gap: 100 });
    await pilot.sleep(500);
    const menu = await battleMenu(pilot);
    if (!truthy(menu.battle)) return true;
  }
  return false;
}

/**
 * 11-03: in FF5 a wipe does not always end the game. The party is put back at the entrance of
 * the map (or the boss's map), and the title screen does not come back. Say where they are and
 * leave the save alone; only a real title screen is loaded.
 */
export async function wipeReport(pilot: Pilot, names: string, slot = 3): Promise<string> {
  const who = names === "" ? "未知敌人" : names;
  const pos = record((await pilot.send("pos")).pos);
  const state = text(pos.state) ?? "";
  let sample: Reply = {};
  let readError = "";
  try {
    sample = record((await pilot.query("sample")).sample);
  } catch (error) {
    // Cancellation belongs to dsh, not to a failed reading: let the tool boundary see it.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    readError = describeError(error);
  }
  const sampleBattle = record(sample.battle);
  if (truthy(pos.battle) || state === "Battle" || truthy(sampleBattle.active)) {
    return `全灭(敌人:${who}),按了确认还是停在战斗画面(状态 ${show(state || "读不到")}),没有读档`;
  }
  if (state === "GotoTitle" || state === "Init" || sceneStatus(sample) === "标题画面") {
    const [, loaded] = await loadGame(pilot, slot);
    return `全灭(敌人:${who}),游戏回到了标题画面;${loaded}`;
  }
  const mapId = num(pos.map) ?? num(record(sample.user).mapId);
  const cell = list(pos.cell);
  if (mapId !== undefined && cell.length >= 2) {
    const party = records(sample.party)
      .map((member) => {
        const marks = gambit.statuses(member);
        const status = marks.length > 0 ? `[${marks.join("、")}]` : "";
        return `${show(member.name)} ${show(member.hp)}/${show(member.maxHp)}${status}`;
      })
      .join("、");
    const team = party === "" ? "读不到队伍" : party;
    const read = readError === "" ? "" : `(读不到场景:${readError})`;
    return (
      `全灭(敌人:${who}),游戏把队伍放回了地图 ${show(mapId)} 的 ` +
      `(${cell.map(show).join(",")})${read};${team}。没有读档,` +
      "先把队伍回复,再考虑回城补给、换策略或练级。"
    );
  }
  const read = readError === "" ? "" : `;读不到场景:${readError}`;
  return `全灭(敌人:${who}),按了确认但没有回到地图(状态 ${show(state || "读不到")}${read}),也没有读档`;
}

/**
 * A regular battle and the patching up after it. The map's tactics fight it when the
 * player wrote some, else the default table (healers heal), with menu states from bridge
 * 0.6.0; older bridges leave it to the pilot agent's Enter presses on the laptop. A bad
 * battle moves the map to its next table.
 *
 * 11-03: a wipe in FF5 is not always a game over. In the 北山 cave (map 229) four members
 * wiped to three 风筝猫 and the scene stayed Battle; one or two confirms put them back at
 * (20,12), HP at 30-50% and still poisoned. The west valley goblins sent them to (15,68) at
 * full HP, and 玛基莎's boss battle to map 232 (38,13), full HP and cured. Saves and gil did
 * not change and the title never came back, so a wipe must not load: look at where the game
 * actually went (wipeReport) before deciding.
 */
export interface RegularOptions {
  /** 11-05 (go/explore flee): try to run before the rule table fights. */
  readonly flee?: boolean;
}

export async function regular(
  pilot: Pilot,
  hooks: BattleHooks = {},
  say: Say = () => undefined,
  slot = 3,
  options: RegularOptions = {},
): Promise<string> {
  const started = pilot.now();
  const startedAt = new Date().toISOString();
  if (!("menuState" in (await battleMenu(pilot)))) {
    const session = hooks.recorder?.start({
      mapId: null,
      mapName: "",
      boss: false,
      enemies: [],
      party: [],
      table: { kind: "manual", mapId: null },
      startedAt,
      startedMs: started,
    });
    const result = await pilot.send("battle", { timeout: 180000 }, 200_000);
    const detail = `本地战斗 ${show(result.seconds)} 秒`;
    await session?.finish(pilot.now(), truthy(result.ok) ? "ok" : "timeout", detail);
    return detail;
  }
  const sample = record((await pilot.query("sample")).sample);
  const mapId = num(record(sample.user).mapId) ?? null;
  const sampleBattle = record(sample.battle);
  const enemies = records(sampleBattle.enemies);
  const names = enemyNames(enemies);
  const boss = truthy(sampleBattle.boss) || enemies.some((enemy) => truthy(enemy.boss));
  const notEscape = truthy(sampleBattle.notEscape);
  const table = hooks.tableFor ? hooks.tableFor(mapId) : null;
  const which = truthy(table) ? "这张地图的策略" : "默认规则";
  const index = hooks.tableIndexFor?.(mapId) ?? null;
  const session = hooks.recorder?.start({
    mapId,
    mapName: placeName(sample),
    boss: false,
    enemies: battleUnits(enemies),
    party: battleUnits(records(sample.party)),
    table: truthy(table)
      ? { kind: "map", mapId, table: index === null ? null : index + 1 }
      : { kind: "default", mapId },
    startedAt,
    startedMs: started,
  });
  // 11-05: on the way through a map the party runs first; a boss or a notEscape formation is
  // fought with the rule table as usual.
  let fleeNote = "";
  if (options.flee === true) {
    if (boss) {
      fleeNote = "这场逃不了(首领战)";
    } else if (notEscape) {
      fleeNote = "这场逃不了(遇敌组 notEscape)";
    } else {
      const attempt = await flee(pilot, FLEE_TIMEOUT_MS, { closeMenu: FLEE_CLOSE_MENU });
      if (attempt.fled) {
        const detail = `逃跑成功(用了 ${secondsText(attempt.seconds)} 秒)`;
        await session?.finish(pilot.now(), "ok", detail);
        const note = hooks.report ? await hooks.report(mapId, "ok", detail) : "";
        return detail + (names === "" ? "" : `(敌人:${names})`) + (note ? `;${note}` : "");
      }
      fleeNote = `逃跑没成功(${attempt.reason})`;
    }
  }
  const result = await fight(
    pilot,
    truthy(table) ? table : gambit.defaultTable(records(sample.party)),
    300,
    () => undefined,
    hooks.elements ?? null,
    { record: session, instinct: hooks.instinct },
  );
  const foughtAt = pilot.now();
  if (result.fled === true) {
    const detail = `逃跑成功(用了 ${secondsText(result.fledSeconds ?? 0)} 秒)`;
    await session?.finish(foughtAt, "ok", detail);
    const note = hooks.report ? await hooks.report(mapId, "ok", detail) : "";
    return detail + (names === "" ? "" : `(敌人:${names})`) + (note ? `;${note}` : "");
  }
  if (result.error === "wiped") {
    await session?.finish(foughtAt, "wipe", "全员倒下");
    const note = hooks.report ? await hooks.report(mapId, "lost", "全员倒下") : "";
    const where = await wipeReport(pilot, names, slot);
    return where + (note ? `;${note}` : "");
  }
  const [verdict, judgeDetail] = await judge(pilot);
  const gaps = gapText(result.gaps);
  const detail = gaps === "" ? judgeDetail : `${judgeDetail};${gaps}`;
  const outcome =
    result.error === "timeout"
      ? "timeout"
      : verdict === "lost"
        ? "wipe"
        : verdict === "hard"
          ? "hard"
          : "ok";
  await session?.finish(foughtAt, outcome, result.error === "timeout" ? "战斗超时" : detail);
  const note = hooks.report ? await hooks.report(mapId, verdict, detail) : "";
  if (verdict === "lost") {
    const where = await wipeReport(pilot, names, slot);
    return where + (note ? `;${note}` : "");
  }
  const healed = await patchUp(pilot, say, 4, hooks.onIncident, hooks.heal);
  let message = `按${which}打完 ${show(pyRound((pilot.now() - started) / 1000, 0))} 秒(敌人:${names};${detail})`;
  if (!truthy(result.ok)) message = `战斗没打完:${show(result.error)}`;
  if (fleeNote !== "") message = `${fleeNote},${message}`;
  return (
    message +
    (result.learned.length > 0 ? `;${result.learned.join(";")}` : "") +
    (healed.length > 0 ? "," + healed.join(";") : "") +
    (gaps === "" ? "" : `;${gaps}`) +
    (note ? `;${note}` : "")
  );
}

/**
 * How the battle went, from the party afterwards: lost (everyone down), hard (someone
 * down, or under 40% of the party's HP), or ok.
 */
export async function judge(pilot: Pilot): Promise<[string, string]> {
  return judgePlayers(records(record((await pilot.query("sample")).sample).party));
}

/** The same verdict from rows the fight already read, so recording needs no extra query. */
export function judgePlayers(party: readonly Reply[]): [string, string] {
  if (party.length === 0) return ["ok", "读不到队伍"];
  const down = party
    .filter((member) => (num(member.hp) ?? 0) <= 0)
    .map((member) => show(member.name));
  const total = party.reduce((sum, member) => sum + (num(member.hp) ?? 0), 0);
  const top = party.reduce((sum, member) => sum + (num(member.maxHp) ?? 0), 0) || 1;
  if (down.length === party.length) return ["lost", "全员倒下"];
  if (down.length > 0) return ["hard", `${down.join("、")}倒下`];
  const percent = Math.floor((100 * total) / top);
  if (total / top < 0.4) return ["hard", `全队 HP 只剩 ${percent}%`];
  return ["ok", `全队 HP ${percent}%`];
}

/** Task 91: how much HP a spell is expected to restore per MP, for choosing 治疗 or 救疗. */
const HEAL_PER_MP = 12;
const DEFAULT_HEAL_COST: Readonly<Record<string, number>> = { 治疗: 4, 救疗: 8 };
const HEAL_SPELLS: readonly string[] = ["治疗", "救疗"];
const HEAL_ITEMS: readonly string[] = ["恢复药", "高级恢复药", "Potion", "Hi-Potion"];
const TENT_ITEMS: readonly string[] = ["帐篷", "小屋", "Tent", "Cottage"];

/** Task 91's after-battle and pre-boss healing knobs (Config; the defaults are the request's). */
export interface PatchUpOptions {
  /** Heal anyone below this HP percentage (70 by default). */
  readonly hpTarget?: number;
  /** Keep at least this share of a caster's max MP (30 by default); 0 before a boss/save point. */
  readonly mpReservePercent?: number;
  /** Use a healing item only below this HP percentage (40 by default). */
  readonly itemHpPercent?: number;
  /** At a save point a tent/cottage may restore everyone, MP included. */
  readonly allowTent?: boolean;
}

interface HealChoice {
  readonly caster: string;
  readonly spell: string;
  readonly cost: number;
}

/**
 * Task 91: after a battle (the table's after_battle, §4.6) bring the party back over the HP
 * threshold with the cheapest white magic that covers the gap, keeping a share of the caster's
 * MP. When no spell can be used (or only the reserve is left) a healing item is used below the
 * lower threshold. Ailments are cured as before.
 */
export async function patchUp(
  pilot: Pilot,
  say: Say = () => undefined,
  casts = 4,
  report?: (message: string) => void,
  options: PatchUpOptions = {},
): Promise<string[]> {
  await pilot.send("wait", { timeout: 30000 }, 40_000);
  const done: string[] = [];
  const hpTarget = options.hpTarget ?? 70;
  for (let i = 0; i < casts; i++) {
    const party = await partyState(pilot);
    const hurt = party.filter((member) => (num(member.hp) ?? 0) > 0 && pct(member) < hpTarget);
    if (hurt.length === 0) break;
    const weakest = lowestOf(hurt);
    const choice = chooseHeal(party, weakest, options);
    if (choice === null) break;
    const [ok, message] = await cast(pilot, choice.caster, choice.spell, show(weakest?.name));
    done.push(message);
    say(`  ${message}`);
    if (!ok) break;
  }
  // Task 91: at a save point a tent/cottage is the one item that also restores MP. Use it when
  // the magic above could not reach the target or the party's MP is low.
  if (options.allowTent === true) {
    const party = await partyState(pilot);
    const lowHp = party.some((member) => (num(member.hp) ?? 0) > 0 && pct(member) < hpTarget);
    const lowMp = party.some((member) => {
      const max = num(member.maxMp) ?? 0;
      return max > 0 && (num(member.mp) ?? 0) < max * 0.3;
    });
    if (lowHp || lowMp) {
      const held = await heldItems(pilot);
      const tent = TENT_ITEMS.find((name) =>
        Object.entries(held).some(([item, count]) => count > 0 && holds(item, name)),
      );
      const patient = show(party[0]?.name);
      if (tent !== undefined) {
        const [ok, message] = await useItem(pilot, tent, patient, report);
        done.push(message);
        say(`  ${message}`);
        if (!ok) return done;
      }
    }
  }
  // Task 91: no magic (or only the reserved MP) left: a healing item is spent only under the
  // lower threshold, so potions are not burned on a scratch.
  const itemTarget = options.itemHpPercent ?? 40;
  for (let i = 0; i < casts; i++) {
    const party = await partyState(pilot);
    const hurt = party.filter((member) => (num(member.hp) ?? 0) > 0 && pct(member) < itemTarget);
    if (hurt.length === 0) break;
    const weakest = lowestOf(hurt);
    const held = await heldItems(pilot);
    const item = HEAL_ITEMS.find((name) =>
      Object.entries(held).some(([item, count]) => count > 0 && holds(item, name)),
    );
    if (item === undefined) break;
    const [ok, message] = await useItem(pilot, item, show(weakest?.name), report);
    done.push(message);
    say(`  ${message}`);
    if (!ok) break;
  }
  // Ailments that stay after a battle (poison, blindness, ...): the white magic when someone
  // has it and MP, else the cure item (10-27: Eye Drops sat in the bag unused).
  for (const [ailment, [spell, item]] of Object.entries(gambit.CURES)) {
    for (let i = 0; i < casts; i++) {
      const party = await partyState(pilot);
      const ailing = party.filter((member) =>
        gambit.statuses(member).some((status) => status.includes(ailment)),
      );
      if (ailing.length === 0) break;
      const patient = show(ailing[0]?.name);
      let outcome: [boolean, string] | null = null;
      if (spell !== null) {
        const healers = party.filter(
          (member) =>
            member.jobName === "白魔法师" &&
            (num(member.hp) ?? 0) > 0 &&
            (num(member.mp) ?? 0) >= 2,
        );
        if (healers.length > 0) {
          outcome = await cast(pilot, show(healers[0]?.name), spell, patient);
        }
      }
      if (!outcome?.[0] && item !== "") {
        const held = await heldItems(pilot);
        if (Object.entries(held).some(([name, count]) => count > 0 && holds(name, item))) {
          outcome = await useItem(pilot, item, patient, report);
        }
      }
      if (outcome === null) break;
      done.push(outcome[1]);
      say(`  ${outcome[1]}`);
      if (!outcome[0]) break;
    }
  }
  return done;
}

/** The lowest-HP member, the one to heal first. */
function lowestOf(members: readonly Reply[]): Reply | undefined {
  let weakest = members[0];
  for (const member of members.slice(1)) {
    if (weakest !== undefined && pct(member) < pct(weakest)) weakest = member;
  }
  return weakest;
}

/** What one caster can cast from the 治疗 family, with the MP the bridge reports when known. */
function healSpellsOf(member: Reply): { spell: string; cost: number }[] {
  const found: { spell: string; cost: number }[] = [];
  for (const ability of records(member.abilities)) {
    const name = iconName(ability.name);
    if (!HEAL_SPELLS.includes(name)) continue;
    found.push({ spell: name, cost: num(ability.mp) ?? DEFAULT_HEAL_COST[name] ?? 0 });
  }
  for (const value of list(member.spells)) {
    const name = iconName(value);
    if (!HEAL_SPELLS.includes(name) || found.some((entry) => entry.spell === name)) continue;
    found.push({ spell: name, cost: DEFAULT_HEAL_COST[name] ?? 0 });
  }
  // An older bridge has no spell list at all. A white mage is assumed to know only 治疗, the
  // spell the old patchUp always tried; guessing 救疗 would cast at a menu that lacks it.
  if (found.length === 0 && member.jobName === "白魔法师") {
    found.push({ spell: "治疗", cost: DEFAULT_HEAL_COST["治疗"] ?? 4 });
  }
  return found;
}

/**
 * The cheapest spell whose expected healing covers the gap, else the cheapest one left. A
 * caster must still hold the reserve afterwards, so a nearly empty white mage does not cast.
 */
function chooseHeal(
  party: readonly Reply[],
  patient: Reply | undefined,
  options: PatchUpOptions,
): HealChoice | null {
  if (patient === undefined) return null;
  const gap = Math.max(0, (num(patient.maxHp) ?? 0) - (num(patient.hp) ?? 0));
  const reservePercent = options.mpReservePercent ?? 30;
  const choices: (HealChoice & { heal: number; mp: number })[] = [];
  for (const member of party) {
    if ((num(member.hp) ?? 0) <= 0) continue;
    const mp = num(member.mp) ?? 0;
    const maxMp = num(member.maxMp) ?? 0;
    const reserve = maxMp * (reservePercent / 100);
    for (const spell of healSpellsOf(member)) {
      if (mp - spell.cost < reserve) continue;
      choices.push({
        caster: show(member.name),
        spell: spell.spell,
        cost: spell.cost,
        heal: spell.cost * HEAL_PER_MP,
        mp,
      });
    }
  }
  if (choices.length === 0) return null;
  const covering = choices.filter((choice) => choice.heal >= gap);
  const pool = covering.length > 0 ? covering : choices;
  pool.sort(
    (left, right) =>
      left.cost - right.cost || right.mp - left.mp || left.spell.localeCompare(right.spell),
  );
  const best = pool[0];
  return best === undefined ? null : { caster: best.caster, spell: best.spell, cost: best.cost };
}

/** Whether a bag name and the wanted item name mean the same item (icon tags already gone). */
function holds(name: string, item: string): boolean {
  return name.includes(item) || item.includes(name);
}

/** Python's gambit.pct: HP as a percentage of max HP. */
function pct(unit: Reply): number {
  const top = num(unit.maxHp) ?? 0;
  return top ? (100.0 * (num(unit.hp) ?? 0)) / top : 100.0;
}
