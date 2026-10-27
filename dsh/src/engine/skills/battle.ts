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
import { isRecord, num, pyRound, records, record, text, truthy } from "../values.ts";
import type { Element, ElementLearner, EnemyResistances } from "../elements.ts";
import { moveCursor, pick, steer } from "./cursor.ts";
import * as gambit from "./gambit.ts";
import { cast, partyState, useItem } from "./menu.ts";
import { loadGame } from "./save.ts";

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

/** The Game's hooks: the table in use for a map's monsters, where the result goes, and what
 * battles learned about enemy elements. */
export interface BattleHooks {
  tableFor?: (mapId: number | null) => unknown;
  report?: (mapId: number | null, verdict: string, detail: string) => string | Promise<string>;
  elements?: ElementLearner;
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
): Promise<FightResult> {
  const table = gambit.normalize(plan);
  const deadline = pilot.now() + timeout * 1000;
  const turns: string[] = [];
  const learned: string[] = [];
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
    if (!truthy(menu.battle)) return { ok: true, turns, learned };
    if (!ready(menu)) {
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
    const rules = table[actor];
    const chosen = rules !== undefined && rules.length > 0 ? records(rules) : [{ do: "攻击" }];
    const done = await act(pilot, menu, chosen, situation, (casts) => {
      pending.push(...casts);
    });
    if (done.startsWith("道具:")) {
      const item = iconName((done.slice("道具:".length).split("→")[0] ?? "").split("(")[0] ?? "");
      ordered.set(item, (ordered.get(item) ?? 0) + 1);
    }
    turns.push(`${actor}→${done}`);
    say(`  ${actor}:${done}`);
    await turnOver(pilot, actor);
    idleSince = pilot.now();
  }
  return { ok: false, error: "timeout", turns, learned };
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
  if (players === null || players === undefined) {
    // bridge before 0.6.0: the sample has both sides
    const battle = record(record((await pilot.query("sample")).sample).battle);
    players = battle.players;
    enemies = battle.enemies;
  }
  const playerRows = records(players);
  const enemyRows = records(enemies);
  const boss = enemyRows.some((enemy) => truthy(enemy.boss));
  let items = await heldItems(pilot);
  if (Object.keys(bag).length > 0 && Object.keys(ordered).length > 0) {
    const reduced: Record<string, number> = {};
    for (const [name, count] of Object.entries(items)) {
      const remaining = Math.max(0, Math.min(count, (bag[name] ?? count) - (ordered[name] ?? 0)));
      reduced[name] = remaining;
    }
    items = reduced;
  }
  return new gambit.Situation(actor, playerRows, enemyRows, turn, boss, items, elements);
}

/** This rule cannot be done now (the reason is the message); try the next one. */
export class CannotDo extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CannotDo";
  }
}

/**
 * Do the first rule that can be done; returns what was done, with why earlier rules were
 * passed over.
 */
export async function act(
  pilot: Pilot,
  menu: Reply,
  rules: readonly Reply[],
  situation: gambit.Situation,
  onCast: CastListener = () => undefined,
): Promise<string> {
  const skip = new Set<number>();
  const passed: string[] = [];
  let reading = menu;
  for (let i = 0; i < rules.length + 1; i++) {
    if (reading.actor !== situation.actor) {
      // Never press on: these would be someone else's commands (10-20).
      return "回合已经轮到别人" + note(passed);
    }
    const action = gambit.choose(rules, situation, skip);
    try {
      const done = await attempt(pilot, reading, action, situation, onCast);
      return (action.rule ? done : `${done}(兜底)`) + note(passed);
    } catch (error) {
      if (!(error instanceof CannotDo)) throw error;
      const label = `${action.command}:${action.ability}`.replace(/:$/, "");
      if (
        action.command === "道具" &&
        action.target === gambit.AILING &&
        error.message.startsWith("没有")
      ) {
        const rule = rules[action.rule - 1];
        const ailment = rule === undefined ? "" : gambit.ailmentOf(rule);
        passed.push(`想用「${action.ability}」治${ailment},包里没有`);
      } else {
        passed.push(`${label} ${error.message}`);
      }
      await backToCommands(pilot);
    }
    if (action.rule === 0) break;
    skip.add(action.rule);
    reading = await waitFor(pilot, ready);
  }
  return "什么也没做成" + note(passed);
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
  await pressUntil(pilot, "Enter", (m) => listOpen(m) || targetOpen(m) || !ready(m));
  let used = names[index] ?? action.command;
  let castSpell = "";
  const target: EnemyResistances | null =
    action.target === gambit.ENEMY ? resistanceOf(situation, action.enemy) : null;
  if (action.ability && action.command === "道具") {
    used = `${used}:${await chooseItem(pilot, action.ability)}`;
  } else if (action.ability) {
    castSpell = await chooseAbility(pilot, action.ability, num(situation.me().mp), target);
    used = `${used}:${castSpell}`;
  }
  // With the target cursor open the game has picked the enemy the spell will hit; remember
  // its HP so the next menu reading can tell an absorb (HP rose) from a normal hit.
  const aimed = await aim(pilot, action, situation);
  const casts = castSpell ? castsFrom(await battleMenu(pilot), situation, castSpell) : [];
  await pressUntil(pilot, "Enter", (m) => !targetOpen(m));
  if (casts.length > 0) onCast(casts);
  const enemyName =
    action.enemy === null
      ? ""
      : (text(aliveEnemyRows(situation.enemies)[action.enemy]?.name) ?? "");
  const aimedNote = aimed ? "" : `(没对准${enemyName || "目标"})`;
  return (
    used +
    (truthy(action.whom) ? `→${action.whom}` : enemyName !== "" ? `→${enemyName}` : "") +
    aimedNote
  );
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
  const allKnown = gambit
    .abilityCandidates(wanted)
    .filter((candidate) => names.includes(candidate));
  const known = gambit
    .abilityCandidates(wanted, target)
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
  const menu = await waitFor(pilot, (m) => m.itemState === "UseSelect" && truthy(m.items));
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
    const menu = await waitFor(pilot, (m) => ready(m) || listOpen(m) || targetOpen(m), 1.0);
    if (ready(menu) || !(listOpen(menu) || targetOpen(menu))) return;
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
  if (state === null || state === undefined || state === "None") return true;
  for (const side of ["Right", "Left"]) {
    // from the enemies over to the party
    state = stateOf(menu);
    if (state !== "Enemys" && state !== "EnemyAll") break;
    await pilot.send("keys", { keys: [side], gap: 120 });
    menu = await battleMenu(pilot);
  }
  const row = situation.players.findIndex((player) => player.name === action.whom);
  if (row >= 0) {
    await steer(
      async () => num(record((await battleMenu(pilot)).target).cursor) ?? null,
      async (key) => {
        await pilot.send("keys", { keys: [key], gap: 120 });
      },
      row,
    );
  }
  return true;
}

/** Wait until this actor's command is in, so the next reading is someone else's turn. */
export async function turnOver(pilot: Pilot, actor: string): Promise<void> {
  await waitFor(pilot, (m) => !ready(m) || m.actor !== actor, 3.0);
}

/**
 * A regular battle and the patching up after it. The map's tactics fight it when the
 * player wrote some, else the default table (healers heal), with menu states from bridge
 * 0.6.0; older bridges leave it to the pilot agent's Enter presses on the laptop. A wipe
 * loads the last save; a bad battle moves the map to its next table.
 */
export async function regular(
  pilot: Pilot,
  hooks: BattleHooks = {},
  say: Say = () => undefined,
  slot = 3,
): Promise<string> {
  const started = pilot.now();
  if (!("menuState" in (await battleMenu(pilot)))) {
    const result = await pilot.send("battle", { timeout: 180000 }, 200_000);
    return `本地战斗 ${show(result.seconds)} 秒`;
  }
  const sample = record((await pilot.query("sample")).sample);
  const mapId = num(record(sample.user).mapId) ?? null;
  const names = [
    ...new Set(
      records(record(sample.battle).enemies)
        .map((enemy) => text(enemy.name))
        .filter((name): name is string => name !== undefined),
    ),
  ].join("、");
  const table = hooks.tableFor ? hooks.tableFor(mapId) : null;
  const which = truthy(table) ? "这张地图的策略" : "默认规则";
  const result = await fight(
    pilot,
    truthy(table) ? table : gambit.defaultTable(records(sample.party)),
    300,
    () => undefined,
    hooks.elements ?? null,
  );
  const [verdict, detail] = await judge(pilot);
  const note = hooks.report ? await hooks.report(mapId, verdict, detail) : "";
  if (verdict === "lost") {
    const [, loaded] = await loadGame(pilot, slot);
    return `全灭(敌人:${names}),${loaded}` + (note ? `;${note}` : "");
  }
  const healed = await patchUp(pilot, say);
  let message = `按${which}打完 ${show(pyRound((pilot.now() - started) / 1000, 0))} 秒(敌人:${names};${detail})`;
  if (!truthy(result.ok)) message = `战斗没打完:${show(result.error)}`;
  return (
    message +
    (result.learned.length > 0 ? `;${result.learned.join(";")}` : "") +
    (healed.length > 0 ? "," + healed.join(";") : "") +
    (note ? `;${note}` : "")
  );
}

/**
 * How the battle went, from the party afterwards: lost (everyone down), hard (someone
 * down, or under 40% of the party's HP), or ok.
 */
export async function judge(pilot: Pilot): Promise<[string, string]> {
  const party = records(record((await pilot.query("sample")).sample).party);
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

/**
 * After a battle (the table's after_battle, §4.6): a white mage casts 治疗 on whoever is
 * under half HP, the lowest first, then 解毒 on whoever is poisoned, while MP lasts.
 * Returns what was cast.
 */
export async function patchUp(
  pilot: Pilot,
  say: Say = () => undefined,
  casts = 4,
): Promise<string[]> {
  await pilot.send("wait", { timeout: 30000 }, 40_000);
  const done: string[] = [];
  for (let i = 0; i < casts; i++) {
    const party = await partyState(pilot);
    const hurt = party.filter((member) => (num(member.hp) ?? 0) > 0 && pct(member) < 50);
    const healers = party.filter(
      (member) =>
        member.jobName === "白魔法师" && (num(member.hp) ?? 0) > 0 && (num(member.mp) ?? 0) >= 4,
    );
    if (hurt.length === 0 || healers.length === 0) break;
    let weakest = hurt[0];
    for (const member of hurt.slice(1)) {
      if (weakest !== undefined && pct(member) < pct(weakest)) weakest = member;
    }
    const [ok, message] = await cast(pilot, show(healers[0]?.name), "治疗", show(weakest?.name));
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
          outcome = await useItem(pilot, item, patient);
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

/** Whether a bag name and the wanted item name mean the same item (icon tags already gone). */
function holds(name: string, item: string): boolean {
  return name.includes(item) || item.includes(name);
}

/** Python's gambit.pct: HP as a percentage of max HP. */
function pct(unit: Reply): number {
  const top = num(unit.maxHp) ?? 0;
  return top ? (100.0 * (num(unit.hp) ?? 0)) / top : 100.0;
}
