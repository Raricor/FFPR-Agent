/**
 * The tool side of the DeepSeek player: runs each tool through the skills and describes what
 * the player sees afterwards. Notes the model keeps survive between runs. Ported from
 * ffpr_agent/ds/game.py; control plan §4.8–§4.11 and §10.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Laptop } from "./laptop.ts";
import { MonsterCache } from "./bestiary.ts";
import { Atlas } from "./atlas.ts";
import { Elements } from "./elements.ts";
import { byKey } from "./games.ts";
import { DEPS } from "./paths.ts";
import {
  areaOf,
  buildFacts,
  chooseTrigger,
  isTown,
  type FactsTrigger,
  type TacticianPlan,
} from "./facts.ts";
import { describeError, isMissingFile } from "./errors.ts";
import { KeyEvents } from "./events.ts";
import { Guide } from "./guide/kb.ts";
import { MAX_NOTES, loadNotes } from "./notes.ts";
import type { Pilot } from "./pilot.ts";
import { describeBattle, FLOOR_MARKS, renderFloor, renderTerrain } from "./prompt.ts";
import { Tactics } from "./tactics.ts";
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
import * as gambit from "./skills/gambit.ts";
import * as menu from "./skills/menu.ts";
import * as move from "./skills/move.ts";
import * as battle from "./skills/battle.ts";
import type { BattleHooks } from "./skills/battle.ts";
import type { MoveState } from "./skills/move.ts";
import * as save from "./skills/save.ts";
import * as screens from "./skills/screens.ts";
import * as shop from "./skills/shop.ts";
import { cursorPath, stateScript, parseState } from "./state-script.ts";
import * as nav from "./nav.ts";
import type { Cell } from "./nav.ts";
import * as view from "./view.ts";

export const GEAR: ReadonlySet<string> = new Set(["Weapon", "Armor"]); // bridge 0.6.8
export const WORLD_EXIT = "ワールドマップ"; // events by this name take the party out to the world map
export const TOWN_WORDS: readonly string[] = ["宿屋", "武器", "防具", "魔法屋", "道具屋"];

// The guides name items in English; CURES names them as the Chinese game does.
const CURE_ITEM_EN: Readonly<Record<string, readonly string[]>> = {
  解毒药: ["Antidote"],
  眼药: ["Eye Drops"],
  金针: ["Gold Needle"],
  少女之吻: ["Maiden's Kiss"],
  木槌: ["Mallet"],
  回音草: ["Echo Herbs", "Echo Grass"],
};

/** The shop the guide says sells `item` in this area (where it is), or "" when it knows none. */
export function shopSelling(guide: Guide | null, area: string, item: string): string {
  if (guide === null || area === "" || item === "") return "";
  const aliases = CURE_ITEM_EN[item] ?? [item];
  for (const section of guide.sectionsFor(area).slice(0, 1)) {
    for (const table of section.shops ?? []) {
      const sells = table.goods.some((good) =>
        aliases.some((alias) => good.name.toLowerCase().includes(alias.toLowerCase())),
      );
      if (sells) return table.where || section.title;
    }
  }
  return "";
}

export interface GameOptions {
  readonly laptop: Laptop;
  readonly game: string;
  /** save_game writes this slot and a wipe loads it; slot 20 for all six games (10-29). */
  readonly saveSlot: number;
  readonly notesFile?: string;
  readonly events?: KeyEvents;
  readonly atlasFile?: string;
  readonly tacticsFile?: string;
  readonly elementsFile?: string;
  readonly signal?: AbortSignal;
  /** The second layer, when this build has one: facts in, a plan back. */
  readonly tactician?: (facts: string) => Promise<TacticianPlan>;
  /** Let the tactician write and the code fight a boss battle (default true). */
  readonly tacticianBoss?: boolean;
}

interface HandlerResult {
  readonly text: string;
  /** The Python handler returned before settle/chart/hints (remember, guide, refusals). */
  readonly early?: boolean;
}

type ToolHandler = (args: Json, pilot: Pilot) => Promise<HandlerResult>;

const EARLY_GUIDE = "攻略知识库还没有准备好(要先运行 ffpr-guide fetch)";

/** Python's str() for values the messages embed, so a missing field reads "None". */
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

/** Python's int() for the values the model sends; a bad value is a tool error in Chinese. */
function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`不是整数:${show(value)}`);
  return Math.trunc(parsed);
}

function cellOf(value: unknown): Cell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

async function fileExists(path: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await readFile(path, { signal });
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    signal?.throwIfAborted();
    throw new Error(`读不了 ${path}:${describeError(error)}`, { cause: error });
  }
}

export async function saveNotes(path: string | undefined, notes: readonly string[]): Promise<void> {
  if (path === undefined) return;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, JSON.stringify(notes, null, 1), "utf8");
  } catch (error) {
    throw new Error(`写不了笔记文件 ${path}:${describeError(error)}`, { cause: error });
  }
}

/** The last boss table a tactician wrote, for the sidebar's strategy page. */
export interface BossPlanRecord {
  readonly mapId: number;
  readonly table: Json;
  readonly result: string;
  readonly at: string;
}

/** The tool side: runs each tool through the pilot and describes what the player now sees. */
export class Game {
  readonly laptop: Laptop;
  readonly game: string;
  readonly saveSlot: number;
  readonly notesFile: string | undefined;
  readonly events: KeyEvents | undefined;
  readonly atlas: Atlas;
  readonly tactics: Tactics;
  readonly elements: Elements;
  readonly guide: Guide | null;
  readonly advised = new Set<string>();
  readonly moveState: MoveState = { drake: null };
  readonly hooks: BattleHooks;
  /** Static monster data shared by the fact sheet and the strategy page. */
  readonly monsterCache = new MonsterCache();
  notes: string[] = [];
  savePoint: Cell | null = null; // on the current map, if it has one
  gear: Record<string, number> | null = null; // weapons and armour in the bag, last look
  mapId: number | null = null;
  town: number | null = null; // the town map last hinted about
  ailmentCombo: string | null = null; // the uncured-ailment group last hinted about
  ailmentMap: number | null = null; // the map it was hinted on
  readonly tacticianBoss: boolean;
  private tactician: ((facts: string) => Promise<TacticianPlan>) | undefined;
  private tacticianCalled = false; // one call per tool invocation (task 10)
  private readonly blockedCounts = new Map<string, number>(); // map+cell → times blocked
  private blocked: { count: number; detail: string } | null = null;
  private ride: string | null = null;
  private lastBattle: { mapId: number | null; verdict: string; detail: string } | null = null;
  private lastBoss: BossPlanRecord | null = null;
  private readonly tacticianInfoByMap = new Map<number, { walkerNotes: string; askUp: string }>();
  private readonly handlers: ReadonlyMap<string, ToolHandler>;

  private constructor(
    laptop: Laptop,
    game: string,
    saveSlot: number,
    notesFile: string | undefined,
    events: KeyEvents | undefined,
    atlas: Atlas,
    tactics: Tactics,
    elements: Elements,
    guide: Guide | null,
    tactician: ((facts: string) => Promise<TacticianPlan>) | undefined,
    tacticianBoss: boolean,
  ) {
    this.laptop = laptop;
    this.game = game;
    this.saveSlot = saveSlot;
    this.notesFile = notesFile;
    this.events = events;
    this.atlas = atlas;
    this.tactics = tactics;
    this.elements = elements;
    this.guide = guide;
    this.tactician = tactician;
    this.tacticianBoss = tacticianBoss;
    // The player's tactics per map fight the regular battles (control plan §4.10).
    this.hooks = {
      tableFor: (mapId) => this.tactics.current(mapId),
      report: async (mapId, verdict, detail) => {
        this.lastBattle = { mapId, verdict, detail };
        return await this.tactics.record(mapId, verdict, detail);
      },
      elements: this.elements,
    };
    this.moveState.battle = this.hooks;
    this.moveState.saveSlot = this.saveSlot;
    this.moveState.link = (mapId, from, to, how) => this.atlas.link(mapId, from, to, how);
    this.handlers = new Map<string, ToolHandler>([
      ["walk_to", (args, pilot) => this.travel(args, pilot)],
      ["go_to", (args, pilot) => this.travel(args, pilot)],
      ["terrain", (args, pilot) => this.toolTerrain(args, pilot)],
      ["entrances", (_args, pilot) => this.toolEntrances(pilot)],
      ["look_around", (_args, pilot) => this.toolLookAround(pilot)],
      ["interact", (args, pilot) => this.toolInteract(args, pilot)],
      ["advance_story", (_args, pilot) => this.toolAdvanceStory(pilot)],
      ["press", (args, pilot) => this.toolPress(args, pilot)],
      ["choose", (args, pilot) => this.toolChoose(args, pilot)],
      ["fight", (args, pilot) => this.toolFight(args, pilot)],
      ["sell", (args, pilot) => this.toolSell(args, pilot)],
      ["shop_gear", (_args, pilot) => this.toolShopGear(pilot)],
      ["buy", (args, pilot) => this.toolBuy(args, pilot)],
      ["cast", (args, pilot) => this.toolCast(args, pilot)],
      ["use_item", (args, pilot) => this.toolUseItem(args, pilot)],
      ["change_job", (args, pilot) => this.toolChangeJob(args, pilot)],
      ["leave_menu", (_args, pilot) => this.toolLeaveMenu(pilot)],
      ["save_game", (_args, pilot) => this.toolSaveGame(pilot)],
      ["land", (_args, pilot) => this.toolLand(pilot)],
      ["board", (_args, pilot) => this.toolBoard(pilot)],
      ["optimize_equipment", (_args, pilot) => this.toolOptimizeEquipment(pilot)],
      ["set_tactics", (args, pilot) => this.toolSetTactics(args, pilot)],
      ["guide", (args) => this.toolGuide(args)],
      ["atlas", (_args, pilot) => this.toolAtlas(pilot)],
      ["inventory", (_args, pilot) => this.toolInventory(pilot)],
      ["remember", (args) => this.toolRemember(args)],
      ["forget", (args) => this.toolForget(args)],
    ]);
  }

  static async create(options: GameOptions): Promise<Game> {
    const signal = options.signal;
    const game = byKey(options.game).key;
    const atlas = await Atlas.load(options.atlasFile, signal);
    const tactics = await Tactics.load(options.tacticsFile, signal);
    // The guide knowledge is FF5's (.deps/knowledge/ff5): using it for another game would give
    // that game FF5's shops and monster notes under the same names.
    const guide = game === "ff5" ? await Guide.load(undefined, signal) : null;
    const elementsFile =
      options.elementsFile ??
      (game === "ff5" ? undefined : join(DEPS, "ds", `elements-${game}.json`));
    const elements = await Elements.load(
      elementsFile,
      guide?.ludo ?? [],
      signal,
      guide?.bestiary ?? new Map(),
    );
    const created = new Game(
      options.laptop,
      game,
      options.saveSlot,
      options.notesFile,
      options.events,
      atlas,
      tactics,
      elements,
      guide,
      options.tactician,
      options.tacticianBoss ?? true,
    );
    created.notes =
      options.notesFile === undefined ? [] : await loadNotes(options.notesFile, signal);
    return created;
  }

  /** Install the second layer after the plugin has built its tool-call binding. */
  setTactician(tactician: ((facts: string) => Promise<TacticianPlan>) | undefined): void {
    this.tactician = tactician;
  }

  /** Any map's walker notes and advice, for the strategy page. */
  tacticianInfoFor(mapId: number): { mapId: number; walkerNotes: string; askUp: string } | null {
    const info = this.tacticianInfoByMap.get(mapId);
    return info === undefined ? null : { mapId, ...info };
  }

  /** The current map's walker notes and advice, for the first layer's dynamic context. */
  tacticianInfo(): { mapId: number; walkerNotes: string; askUp: string } | null {
    return this.mapId === null ? null : this.tacticianInfoFor(this.mapId);
  }

  /** The last boss table the tactician wrote, or null before one. */
  lastBossPlan(): BossPlanRecord | null {
    return this.lastBoss;
  }

  /** Every tool name this Game dispatches; the plugin's TOOLS minus `done` must all be here. */
  handledTools(): string[] {
    return [...this.handlers.keys()];
  }

  async observe(pilot: Pilot): Promise<string> {
    if (this.events) {
      const sample = this.events.liveSample();
      if (sample !== null) return view.summarize(sample, this.events.takeRecent().slice(-8));
    }
    const stateText = await pilot.runPs(stateScript(this.laptop, this.game));
    const [sample, events] = await parseState(stateText, cursorPath(this.game));
    const kept = events.filter((event) => event.type !== "pos.change");
    return view.summarize(sample, kept.slice(-8));
  }

  /** The key events in this layer's window (control plan §4.8), "" without the stream. */
  window(layer: 1 | 2): string {
    return this.events ? this.events.window(layer) : "";
  }

  news(): string {
    return this.events ? this.events.news() : "";
  }

  /**
   * None when keys can reach the game; otherwise why not (the laptop is locked, or another
   * window is in front). A bridge that presses its virtual gamepad needs neither, and the game
   * is never pulled to the front then (10-27: the laptop stays usable while the game plays).
   */
  async ready(pilot: Pilot): Promise<string | null> {
    let status = await pilot.send("status");
    if (truthy(status.gameButtons)) return null;
    if (truthy(status.locked)) return "locked";
    if (!truthy(status.focused)) {
      await pilot.send("focus");
      status = await pilot.send("status");
      if (!truthy(status.focused)) return "not_focused";
    }
    return null;
  }

  /**
   * Finish a regular battle locally, so the model never waits on enemies. A boss battle
   * (bridge 0.4.0+ reads the flag) is left running for the model to plan with `fight`.
   */
  async settle(pilot: Pilot): Promise<string> {
    const pos = record((await pilot.send("pos")).pos);
    if (!(truthy(pos.battle) || pos.state === "Battle")) return "";
    const sample = record((await pilot.query("sample")).sample);
    const fight = record(sample.battle);
    if (truthy(fight.boss)) {
      const old =
        "首领战开始了!战斗暂停等你决定:用 fight 交一张规则表。\n" +
        describeBattle(fight, list(sample.party), this.elements);
      if (this.tactician === undefined || !this.tacticianBoss) {
        if (this.tactician !== undefined) this.tacticianCalled = true; // the first layer fights it
        return old;
      }
      const mapId = num(record(sample.user).mapId) ?? this.mapId;
      if (mapId === null) return old;
      const detail = describeBattle(fight, list(sample.party), this.elements);
      const outcome = await this.runTactician(
        { kind: "boss", mapId, detail, battle: fight, pilot },
        false,
      );
      const table = outcome.tables[0];
      if (table === undefined) return [outcome.text, old].filter((part) => part !== "").join("\n");
      const result = await battle.fight(pilot, table, 300, () => undefined, this.elements);
      const done = truthy(result.ok) ? "战斗结束" : `战斗没打完:${show(result.error)}`;
      let fought = `首领战由战术官写表,代码照表打:${done};出招:${list(result.turns).map(show).join("、")}`;
      if (result.learned.length > 0) fought += "\n" + result.learned.join(";");
      if (truthy(result.ok)) {
        const healed = await battle.patchUp(pilot, () => undefined);
        if (healed.length > 0) fought += "\n战后回复:" + healed.join(";");
      }
      this.lastBoss = { mapId, table, result: fought, at: new Date().toISOString() };
      return [outcome.text, fought].filter((part) => part !== "").join("\n");
    }
    return `(途中遇敌,${await battle.regular(pilot, this.hooks, () => undefined, this.saveSlot)})`;
  }

  /**
   * Call the second layer once for this tool invocation, retrying at most twice when the
   * returned tables do not pass gambit.check. Tables that do pass are installed; the text
   * always says what happened, even when nothing usable came back (task 10).
   */
  private async runTactician(
    trigger: FactsTrigger,
    install: boolean,
  ): Promise<{ text: string; tables: Json[] }> {
    this.tacticianCalled = true;
    if (this.tactician === undefined) return { text: "", tables: [] };
    let facts: string;
    try {
      facts = await buildFacts(this, trigger);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { text: `战术官没有叫成:${describeError(error)}`, tables: [] };
    }
    let plan: TacticianPlan | null = null;
    let problems: string[] = [];
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        plan = await this.tactician(facts);
      } catch (error) {
        if (isAbortError(error)) throw error;
        return { text: `战术官没有回答:${describeError(error)}`, tables: [] };
      }
      problems = tacticianProblems(plan.tables, this.game);
      if (problems.length === 0) break;
      if (attempt < 2) {
        facts +=
          "\n\n### 上次交回的规则表有问题\n" +
          problems.join("\n") +
          "\n请改好再交:1–3 套,每套 {角色名: [规则…]}。";
      }
    }
    if (plan === null) return { text: "战术官没有交回结果", tables: [] };
    const good = plan.tables
      .filter((table) => gambit.check(table, this.game).length === 0)
      .slice(0, 3);
    this.tacticianInfoByMap.set(trigger.mapId, {
      walkerNotes: plan.walkerNotes,
      askUp: plan.askUp,
    });
    let text = `战术官(地图 ${trigger.mapId}):${plan.walkerNotes}`;
    if (plan.askUp !== "") text += `\n战术官建议:${plan.askUp}`;
    if (problems.length > 0) {
      text +=
        `\n战术官的规则表有问题:${problems.join(";")}` +
        (good.length > 0 ? `;先装上能通过的 ${good.length} 套` : ";这次没有可用的规则表");
    }
    if (install && good.length > 0) {
      const met = [...(this.events?.enemies.get(trigger.mapId) ?? new Set<string>())].sort();
      await this.tactics.set(trigger.mapId, good, met);
    }
    return { text, tables: good };
  }

  /** After a tool: the one trigger chooseTrigger finds, if the tactician has not spoken yet. */
  /** Town areas whose maps share the tactician's one call (chooseTrigger). */
  private readonly townsCovered = new Set<string>();

  /** A map's atlas name; "" when the atlas has not seen it. */
  mapNameOf(mapId: number | null): string {
    if (mapId === null) return "";
    const entry = this.atlas.maps.get(String(mapId)) ?? {};
    return typeof entry.name === "string" ? entry.name : "";
  }

  private mapName(): string {
    return this.mapNameOf(this.mapId);
  }

  private async afterTool(pilot: Pilot): Promise<string> {
    if (this.tactician === undefined || this.tacticianCalled) return "";
    const met = [...(this.events?.enemies.get(this.mapId) ?? new Set<string>())];
    const reason = chooseTrigger({
      mapId: this.mapId,
      tactics: this.tactics,
      met,
      lastBattle: this.lastBattle,
      blocked: this.blocked,
      ride: this.ride,
      mapName: this.mapName(),
      townsCovered: this.townsCovered,
    });
    if (reason === null) return "";
    if (reason.kind === "new-map" && isTown(areaOf(this.mapName()))) {
      this.townsCovered.add(areaOf(this.mapName()));
    }
    this.lastBattle = null;
    if (reason.kind === "blocked") this.blockedCounts.clear();
    this.blocked = null;
    this.ride = null;
    const outcome = await this.runTactician({ ...reason, pilot }, true);
    return outcome.text;
  }

  /** Remember blocked steps and conveyor rides from this tool's walking messages. */
  private noteTravel(message: string, mapId: number | null): void {
    if (mapId === null) return;
    for (const match of message.matchAll(/\[(\d+), (\d+)\] 被挡住/gu)) {
      const cell: Cell = [Number(match[1]), Number(match[2])];
      const key = `${mapId}:${cell[0]},${cell[1]}`;
      const count = (this.blockedCounts.get(key) ?? 0) + 1;
      this.blockedCounts.set(key, count);
      if (count >= 3) {
        this.blocked = { count, detail: `在 (${cell[0]}, ${cell[1]}) 被挡住` };
      }
    }
    const ride = /踩到传送带 \((\d+), (\d+)\),被带到 \((\d+), (\d+)\)/u.exec(message);
    if (ride !== null) this.ride = ride[0];
  }

  /** Record the current map's exits and chests in the atlas; returns the map id. */
  async chart(pilot: Pilot): Promise<number | null> {
    const pos = record((await pilot.send("pos")).pos);
    const mapId = num(pos.map) ?? null;
    if (mapId === null || pos.state === "ChangeMap" || pos.state === "FieldReady") return mapId;
    const found = new Map<string, Json[]>();
    for (const kind of ["GotoMap", "TresureBox", "Event"]) {
      const listing = record((await pilot.send("entities", { kind, max: 200 })).entities);
      found.set(
        kind,
        records(listing.entities).filter((entity) =>
          entity.active === undefined ? true : truthy(entity.active),
        ),
      );
    }
    const sample =
      (this.events ? this.events.liveSample() : null) ??
      record((await pilot.query("sample")).sample);
    const user = record(sample.user);
    const name = [user.areaText, user.locationText]
      .map((value) => text(value))
      .filter((value): value is string => value !== undefined && value !== "")
      .join(" ");
    const exits: Json[] = [];
    for (const entity of found.get("GotoMap") ?? []) {
      if (!truthy(entity.cell) || entity.toMap === null || entity.toMap === undefined) continue;
      exits.push({ cell: entity.cell, to: entity.toMap, name: text(entity.name) ?? "" });
    }
    // A town's way out to the world map can be an event, not an entrance (10-22: Karnak's
    // at (27,45); the player found no exit and walked the town for fifty steps).
    for (const entity of found.get("Event") ?? []) {
      if (!truthy(entity.cell) || !(text(entity.name) ?? "").includes(WORLD_EXIT)) continue;
      exits.push({ cell: entity.cell, to: 1, name: text(entity.name) ?? "" });
    }
    const chests = (found.get("TresureBox") ?? []).map((entity) => ({
      cell: entity.cell,
      name: text(entity.name) ?? "",
    }));
    await this.atlas.visit(mapId, name, exits, chests);
    const savePoint = (found.get("Event") ?? []).find((entity) =>
      (text(entity.name) ?? "").includes("SavePoint"),
    );
    this.savePoint = savePoint ? cellOf(savePoint.cell) : null;
    return mapId;
  }

  /** Remember where the drake was left, across runs (the file next to the atlas). */
  async keepDrake(): Promise<void> {
    const path = this.atlas.path ? join(dirname(this.atlas.path), "drake.json") : undefined;
    if (path === undefined) return;
    if (this.moveState.drake === null) {
      if (!(await fileExists(path))) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, { encoding: "utf8" }));
      } catch (error) {
        throw new Error(`读不懂飞龙位置 ${path}:${describeError(error)}`, { cause: error });
      }
      const cell = cellOf(parsed);
      if (cell === null) throw new Error(`飞龙位置 ${path} 不是 [x, y]`);
      this.moveState.drake = cell;
    } else {
      try {
        await writeFile(path, JSON.stringify(this.moveState.drake), "utf8");
      } catch (error) {
        throw new Error(`写不了飞龙位置 ${path}:${describeError(error)}`, { cause: error });
      }
    }
  }

  /** An entrance (town, castle, dungeon) on the world map at or right next to goal. */
  async worldEntrance(pilot: Pilot, goal: Cell): Promise<boolean> {
    const found = record((await pilot.send("entities", { kind: "GotoMap", max: 300 })).entities);
    return records(found.entities).some((entity) => {
      const cell = cellOf(entity.cell);
      return cell !== null && Math.abs(cell[0] - goal[0]) + Math.abs(cell[1] - goal[1]) <= 1;
    });
  }

  async gearInBag(pilot: Pilot): Promise<Record<string, number>> {
    const held = records(record((await pilot.query("items")).items).normal);
    const bag: Record<string, number> = {};
    for (const item of held) {
      const entry = record(item);
      const type = text(entry.type);
      const name = text(entry.name);
      if (type === undefined || !GEAR.has(type) || name === undefined || name === "") continue;
      bag[name] = num(entry.count) ?? 0;
    }
    return bag;
  }

  /**
   * New weapons or armour in the bag since the last look (a chest, an event, a shop): put on
   * the strongest, the game's own 最强装备 deciding who wears what, and say what changed. Gear
   * put on leaves the bag, so that is never new. Waits for the field: in a shop or a dialog the
   * new gear stays new until the next look (10-21: the Mythril helmet from North Mountain went
   * unworn).
   */
  async checkGear(pilot: Pilot): Promise<string> {
    const bag = await this.gearInBag(pilot);
    if (this.gear === null) {
      this.gear = bag;
      return "";
    }
    const before = this.gear;
    const fresh = Object.entries(bag)
      .filter(([name, count]) => count > (before[name] ?? 0))
      .map(([name]) => name);
    if (fresh.length === 0) {
      this.gear = bag;
      return "";
    }
    if (record((await pilot.send("pos")).pos).state !== "Player") return "";
    const [ok, detail] = await this.optimizeEquipment(pilot);
    this.gear = await this.gearInBag(pilot);
    if (ok && this.events) this.events.note("equip", detail);
    return `得到新装备「${fresh.join("、")}」,已检查最强装备:${detail}`;
  }

  /**
   * The guides' warnings for an area entered and for monsters met for the first time (control
   * plan §4.11; 10-21: Jackanapes, "RUN from" it, wiped the party twice).
   */
  guideHint(): string {
    if (this.guide === null) return "";
    const out: string[] = [];
    const sample = (this.events ? this.events.liveSample() : null) ?? {};
    const area = text(record(sample.user).areaText);
    if (area !== undefined && area !== "" && !this.advised.has(area)) {
      this.advised.add(area);
      const warnings = this.guide.warnings(area);
      if (warnings.length > 0)
        out.push(`攻略(「${area}」):${warnings.join(";")}。详情用 guide 查。`);
    }
    const met =
      (this.events && this.mapId !== null ? this.events.enemies.get(this.mapId) : null) ??
      new Set<string>();
    for (const name of [...met].sort()) {
      if (this.advised.has(name)) continue;
      this.advised.add(name);
      const book = this.events?.books.get(name);
      const note = book !== undefined ? this.guide.monsterNote(book) : "";
      if (note !== "") out.push(`攻略(怪物「${name}」= #${String(book).padStart(3, "0")}):${note}`);
    }
    return out.join("\n");
  }

  /**
   * In a town (its exits lead to an inn or shops) with the party below full: say to get ready
   * there first, once per visit (10-21: the party left Walse at half HP, with its shops
   * unvisited, and fell in the castle basement).
   */
  async townHint(pilot: Pilot): Promise<string> {
    const entry = this.atlas.maps.get(String(this.mapId)) ?? {};
    const names = records(entry.exits)
      .map((exit) => text(exit.name) ?? "")
      .join(" ");
    if (this.mapId === this.town || !TOWN_WORDS.some((word) => names.includes(word))) return "";
    const party = await menu.partyState(pilot);
    const hp: [number, number] = [
      party.reduce((sum, member) => sum + (num(member.hp) ?? 0), 0),
      party.reduce((sum, member) => sum + (num(member.maxHp) ?? 0), 0),
    ];
    const mp: [number, number] = [
      party.reduce((sum, member) => sum + (num(member.mp) ?? 0), 0),
      party.reduce((sum, member) => sum + (num(member.maxMp) ?? 0), 0),
    ];
    this.town = this.mapId;
    const sample = (this.events ? this.events.liveSample() : null) ?? {};
    const area = text(record(sample.user).areaText) ?? "";
    const stock = this.townStock(area);
    const lines: string[] = [];
    if (hp[0] < hp[1] || mp[0] < mp[1]) {
      lines.push(
        `提示:这里是城镇,队伍 HP ${hp[0]}/${hp[1]}、MP ${mp[0]}/${mp[1]} 没满。` +
          "出发去迷宫前先整备:住店回满;看看魔法店、武器防具店有没有新东西" +
          "(买到的装备会自动穿上)。",
      );
    }
    const ailing = new Set<string>();
    for (const member of party) {
      for (const status of gambit.statuses(member)) {
        if (status in gambit.CURES) ailing.add(status);
      }
    }
    if (ailing.size > 0) {
      const sorted = [...ailing].sort();
      const items = sorted.flatMap((status) => {
        const cure = gambit.CURES[status];
        return cure && truthy(cure[1]) ? [cure[1]] : [];
      });
      lines.push(
        `提示:队伍有状态异常(${sorted.join("、")}),住店能治好;` +
          `道具店买些治它的道具(${items.join("、")})带着,战斗里会自动用。`,
      );
    }
    if (stock !== "") {
      lines.push(`攻略:${area}的商店卖 ${stock}。详情用 guide(kind=shop)查。`);
    }
    return lines.join("\n");
  }

  /**
   * Ailments nobody can cure now (no item in the bag, no white mage with MP): say what to buy
   * and where, once per group of ailing members, or again on a new map. 10-27: Bartz and Lenna
   * stayed blind through the whole Fire-Powered Ship because nothing said the bag had no Eye
   * Drops.
   */
  async ailmentHint(pilot: Pilot): Promise<string> {
    const sample =
      (this.events ? this.events.liveSample() : null) ??
      record((await pilot.query("sample")).sample);
    const party = records(sample.party);
    const groups = new Map<string, string[]>();
    for (const member of party) {
      for (const status of gambit.statuses(member)) {
        if (!(status in gambit.CURES)) continue;
        groups.set(status, [...(groups.get(status) ?? []), show(member.name)]);
      }
    }
    if (groups.size === 0) {
      this.ailmentCombo = "";
      return "";
    }
    const held = await battle.heldItems(pilot);
    const uncured: [string, string[]][] = [];
    for (const [status, names] of groups) {
      const cure = gambit.CURES[status];
      if (cure === undefined) continue;
      const [spell, item] = cure;
      const hasItem = Object.entries(held).some(
        ([name, count]) => count > 0 && (name.includes(item) || item.includes(name)),
      );
      const canCast =
        spell !== null &&
        party.some(
          (member) =>
            member.jobName === "白魔法师" &&
            (num(member.hp) ?? 0) > 0 &&
            (num(member.mp) ?? 0) >= 2,
        );
      if (!hasItem && !canCast) uncured.push([status, names.sort()]);
    }
    if (uncured.length === 0) {
      this.ailmentCombo = "";
      return "";
    }
    const combo = uncured.map(([status, names]) => `${status}:${names.join("、")}`).join(";");
    if (combo === this.ailmentCombo && this.mapId === this.ailmentMap) return "";
    this.ailmentCombo = combo;
    this.ailmentMap = this.mapId;
    const area = text(record(sample.user).areaText) ?? "";
    return uncured
      .map(([status, names]) => {
        const item = gambit.CURES[status]?.[1] ?? "";
        const shop = shopSelling(this.guide, area, item);
        return (
          `${names.join("、")} ${status}:包里没有${item},没人会治。` +
          `${shop !== "" ? `去${shop}买${item}` : `去商店买${item}`},或者住店。`
        );
      })
      .join("\n");
  }

  /** The magic and gear the guide lists for this town's shops, names and prices. */
  townStock(area: string): string {
    if (this.guide === null || area === "") return "";
    const parts: string[] = [];
    for (const section of this.guide.sectionsFor(area).slice(0, 1)) {
      for (const table of section.shops ?? []) {
        if (!["魔法", "武器", "防具", "饰品", "盾", "头盔"].includes(table.kind)) continue;
        const goods = table.goods
          .map((good) => `${good.name} ${truthy(good.cost) ? good.cost : "?"}`)
          .join("、");
        parts.push(`${table.kind}:${goods}`);
      }
    }
    return parts.join(";");
  }

  /** Monsters met on this map and no tactics for them yet: ask for some (§4.10). */
  tacticsHint(): string {
    if (this.tactician !== undefined) return ""; // the tactician writes these tables now
    if (this.mapId === null || this.mapId === 1 || this.tactics.has(this.mapId)) return "";
    const met = [
      ...((this.events ? this.events.enemies.get(this.mapId) : null) ?? new Set<string>()),
    ].sort();
    if (met.length === 0) return "";
    return (
      `提示:这张地图遇到过的怪物有 ${met.join("、")},还没有战斗策略。` +
      "用 set_tactics 针对它们写 2–3 套规则表(主策略和备用策略),普通战斗就会按策略打。"
    );
  }

  /**
   * A save point on this map and no save for a while (10-20: run 8 walked past one with
   * nothing saved since the canal): say so; saving stays the player's call.
   */
  saveHint(): string {
    if (this.savePoint === null) return "";
    const last = this.events ? this.events.lastSaveMinutes() : null;
    if (last !== null && last < 10) return "";
    const since =
      last === null ? "这次还没存过档" : `上次存档是 ${pyRound(last, 0).toFixed(0)} 分钟前`;
    return `提示:这张地图有存档点 (${this.savePoint[0]}, ${this.savePoint[1]}),${since}。站上去用 save_game 可以存档。`;
  }

  /**
   * After interact: standing somewhere far from where the press was made, on the same map,
   * means a jump stone (or a lift) carried the party; the atlas keeps it as a link.
   */
  async noteJump(pilot: Pilot, message: string): Promise<void> {
    const match = /站在 \((\d+), (\d+)\)/u.exec(message);
    const pos = record((await pilot.send("pos")).pos);
    const cell = cellOf(pos.cell);
    if (match === null || cell === null || pos.state !== "Player") return;
    const start: Cell = [Number(match[1]), Number(match[2])];
    if (Math.abs(cell[0] - start[0]) + Math.abs(cell[1] - start[1]) > 1) {
      await this.atlas.link(pos.map, start, cell, "调查后跳");
    }
  }

  /** Towns, dungeons, the canal: the collision grid with the entities marked. */
  async floor(pilot: Pilot, radius: number): Promise<string> {
    const collision = record((await pilot.send("collision")).collision);
    const grid = nav.layeredGrid(collision, new Set());
    if (grid === null) return "这里读不到地图(可能正在切换地图)";
    const marks = new Map<string, string>();
    for (const [kind, [mark]] of FLOOR_MARKS) {
      const found = record((await pilot.send("entities", { kind, max: 200 })).entities);
      for (const entity of records(found.entities)) {
        const cell = cellOf(entity.cell);
        const name = text(entity.name);
        const named =
          (kind !== "DefaultEntity" && kind !== "DefaultAnimEntity") ||
          (name !== undefined &&
            name !== "" &&
            !name.includes("吹き出し") &&
            !name.includes("【汎用】"));
        if (truthy(entity.active === undefined ? true : entity.active) && cell !== null && named) {
          const key = nav.cellKey(cell[0], cell[1]);
          if (!marks.has(key)) marks.set(key, mark);
        }
      }
    }
    return renderFloor(nav.layeredView(grid), radius, marks);
  }

  async run(name: string, args: Json, pilot: Pilot): Promise<string> {
    const handler = this.handlers.get(name);
    if (handler === undefined) return `未知工具 ${name}`;
    this.tacticianCalled = false;
    this.blocked = null;
    this.ride = null;
    this.lastBattle = null;
    const outcome = await handler(args, pilot);
    if (outcome.early) return outcome.text;
    const text = outcome.text;
    const settled = await this.settle(pilot);
    this.mapId = await this.chart(pilot);
    this.noteTravel(text, this.mapId);
    await this.keepDrake();
    const gear = await this.checkGear(pilot);
    const news = this.news();
    const hints = [
      this.guideHint(),
      this.saveHint(),
      this.tacticsHint(),
      await this.townHint(pilot),
      await this.ailmentHint(pilot),
    ];
    const hint = hints.filter((line) => line !== "").join("\n");
    const tactical = await this.afterTool(pilot);
    const parts = [
      text,
      settled,
      gear,
      news !== "" ? "新的重要事件:\n" + news : "",
      hint,
      tactical,
      "当前状态:\n" + (await this.observe(pilot)),
    ];
    return parts.filter((part) => part !== "").join("\n");
  }

  private async travel(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const help = await screens.dismissFieldHelp(pilot);
    if (help === "stuck") return { text: screens.FIELD_HELP_STUCK, early: true };
    const legs = help === "closed" ? ["关掉了操作提示"] : [];
    const goal: Cell = [integer(args.x), integer(args.y)];
    let message: string;
    if ((await move.flying(pilot)) && (await this.worldEntrance(pilot, goal))) {
      [, message] = await move.flyIn(pilot, this.moveState, goal, (line) => legs.push(line));
    } else {
      const ship = truthy(args.by_ship);
      [, message] = await move.navigate(
        pilot,
        goal,
        ship,
        (line) => legs.push(line),
        8,
        this.moveState,
      );
    }
    return { text: [...legs, message].join("\n") };
  }

  private async toolTerrain(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const raw = truthy(args.radius) ? args.radius : 12;
    const radius = Math.max(4, Math.min(24, integer(raw)));
    const cells = (await pilot.send("cells", { r: radius })).cells;
    if (truthy(cells)) {
      const grid = gridOf(record(cells));
      if (nav.hasTerrain(grid)) return { text: renderTerrain(grid) };
    }
    return { text: await this.floor(pilot, radius) };
  }

  private async toolEntrances(pilot: Pilot): Promise<HandlerResult> {
    const found = (await pilot.send("entities", { kind: "GotoMap", max: 300 })).entities;
    return { text: truthy(found) ? view.describeEntities(found) : "这里读不到入口" };
  }

  private async toolLookAround(pilot: Pilot): Promise<HandlerResult> {
    const parts: string[] = [];
    const exits = (await pilot.send("entities", { kind: "Event", max: 200 })).entities;
    const events = records(record(exits).entities);
    const out = events.filter((entity) => (text(entity.name) ?? "").includes(WORLD_EXIT));
    if (out.length > 0) {
      parts.push(
        out
          .map((entity) => `  出口 @ ${show(entity.cell)} 通往世界地图(事件点,走上去就出去)`)
          .join("\n"),
      );
    }
    // Conveyors and other named events are open floor in the collision data: without this
    // list the model walks onto them blind (10-27: the Fire-Powered Ship, 流される①/②).
    const named = events.filter((entity) => {
      const name = text(entity.name) ?? "";
      return name !== "" && !name.includes(WORLD_EXIT);
    });
    const eventLines = view.describeEvents(named);
    if (eventLines !== "") parts.push(eventLines);
    for (const kind of ["GotoMap", "TresureBox", "Npc", "DefaultEntity", "DefaultAnimEntity"]) {
      let found = (await pilot.send("entities", { kind, max: 60 })).entities;
      if (found && (kind === "DefaultEntity" || kind === "DefaultAnimEntity")) {
        found = view.namedObjects(found);
      }
      if (found && list(record(found).entities).length > 0) {
        let lines = view.describeEntities(found).split("\n").slice(1);
        if (kind === "GotoMap") {
          lines = lines.map((line, index) => {
            const entity = records(record(found).entities)[index];
            return entity && "toMap" in entity ? line + this.atlas.mark(entity.toMap) : line;
          });
        }
        if (kind === "Npc") {
          // A RelayInteraction beside an NPC is a counter: shopkeepers and innkeepers stand
          // behind one (10-27: in Karnak the player tried every NPC before the old man at
          // the counter turned out to be the item shop).
          const counters = records(
            record((await pilot.send("entities", { kind: "RelayInteraction", max: 60 })).entities)
              .entities,
          ).flatMap((entity) => {
            const cell = list(entity.cell);
            return typeof cell[0] === "number" && typeof cell[1] === "number"
              ? [[cell[0], cell[1]] as const]
              : [];
          });
          lines = lines.map((line, index) => {
            const npc = list(records(record(found).entities)[index]?.cell);
            const [x, y] = [npc[0], npc[1]];
            const behind =
              typeof x === "number" &&
              typeof y === "number" &&
              counters.some(([cx, cy]) => Math.abs(cx - x) + Math.abs(cy - y) === 1);
            return behind ? `${line}(在柜台后，多半是店员;interact 会隔着柜台说话)` : line;
          });
        }
        parts.push(lines.join("\n"));
      }
    }
    const mapId = record((await pilot.send("pos")).pos).map;
    const links = this.atlas.links(mapId);
    if (links !== "") parts.push(`走法 ${links}`);
    return { text: parts.join("\n") || "附近没有入口、宝箱、NPC 或物体" };
  }

  private async toolInteract(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const message = await move.openAt(
      pilot,
      [integer(args.x), integer(args.y)],
      () => undefined,
      this.moveState,
    );
    await this.noteJump(pilot, message);
    return { text: message };
  }

  private async toolAdvanceStory(pilot: Pilot): Promise<HandlerResult> {
    // FF5 is the running game: its paging stays the pilot agent's story op, but the new-game
    // FieldHelp and naming screens the op now stops on are handled before each try (10-29).
    if (this.game === "ff5") {
      return { text: await this.pilotAdvanceStory(pilot) };
    }
    const outcome = await screens.advanceStory(pilot);
    const notes = outcome.notes.length > 0 ? outcome.notes.join("\n") + "\n" : "";
    if (outcome.stop === "stuck") {
      return {
        text:
          notes +
          "画面没有变化，可能是工具认不出的界面,停下不再按键。\n" +
          `当前状态:${outcome.detail}`,
        early: true,
      };
    }
    if (outcome.stop === "fieldhelp") {
      return {
        text: notes + `${screens.FIELD_HELP_STUCK}\n当前状态:${outcome.detail}`,
        early: true,
      };
    }
    return { text: `${notes}翻了 ${outcome.pages} 页,停下原因:${outcome.stop}` };
  }

  /**
   * FF5's story op pages by itself, but it stops on the first-visit FieldHelp and the naming
   * box; close those with the five-game helpers, then let it page again (at most three tries).
   */
  private async pilotAdvanceStory(pilot: Pilot): Promise<string> {
    const notes: string[] = [];
    let pages = 0;
    let why: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const help = await screens.dismissFieldHelp(pilot);
      if (help === "stuck") return [...notes, screens.FIELD_HELP_STUCK].join("\n");
      if (help === "closed") notes.push("关掉了操作提示");
      const named = await screens.nameFocusedField(pilot);
      if (named !== null) notes.push(named);

      const result = await pilot.send("story", { pageMs: 3000, timeout: 600000 }, 620_000);
      pages += num(result.pages) ?? 0;
      why = text(result.stop) || text(result.error);
      if (why !== "state:ChangeName" && why !== "state:FieldHelp") break;
    }
    const line = `翻了 ${pages} 页,停下原因:${show(why)}`;
    return notes.length > 0 ? `${notes.join("\n")}\n${line}` : line;
  }

  private async toolPress(args: Json, pilot: Pilot): Promise<HandlerResult> {
    // Only the five newly started games get this tool; the gamepad keys are sent through the
    // same virtual pad the other presses use (bridge 0.10.0).
    const keys = screens.pressKeys(args.keys);
    await screens.pressOnScreen(pilot, keys);
    // Early: an unrecognised screen should not run charts, hints or tactician triggers.
    return {
      text: `已按 ${keys.join("、")}\n当前状态:\n${await this.observe(pilot)}`,
      early: true,
    };
  }

  private async toolChoose(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const state = record((await pilot.send("pos")).pos).state;
    if (state === "Shop" || state === "Menu") {
      return { text: "现在是商店/菜单界面,不是选项。要离开就用 leave_menu。", early: true };
    }
    const index = Math.max(0, Math.min(integer(args.index), 9));
    // Bridge 0.4.0 reports where the cursor is; older ones start from the top.
    const choice = record(record((await pilot.query("sample")).sample).choice);
    const open = Object.values(choice).find(
      (value): value is Json => isRecord(value) && truthy(value.open),
    );
    const at = open ? (num(open.cursor) ?? 0) : 0;
    const step = index >= at ? "Down" : "Up";
    const keys = [...Array.from({ length: Math.abs(index - at) }, () => step), "Enter"];
    const result = await pilot.send("keys", { keys, gap: 250 });
    return { text: truthy(result.ok) ? "已选择" : `没选成:${show(result.error)}` };
  }

  private async toolFight(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const plan = gambit.normalize(record(args.plan));
    const problems = gambit.check(plan, this.game);
    if (problems.length > 0) {
      // Sent back before a key is pressed (§4.6): the battle waits for a full table.
      return { text: "规则表没有通过检查,请改好再交:\n" + problems.join("\n"), early: true };
    }
    const result = await battle.fight(pilot, plan, 300, () => undefined, this.elements);
    const done = truthy(result.ok) ? "战斗结束" : `战斗没打完:${show(result.error)}`;
    let text = `${done};出招:${list(result.turns).map(show).join("、")}`;
    if (result.learned.length > 0) text += "\n" + result.learned.join(";");
    if (truthy(result.ok)) {
      const healed = await battle.patchUp(pilot, () => undefined);
      if (healed.length > 0) text += "\n战后回复:" + healed.join(";");
    }
    return { text };
  }

  private async toolSell(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const [ok, detail] = await shop.sell(pilot, String(args.item), integer(args.count || 1));
    if (ok && this.events) this.events.note("buy", detail);
    return { text: detail };
  }

  private async toolShopGear(pilot: Pilot): Promise<HandlerResult> {
    const [, detail] = await shop.gearReport(pilot);
    return { text: detail };
  }

  private async toolBuy(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const [ok, detail] = await shop.buy(pilot, String(args.product), integer(args.count || 1));
    if (ok && this.events) this.events.note("buy", detail);
    return { text: detail };
  }

  private async toolCast(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const [, detail] = await menu.cast(
      pilot,
      String(args.caster),
      String(args.spell),
      text(args.target),
    );
    return { text: detail };
  }

  private async toolUseItem(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const [, detail] = await menu.useItem(pilot, String(args.item), String(args.target));
    return { text: detail };
  }

  private async toolChangeJob(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const [, detail] = await menu.changeJob(pilot, String(args.member), String(args.job));
    return { text: detail };
  }

  private async toolLeaveMenu(pilot: Pilot): Promise<HandlerResult> {
    return { text: await menu.leaveMenu(pilot) };
  }

  private async toolSaveGame(pilot: Pilot): Promise<HandlerResult> {
    const [, detail] = await save.saveGame(pilot, this.saveSlot);
    return { text: detail };
  }

  private async toolLand(pilot: Pilot): Promise<HandlerResult> {
    const [, detail] = await move.land(pilot, this.moveState, null, () => undefined);
    return { text: detail };
  }

  private async toolBoard(pilot: Pilot): Promise<HandlerResult> {
    const [, detail] = await move.board(pilot, this.moveState, () => undefined);
    return { text: detail };
  }

  /** Overridable in tests, as Python monkeypatches menu.optimize_equipment. */
  async optimizeEquipment(pilot: Pilot): Promise<[boolean, string]> {
    return menu.optimizeEquipment(pilot);
  }

  private async toolOptimizeEquipment(pilot: Pilot): Promise<HandlerResult> {
    const [ok, detail] = await this.optimizeEquipment(pilot);
    if (ok && this.events) this.events.note("equip", detail);
    return { text: detail };
  }

  private async toolSetTactics(args: Json, pilot: Pilot): Promise<HandlerResult> {
    const tables = list(args.tables)
      .filter((table) => truthy(table))
      .map((table) => gambit.normalize(record(table)));
    const problems = tables.flatMap((table, index) =>
      gambit.check(table, this.game).map((problem) => `第 ${index + 1} 套:${problem}`),
    );
    if (tables.length === 0 || problems.length > 0) {
      return {
        text: "策略没有通过检查,请改好再交:\n" + (problems.join("\n") || "至少要一套"),
        early: true,
      };
    }
    const mapId = args.map || record((await pilot.send("pos")).pos).map;
    const id = integer(mapId);
    const met = [...(this.events?.enemies.get(id) ?? new Set<string>())].sort();
    await this.tactics.set(id, tables, met);
    return {
      text:
        `已为地图 ${id} 设好 ${tables.length} 套战斗策略;` +
        "普通战斗先用第 1 套,打得不好会自动换下一套。",
    };
  }

  private toolGuide(args: Json): Promise<HandlerResult> {
    if (this.guide === null) return Promise.resolve({ text: EARLY_GUIDE, early: true });
    const query = String(truthy(args.query) ? args.query : "");
    const kind = String(truthy(args.kind) ? args.kind : "area");
    const part = integer(args.part || 1);
    const found = this.guide.lookup(query, part, kind);
    return Promise.resolve({
      text: found || `攻略里没有找到「${query}」;换个说法(英文名、地区名或图鉴编号)再查`,
      early: true,
    });
  }

  private async toolAtlas(pilot: Pilot): Promise<HandlerResult> {
    return { text: this.atlas.describe(await this.chart(pilot)) };
  }

  private async toolInventory(pilot: Pilot): Promise<HandlerResult> {
    return { text: view.describeItems(record((await pilot.query("items")).items)) };
  }

  private async toolRemember(args: Json): Promise<HandlerResult> {
    this.notes = [...this.notes, String(args.note)].slice(-MAX_NOTES);
    await saveNotes(this.notesFile, this.notes);
    return { text: `已记下(第 ${this.notes.length} 条)`, early: true };
  }

  private async toolForget(args: Json): Promise<HandlerResult> {
    const index = integer(args.index) - 1;
    if (!(index >= 0 && index < this.notes.length)) {
      return { text: `没有第 ${index + 1} 条笔记`, early: true };
    }
    const removed = this.notes.splice(index, 1)[0] ?? "";
    await saveNotes(this.notesFile, this.notes);
    return { text: `已删除:${removed}`, early: true };
  }
}

/** Cancellation is dsh's, not a tactician failure: let it reach the tool boundary. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** What makes a tactician table unusable, numbered by table (1-based). */
export function tacticianProblems(tables: readonly Json[], game = "ff5"): string[] {
  const problems: string[] = [];
  if (tables.length === 0) problems.push("一套规则表都没有");
  if (tables.length > 3) problems.push(`最多 3 套,这次交了 ${tables.length} 套`);
  for (const [index, table] of tables.entries()) {
    problems.push(...gambit.check(table, game).map((problem) => `第 ${index + 1} 套:${problem}`));
  }
  return problems;
}

/** A cells reply narrowed to the grid nav and prompt renderers take. */
function gridOf(cells: Json): nav.CellGrid {
  const origin = cellOf(cells.origin);
  const center = cellOf(cells.center);
  if (origin === null || center === null || !Array.isArray(cells.attr)) {
    throw new Error("cells 回复不是地图格子");
  }
  const attr: nav.CellValue[][] = [];
  for (const row of cells.attr) {
    if (!Array.isArray(row)) throw new Error("cells 回复的 attr 不是二维数组");
    attr.push(row.map((value) => (typeof value === "number" ? value : null)));
  }
  return { origin, center, attr };
}
