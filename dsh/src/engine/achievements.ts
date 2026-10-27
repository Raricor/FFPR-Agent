/**
 * Achievement progress for the current save: the save layer of the design's two layers
 * (design §13.2). The Steam list is fixed; the per-save side comes from the bridge's
 * `achievements` query, read from the game's save data instead of AchievementManager.values,
 * which (like Steam) never goes backwards and is shared by every save.
 */

import type { Pilot } from "./pilot.ts";
import { formatMonsterDetails, monsterStatus, type MonsterInfo } from "./bestiary.ts";
import { isRecord, list, num, text } from "./values.ts";

export interface AchievementInfo {
  readonly api: string;
  readonly name: string;
  readonly description: string;
  readonly hidden: boolean;
}

/** The 39 Steam achievements of FF5, in the public page's order. */
export const ACHIEVEMENTS: readonly AchievementInfo[] = [
  {
    api: "all_achievement",
    name: "ＦＦ５大师！",
    description: "获得了所有成就。",
    hidden: false,
  },
  {
    api: "scenario_1",
    name: "旅行的决心",
    description: "救助了蕾娜和加拉夫并一同踏上了旅程。",
    hidden: true,
  },
  {
    api: "scenario_2",
    name: "风之心“探求”",
    description: "领取了风之水晶的力量。",
    hidden: true,
  },
  {
    api: "scenario_3",
    name: "水之心“怜悯”",
    description: "领取了水之水晶的力量。",
    hidden: true,
  },
  {
    api: "scenario_4",
    name: "火之心“勇气”",
    description: "领取了火之水晶的力量。",
    hidden: true,
  },
  {
    api: "scenario_5",
    name: "梦幻黑陆行鸟",
    description: "发现了黑陆行鸟。",
    hidden: true,
  },
  {
    api: "scenario_6",
    name: "古代文明的遗物",
    description: "获得了飞空艇。",
    hidden: true,
  },
  {
    api: "scenario_7",
    name: "土之心“希望”",
    description: "领取了土之水晶的力量。",
    hidden: true,
  },
  {
    api: "scenario_8",
    name: "前往另一个世界",
    description: "来到了加拉夫的世界。",
    hidden: true,
  },
  {
    api: "scenario_9",
    name: "被托付的心愿",
    description: "获得了潜水艇。",
    hidden: true,
  },
  {
    api: "scenario_10",
    name: "被继承之心",
    description: "可露儿继承了加拉夫的力量。",
    hidden: true,
  },
  {
    api: "scenario_11",
    name: "回到原来的世界",
    description: "打倒了艾克斯迪司，回到了原来的世界。",
    hidden: true,
  },
  {
    api: "scenario_12",
    name: "四颗心",
    description: "打倒了新生艾克斯迪司，为世界夺回了和平。",
    hidden: true,
  },
  {
    api: "get_sealed_weapon",
    name: "传说中的武器",
    description: "获得了所有12件被封印的武器。",
    hidden: false,
  },
  {
    api: "get_hidden_job",
    name: "模仿师格格",
    description: "获得了隐藏职业。",
    hidden: false,
  },
  {
    api: "ultimate_omega",
    name: "最强兵器",
    description: "打倒了欧米茄。",
    hidden: false,
  },
  {
    api: "ultimate_dragon",
    name: "最强之龙",
    description: "打倒了神龙。",
    hidden: false,
  },
  {
    api: "piano_master",
    name: "钢琴大师",
    description: "掌握了钢琴。",
    hidden: false,
  },
  {
    api: "magic_learning_10",
    name: "学习·初级",
    description: "通过学习学会了10种青魔法。",
    hidden: false,
  },
  {
    api: "magic_learning_30",
    name: "学习·高级",
    description: "通过学习学会了所有青魔法。",
    hidden: false,
  },
  {
    api: "job_master_1",
    name: "职业新人",
    description: "掌握了某种职业。",
    hidden: false,
  },
  {
    api: "job_master_5",
    name: "职业挑战者",
    description: "掌握了5种职业。",
    hidden: false,
  },
  {
    api: "job_master_15",
    name: "职业高手",
    description: "掌握了15种职业。",
    hidden: false,
  },
  {
    api: "job_master_22",
    name: "职业大师",
    description: "掌握了所有职业。",
    hidden: false,
  },
  {
    api: "level_all_50",
    name: "身经百战的强者们",
    description: "全员达到了50级。",
    hidden: false,
  },
  {
    api: "total_gil_10000",
    name: "中产",
    description: "累计获得了10000金币。",
    hidden: false,
  },
  {
    api: "total_gil_100000",
    name: "富人",
    description: "累计获得了100000金币。",
    hidden: false,
  },
  {
    api: "total_gil_500000",
    name: "大富豪",
    description: "累计获得了500000金币。",
    hidden: false,
  },
  {
    api: "monster_hunt_100",
    name: "见习战士",
    description: "打倒了100只怪物。",
    hidden: false,
  },
  {
    api: "monster_hunt_1000",
    name: "熟练战士",
    description: "打倒了1000只怪物。",
    hidden: false,
  },
  {
    api: "monster_hunt_2000",
    name: "传说战士",
    description: "打倒了2000只怪物。",
    hidden: false,
  },
  {
    api: "picture_book_30",
    name: "魔物图鉴·基础知识篇",
    description: "怪物图鉴的完成率达到了10%。",
    hidden: false,
  },
  {
    api: "picture_book_151",
    name: "魔物图鉴·战斗解析篇",
    description: "怪物图鉴的完成率达到了50%。",
    hidden: false,
  },
  {
    api: "picture_book_302",
    name: "魔物图鉴·完全攻略篇",
    description: "怪物图鉴的完成率达到了100%。",
    hidden: false,
  },
  {
    api: "treasure_box_21",
    name: "新手宝物猎人",
    description: "宝箱的回收率达到了10%。",
    hidden: false,
  },
  {
    api: "treasure_box_112",
    name: "老练宝物猎人",
    description: "宝箱的回收率达到了50%。",
    hidden: false,
  },
  {
    api: "treasure_box_225",
    name: "传奇宝物猎人",
    description: "宝箱的回收率达到了100%。",
    hidden: false,
  },
  {
    api: "get_hidden_item",
    name: "道具猎人",
    description: "获得了所有隐藏道具。",
    hidden: false,
  },
  {
    api: "area_visit",
    name: "探求的冒险者",
    description: "造访了所有地方。",
    hidden: false,
  },
];

/**
 * TreasureBox.TreasureType: which rows are chests and which are hidden items. 10-27 live dump:
 * type 1 totals 225 (Steam's treasure_box_225), and the per-place opens add up to the game's
 * GetOpenChestCount (21) and GetOpenHiddenItemCount (5).
 */
export const TREASURE_KINDS = { chest: 1, hidden: 2 } as const;

export interface AchievementTreasure {
  readonly area: number | null;
  readonly name: string | null;
  readonly type: number | null;
  readonly total: number | null;
  readonly open: number | null;
}

export interface AchievementBestiaryEntry {
  readonly number: number | null;
  readonly name: string | null;
  readonly registered: boolean | null;
  readonly areas: readonly number[];
}

export interface AchievementBestiary {
  readonly entries: readonly AchievementBestiaryEntry[];
  readonly areas: Readonly<Record<string, string | null>>;
}

export interface AchievementDefinition {
  readonly id: number | null;
  readonly api: string | null;
  readonly type: number | null;
  readonly typeName: string | null;
  readonly value: number | null;
  readonly condition: number | null;
  readonly platform: number | null;
}

export interface AchievementAccount {
  readonly api: string | null;
  readonly achieved: boolean | null;
  readonly current: number | null;
  readonly max: number | null;
  readonly name: string | null;
  readonly description: string | null;
}

export interface AchievementJob {
  readonly id: number | null;
  readonly level: number | null;
  readonly mastered: boolean | null;
}

export interface AchievementMember {
  readonly id: number | null;
  readonly name: string | null;
  readonly level: number | null;
  readonly jobs: readonly AchievementJob[];
}

export interface AchievementSave {
  readonly playTime: number | null;
  readonly saveCount: number | null;
  readonly gil: number | null;
  readonly totalGil: number | null;
  readonly kills: number | null;
  readonly battles: number | null;
  readonly chests: number | null;
  readonly openChestCount: number | null;
  readonly hiddenItems: number | null;
  readonly treasure: readonly AchievementTreasure[] | null;
  readonly members: readonly AchievementMember[] | null;
  readonly releasedJobs: readonly number[] | null;
  readonly flags: Readonly<Record<string, readonly (number | null)[]>> | null;
}

export interface AchievementsData {
  readonly defs: readonly AchievementDefinition[];
  readonly account: readonly AchievementAccount[] | null;
  readonly save: AchievementSave | null;
  readonly bestiary: AchievementBestiary | null;
}

export interface AchievementProgress {
  readonly api: string;
  readonly name: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly typeName: string | null;
  readonly current: number | null;
  readonly target: number | null;
  readonly done: boolean;
  readonly steam: boolean | null;
  /** PictureBookComplete is account-wide, so the table says 全账号 next to its number. */
  readonly accountWide: boolean;
}

export interface AchievementViewRow {
  readonly name: string;
  readonly description: string;
  /** The save column, already formatted ("22 / 112 ✓", "读不到", "—"). */
  readonly save: string;
  readonly done: boolean;
  readonly steam: boolean | null;
}

export interface AchievementViewPlace {
  readonly name: string;
  readonly chests: string;
  readonly hidden: string;
  /** "已错过 2" or "限时:…", already formatted; "—" when nothing is lost or timed. */
  readonly lost: string;
  readonly done: boolean;
}

export interface AchievementBestiaryMonster {
  readonly label: string;
  readonly registered: boolean;
  /** "不可再获得", "限时:…", or null. */
  readonly status: string | null;
  readonly details: readonly string[];
}

export interface AchievementBestiaryPlace {
  readonly name: string;
  readonly count: string;
  readonly done: boolean;
  readonly monsters: readonly AchievementBestiaryMonster[];
}

export type AchievementBestiaryView =
  | { readonly message: string }
  | {
      readonly header: string;
      readonly areas: readonly AchievementBestiaryPlace[];
    };

export type AchievementTreasureView =
  | { readonly message: string }
  | {
      readonly header: string;
      /** Missed-chest sentence, absent when no chest is lost for good. */
      readonly warning?: string;
      readonly places: readonly AchievementViewPlace[];
    };

export interface AchievementView {
  readonly title: string;
  /** Normal saves have two lines: game time/saves, then this save vs Steam. */
  readonly summary: readonly string[];
  readonly rows: readonly AchievementViewRow[];
  readonly notes: readonly string[];
  readonly bestiary: AchievementBestiaryView;
  readonly treasure: AchievementTreasureView;
}

const STEAM_PLATFORM = 1; // AchievementManager.Platform.Steam
const ALL_ACHIEVEMENTS = "all_achievement";
/** 10-27 live dump: 封印之间 holds 12 hidden-item boxes, the 12 sealed weapons. */
const SEALED_WEAPONS_AREA = 55;

/**
 * An API name split into its stat and tier. Steam's tiered achievements share one stat row per
 * tier in the master: total_gil_100000 is the row total_gil with Value 100000 (10-27 live dump).
 */
function statOf(api: string): { readonly stat: string; readonly tier: number | null } {
  const match = /^(.*)_(\d+)$/.exec(api);
  const stat = match?.[1];
  const digits = match?.[2];
  return stat === undefined || digits === undefined
    ? { stat: api, tier: null }
    : { stat, tier: Number(digits) };
}

/**
 * The master's Steam row for one achievement of the Steam list. The master also holds a full set
 * of Google Play and iOS rows (195 in all), told apart only by PlatformType.
 */
function steamDefinition(
  defs: readonly AchievementDefinition[],
  api: string,
): AchievementDefinition | undefined {
  const steam = defs.filter((definition) => definition.platform === STEAM_PLATFORM);
  const exact = steam.find((definition) => definition.api === api);
  if (exact !== undefined) return exact;
  const { stat, tier } = statOf(api);
  return steam.find((definition) => definition.api === stat && definition.value === tier);
}

/** The account entry for one achievement: by name, or by stat and target for a tier. */
function accountFor(data: AchievementsData, api: string): AchievementAccount | undefined {
  if (data.account === null) return undefined;
  const exact = data.account.find((entry) => entry.api === api);
  if (exact !== undefined) return exact;
  const { stat, tier } = statOf(api);
  return data.account.find((entry) => entry.api === stat && entry.max === tier);
}

const UNREADABLE = "读不到";

function parseDefinition(value: unknown): AchievementDefinition | null {
  if (!isRecord(value)) return null;
  return {
    id: num(value.id) ?? null,
    api: text(value.api) ?? null,
    type: num(value.type) ?? null,
    typeName: text(value.typeName) ?? null,
    value: num(value.value) ?? null,
    condition: num(value.condition) ?? null,
    platform: num(value.platform) ?? null,
  };
}

function parseAccount(value: unknown): AchievementAccount | null {
  if (!isRecord(value)) return null;
  return {
    api: text(value.api) ?? null,
    achieved: typeof value.achieved === "boolean" ? value.achieved : null,
    current: num(value.current) ?? null,
    max: num(value.max) ?? null,
    name: text(value.name) ?? null,
    description: text(value.description) ?? null,
  };
}

function parseJob(value: unknown): AchievementJob | null {
  if (!isRecord(value)) return null;
  return {
    id: num(value.id) ?? null,
    level: num(value.level) ?? null,
    mastered: typeof value.mastered === "boolean" ? value.mastered : null,
  };
}

function parseMember(value: unknown): AchievementMember | null {
  if (!isRecord(value)) return null;
  return {
    id: num(value.id) ?? null,
    name: text(value.name) ?? null,
    level: num(value.level) ?? null,
    jobs: list(value.jobs)
      .map(parseJob)
      .filter((job): job is AchievementJob => job !== null),
  };
}

function parseTreasure(value: unknown): AchievementTreasure | null {
  if (!isRecord(value)) return null;
  return {
    area: num(value.area) ?? null,
    name: text(value.name) ?? null,
    type: num(value.type) ?? null,
    total: num(value.total) ?? null,
    open: num(value.open) ?? null,
  };
}

function parseBestiaryEntry(value: unknown): AchievementBestiaryEntry | null {
  if (!isRecord(value)) return null;
  return {
    number: num(value.number) ?? null,
    name: text(value.name) ?? null,
    registered: typeof value.registered === "boolean" ? value.registered : null,
    areas: list(value.areas)
      .map((area) => num(area) ?? null)
      .filter((area): area is number => area !== null),
  };
}

function parseBestiary(value: unknown): AchievementBestiary | null {
  if (!isRecord(value)) return null;
  const areas: Record<string, string | null> = {};
  if (isRecord(value.areas)) {
    for (const [key, item] of Object.entries(value.areas)) areas[key] = text(item) ?? null;
  }
  return {
    entries: list(value.entries)
      .map(parseBestiaryEntry)
      .filter((entry): entry is AchievementBestiaryEntry => entry !== null),
    areas,
  };
}

function parseFlags(value: unknown): Record<string, (number | null)[]> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, (number | null)[]> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = list(item).map((bank) => num(bank) ?? null);
  }
  return out;
}

function parseSave(value: unknown): AchievementSave | null {
  if (!isRecord(value)) return null;
  return {
    playTime: num(value.playTime) ?? null,
    saveCount: num(value.saveCount) ?? null,
    gil: num(value.gil) ?? null,
    totalGil: num(value.totalGil) ?? null,
    kills: num(value.kills) ?? null,
    battles: num(value.battles) ?? null,
    chests: num(value.chests) ?? null,
    openChestCount: num(value.openChestCount) ?? null,
    hiddenItems: num(value.hiddenItems) ?? null,
    treasure: Array.isArray(value.treasure)
      ? value.treasure.map(parseTreasure).filter((row): row is AchievementTreasure => row !== null)
      : null,
    members: Array.isArray(value.members)
      ? value.members
          .map(parseMember)
          .filter((member): member is AchievementMember => member !== null)
      : null,
    releasedJobs: Array.isArray(value.releasedJobs)
      ? value.releasedJobs.map((id) => num(id) ?? null).filter((id): id is number => id !== null)
      : null,
    flags: parseFlags(value.flags),
  };
}

/**
 * Narrow one bridge reply into achievement data. Missing fields and nulls stay null; a broken
 * row is skipped rather than failing the whole command. Accepts either the reply itself or its
 * `achievements` member, so callers need not know which layer they hold.
 */
export function parseAchievements(reply: unknown): AchievementsData {
  const body = isRecord(reply) && isRecord(reply.achievements) ? reply.achievements : reply;
  const source = isRecord(body) ? body : {};
  return {
    defs: list(source.defs)
      .map(parseDefinition)
      .filter((definition): definition is AchievementDefinition => definition !== null),
    account: Array.isArray(source.account)
      ? source.account
          .map(parseAccount)
          .filter((entry): entry is AchievementAccount => entry !== null)
      : null,
    save: parseSave(source.save),
    bestiary: parseBestiary(source.bestiary),
  };
}

/** One successful bestiary read, cached for the plugin process (task 18: static areas). */
export class BestiaryAreaCache {
  private cached: AchievementBestiary | null = null;

  async load(pilot: Pilot, signal: AbortSignal): Promise<AchievementBestiary | null> {
    if (this.cached !== null) return this.cached;
    try {
      const reply = await pilot.query("achievements");
      const bestiary = parseAchievements(reply).bestiary;
      if (bestiary === null) return null;
      this.cached = bestiary;
      return bestiary;
    } catch {
      signal.throwIfAborted();
      return null;
    }
  }
}

interface SaveProgress {
  readonly current: number;
  readonly target: number | null;
  readonly accountWide?: boolean;
}

type SaveRule = (
  definition: AchievementDefinition,
  data: AchievementsData,
  api: string,
) => SaveProgress | null;

/** The master's Value; when it is 0 or missing, the number at the end of the Steam API name. */
function targetOf(definition: AchievementDefinition, api: string): number | null {
  if (definition.value !== null && definition.value !== 0) return definition.value;
  return statOf(api).tier;
}

function progress(current: number | null | undefined, target: number | null): SaveProgress | null {
  return current === undefined || current === null ? null : { current, target };
}

function memberLevel(
  definition: AchievementDefinition,
  data: AchievementsData,
  api: string,
): SaveProgress | null {
  const levels = (data.save?.members ?? [])
    .map((member) => member.level)
    .filter((level): level is number => level !== null);
  if (levels.length === 0) return null;
  return { current: Math.min(...levels), target: targetOf(definition, api) };
}

function jobMasters(
  definition: AchievementDefinition,
  data: AchievementsData,
  api: string,
): SaveProgress | null {
  const members = data.save?.members ?? [];
  if (members.length === 0) return null;
  const mastered = new Set<number>();
  for (const member of members) {
    for (const job of member.jobs) {
      if (job.mastered === true && job.id !== null) mastered.add(job.id);
    }
  }
  return { current: mastered.size, target: targetOf(definition, api) };
}

/** 10-27 live dump: the first bank holds the story flags (scenario_1–3 set, the rest clear). */
function scenario(definition: AchievementDefinition, data: AchievementsData): SaveProgress | null {
  const condition = definition.condition;
  const flags = data.save?.flags;
  if (condition === null || flags === undefined || flags === null) return null;
  const first = flags[String(condition)]?.[0];
  return first === undefined || first === null ? null : { current: first === 0 ? 0 : 1, target: 1 };
}

/** Opened and total boxes of one kind, over the places that pass the filter. */
function treasureCount(
  data: AchievementsData,
  kind: number,
  where: (row: AchievementTreasure) => boolean = () => true,
): { readonly open: number | null; readonly total: number } | null {
  const rows = (data.save?.treasure ?? []).filter((row) => row.type === kind && where(row));
  if (rows.length === 0) return null;
  const open = rows.some((row) => row.open === null)
    ? null
    : rows.reduce((sum, row) => sum + (row.open ?? 0), 0);
  return { open, total: rows.reduce((sum, row) => sum + (row.total ?? 0), 0) };
}

/** The master's Value is 1 ("all of them"), so the target is the hidden-item total. */
function hiddenItems(
  _definition: AchievementDefinition,
  data: AchievementsData,
): SaveProgress | null {
  return progress(
    data.save?.hiddenItems,
    treasureCount(data, TREASURE_KINDS.hidden)?.total ?? null,
  );
}

function sealedWeapons(
  _definition: AchievementDefinition,
  data: AchievementsData,
): SaveProgress | null {
  const count = treasureCount(
    data,
    TREASURE_KINDS.hidden,
    (row) => row.area === SEALED_WEAPONS_AREA,
  );
  return count === null ? null : progress(count.open, count.total);
}

function pictureBook(
  definition: AchievementDefinition,
  data: AchievementsData,
  api: string,
): SaveProgress | null {
  const result = progress(accountFor(data, api)?.current, targetOf(definition, api));
  return result === null ? null : { ...result, accountWide: true };
}

/**
 * The per-save rules, keyed by the master's Type name. Types outside this table are unreadable:
 * LearningBlueMagic (OwnedMagicList is not the learned list: 10-27 it held none of the party's
 * white or black magic), IdentificationSenarios (piano) and BaseBookComplete (places).
 */
const SAVE_RULES: Readonly<Record<string, SaveRule>> = {
  SlotTotalGil: (definition, data, api) => progress(data.save?.totalGil, targetOf(definition, api)),
  OwnedGil: (definition, data, api) => progress(data.save?.gil, targetOf(definition, api)),
  MonsterSubjugationCount: (definition, data, api) =>
    progress(data.save?.kills, targetOf(definition, api)),
  ChestComplete: (definition, data, api) => progress(data.save?.chests, targetOf(definition, api)),
  HiddenItems: hiddenItems,
  SpecificItems: sealedWeapons,
  MemberLevel: memberLevel,
  JobMasters: jobMasters,
  Scenario: scenario,
  PictureBookComplete: pictureBook,
};

function makeRow(
  info: AchievementInfo,
  definition: AchievementDefinition | undefined,
  progressValue: SaveProgress | null,
  steam: boolean | null,
): AchievementProgress {
  const current = progressValue?.current ?? null;
  const target =
    progressValue?.target ?? (definition === undefined ? null : targetOf(definition, info.api));
  return {
    api: info.api,
    name: info.name,
    description: info.description,
    hidden: info.hidden,
    typeName: definition?.typeName ?? null,
    current,
    target,
    done: current !== null && target !== null && current >= target,
    steam,
    accountWide: progressValue?.accountWide ?? false,
  };
}

function achievementRow(info: AchievementInfo, data: AchievementsData): AchievementProgress {
  const definition = steamDefinition(data.defs, info.api);
  const rule = definition?.typeName === null ? undefined : SAVE_RULES[definition?.typeName ?? ""];
  const progressValue =
    definition === undefined || rule === undefined || data.save === null
      ? null
      : rule(definition, data, info.api);
  return makeRow(info, definition, progressValue, accountFor(data, info.api)?.achieved ?? null);
}

/**
 * all_achievement counts the other rows. Its own account flag is not used: 10-27 the account
 * list said achieved with current 0 and max 0, though the game never reported it to Steam.
 */
function allRow(
  info: AchievementInfo,
  others: readonly AchievementProgress[],
  data: AchievementsData,
): AchievementProgress {
  const definition = steamDefinition(data.defs, info.api);
  const done = others.filter((row) => row.done).length;
  const progressValue = data.save === null ? null : { current: done, target: others.length };
  const steam = data.account === null ? null : others.every((row) => row.steam === true);
  return makeRow(info, definition, progressValue, steam);
}

/** One row per Steam achievement, in the Steam page's order. */
export function progressRows(data: AchievementsData): AchievementProgress[] {
  const others = ACHIEVEMENTS.filter((info) => info.api !== ALL_ACHIEVEMENTS).map((info) =>
    achievementRow(info, data),
  );
  return ACHIEVEMENTS.map((info) =>
    info.api === ALL_ACHIEVEMENTS
      ? allRow(info, others, data)
      : (others.find((row) => row.api === info.api) ?? achievementRow(info, data)),
  );
}

export function formatNumber(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatCount(value: number | null): string {
  return value === null ? "?" : formatNumber(value);
}

function formatPlayTime(seconds: number | null): string {
  if (seconds === null) return "?";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function saveCell(row: AchievementProgress): string {
  if (row.current === null) return UNREADABLE;
  if (row.typeName === "Scenario") return row.done ? "✓" : "未达成"; // a flag, not a count
  let text = `${formatNumber(row.current)} / ${formatCount(row.target)}`;
  if (row.done) text += " ✓";
  if (row.accountWide) text += "(全账号)";
  return text;
}

function treasureTotal(rows: readonly AchievementTreasure[], kind: number): number {
  return rows.filter((row) => row.type === kind).reduce((sum, row) => sum + (row.total ?? 0), 0);
}

function treasureOpen(
  rows: readonly AchievementTreasure[],
  kind: number,
  fallback: number | null,
): string {
  if (fallback !== null) return formatNumber(fallback);
  const selected = rows.filter((row) => row.type === kind);
  if (selected.some((row) => row.open === null)) return UNREADABLE;
  return formatNumber(selected.reduce((sum, row) => sum + (row.open ?? 0), 0));
}

function treasureCell(rows: readonly AchievementTreasure[], kind: number): string {
  const selected = rows.filter((row) => row.type === kind);
  const total = selected.reduce((sum, row) => sum + (row.total ?? 0), 0);
  if (total === 0) return "—";
  if (selected.some((row) => row.open === null)) return `${UNREADABLE} / ${formatNumber(total)}`;
  const open = selected.reduce((sum, row) => sum + (row.open ?? 0), 0);
  return `${formatNumber(open)} / ${formatNumber(total)}${open >= total ? " ✓" : ""}`;
}

interface OneTimePlace {
  readonly area: number;
  /** Until when its boxes can still be taken, for the warning. */
  readonly until: string;
  /** The first story achievement certainly after the deadline; without one the row only warns. */
  readonly past?: string;
}

/**
 * Places whose boxes are lost for good after a story point, from the Steam missables guide
 * (.deps/knowledge/ff5, read 10-27); area ids from the 10-27 live dump. `past` is the nearest
 * story flag we can read that the deadline is surely behind, so a set flag never misjudges a box
 * that can still be taken; between the deadline and that flag the row still only warns.
 */
const ONE_TIME_PLACES: ReadonlyMap<number, OneTimePlace> = new Map(
  (
    [
      { area: 71, until: "打倒塔顶首领前", past: "scenario_3" }, // 沃尔斯塔: the water crystal is at the top
      { area: 24, until: "火力船首领后的 10 分钟逃脱里", past: "scenario_5" }, // 卡纳克城
      { area: 34, until: "打倒首领前", past: "scenario_7" }, // 隆卡遗迹: the earth crystal
      { area: 57, until: "打倒首领前", past: "scenario_10" }, // 屏障之塔
      { area: 79, until: "离开森林前", past: "scenario_11" }, // 慕亚大森林
      { area: 86, until: "离开森林前", past: "scenario_11" }, // 慕亚大森林, the changed forest
      { area: 40, until: "打倒十三层的艾克斯迪司前", past: "scenario_11" }, // 艾克斯迪司城
      { area: 28, until: "打倒金字塔首领前" }, // 古代图书馆
      { area: 67, until: "打倒首领前" }, // 两歧塔 黑塔
      { area: 68, until: "打倒首领前" }, // 两歧塔 白塔
    ] satisfies OneTimePlace[]
  ).map((place) => [place.area, place]),
);

function storyPassed(data: AchievementsData, api: string): boolean {
  const definition = steamDefinition(data.defs, api);
  return definition !== undefined && scenario(definition, data)?.current === 1;
}

interface Lost {
  readonly missed: number;
  /** A one-time place with boxes left and its deadline not yet behind us. */
  readonly until: string | null;
}

/** The boxes of these rows that are gone for good, and the warning for the ones still open. */
function lostBoxes(rows: readonly AchievementTreasure[], data: AchievementsData): Lost {
  let missed = 0;
  let until: string | null = null;
  for (const row of rows) {
    const place = row.area === null ? undefined : ONE_TIME_PLACES.get(row.area);
    const left = (row.total ?? 0) - (row.open ?? 0);
    if (place === undefined || row.open === null || left <= 0) continue;
    if (place.past !== undefined && storyPassed(data, place.past)) missed += left;
    else until ??= place.until;
  }
  return { missed, until };
}

function lostCell(rows: readonly AchievementTreasure[], data: AchievementsData): string {
  const { missed, until } = lostBoxes(rows, data);
  if (missed > 0) return `已错过 ${formatNumber(missed)}`;
  return until === null ? "—" : `限时:${until}`;
}

function placeName(row: AchievementTreasure): string {
  if (row.name !== null && row.name !== "") return row.name;
  return row.area === null ? "地点 ?" : `地点 ${row.area}`;
}

/**
 * Rows grouped by place name, in area order. One name can cover two areas with their own boxes
 * (10-27: 慕亚大森林 is areas 79 and 86, 12 each, all counted in the 225), so they share a row.
 */
function byPlace(treasure: readonly AchievementTreasure[]): Map<string, AchievementTreasure[]> {
  const sorted = [...treasure].sort(
    (left, right) =>
      (left.area ?? Number.MAX_SAFE_INTEGER) - (right.area ?? Number.MAX_SAFE_INTEGER),
  );
  const places = new Map<string, AchievementTreasure[]>();
  for (const row of sorted) {
    const name = placeName(row);
    places.set(name, [...(places.get(name) ?? []), row]);
  }
  return places;
}

function treasureView(data: AchievementsData): AchievementTreasureView {
  const save = data.save;
  if (save?.treasure == null) {
    return { message: "桥插件还读不到按地点的宝箱数" };
  }
  const treasure = save.treasure;
  const chestTotal = treasureTotal(treasure, TREASURE_KINDS.chest);
  const hiddenTotal = treasureTotal(treasure, TREASURE_KINDS.hidden);
  const header =
    `宝箱和隐藏道具(按地点) 宝箱 ` +
    `${treasureOpen(treasure, TREASURE_KINDS.chest, save.chests)} / ${formatNumber(chestTotal)} · ` +
    `隐藏道具 ${treasureOpen(treasure, TREASURE_KINDS.hidden, save.hiddenItems)} / ${formatNumber(hiddenTotal)}`;
  const missedChests = lostBoxes(
    treasure.filter((row) => row.type === TREASURE_KINDS.chest),
    data,
  ).missed;
  const warning =
    missedChests > 0
      ? `已错过 ${formatNumber(missedChests)} 个宝箱，这个存档拿不到「传奇宝物猎人」(100%)`
      : undefined;
  const places = [...byPlace(treasure)].map(([name, rows]) => ({
    name,
    chests: treasureCell(rows, TREASURE_KINDS.chest),
    hidden: treasureCell(rows, TREASURE_KINDS.hidden),
    lost: lostCell(rows, data),
    done: rows.every((row) => row.total !== null && row.open !== null && row.open >= row.total),
  }));
  return warning === undefined ? { header, places } : { header, warning, places };
}

/** The notes under the achievement table; empty when none of them applies. */
function achievementNotes(rows: readonly AchievementProgress[], save: AchievementSave): string[] {
  const notes: string[] = [];
  if (rows.some((row) => row.typeName === "MonsterSubjugationCount")) {
    notes.push(`击杀：本档 ${formatCount(save.kills)} 只;Steam 的击杀数是全账号累计的`);
  }
  if (rows.some((row) => row.typeName === "PictureBookComplete")) {
    notes.push("图鉴全账号共用，没有本档进度");
  }
  if (rows.some((row) => row.current === null)) {
    notes.push("桥插件还读不到这些成就的本档进度");
  }
  return notes;
}

/**
 * Area 0 has no Area row. 10-27 live dump: its monsters are the overworld's (goblin, killer bee,
 * nut eater, porcupine), so it is the world map.
 */
const WORLD_MAP_AREA = 0;

function habitatName(names: Readonly<Record<string, string | null>>, area: number): string {
  const known = names[String(area)];
  if (known !== null && known !== undefined && known !== "") return known;
  return area === WORLD_MAP_AREA ? "世界地图" : `地点 ${area}`;
}

export interface MonsterGuide {
  monsterNote(book: number): string;
}

function monsterLabel(entry: AchievementBestiaryEntry): string {
  const number = `No.${String(entry.number ?? 0).padStart(3, "0")}`;
  return entry.name !== null && entry.name !== "" ? `${number} ${entry.name}` : number;
}

/** One row per place name, with all entries and their details/status. */
function bestiaryView(
  data: AchievementsData,
  monsters: readonly MonsterInfo[] | null,
  guide: MonsterGuide | null,
): AchievementBestiaryView {
  const bestiary = data.bestiary;
  if (bestiary === null) return { message: "桥插件还读不到图鉴" };
  const infoByNumber = new Map<number, MonsterInfo>();
  for (const info of monsters ?? []) {
    if (info.number !== null) infoByNumber.set(info.number, info);
  }
  const statusByNumber = new Map<number, string | null>();
  for (const entry of bestiary.entries) {
    const number = entry.number ?? 0;
    statusByNumber.set(
      number,
      entry.registered === true
        ? null
        : monsterStatus(number, entry.areas, (api) => storyPassed(data, api)),
    );
  }
  const missedTotal = bestiary.entries.filter(
    (entry) => statusByNumber.get(entry.number ?? 0) === "不可再获得",
  ).length;
  const registered = bestiary.entries.filter((entry) => entry.registered === true).length;
  const suffix = missedTotal > 0 ? ` · 这个存档已错过 ${formatNumber(missedTotal)} 只` : "";
  const header = `魔物图鉴(全账号共用) 已登记 ${formatNumber(registered)} / ${formatNumber(bestiary.entries.length)}${suffix}`;
  const places = new Map<
    string,
    { minArea: number; entries: Map<number, AchievementBestiaryEntry> }
  >();
  for (const entry of bestiary.entries) {
    const number = entry.number ?? 0;
    for (const area of entry.areas) {
      const name = habitatName(bestiary.areas, area);
      let place = places.get(name);
      if (place === undefined) {
        place = { minArea: area, entries: new Map() };
        places.set(name, place);
      } else {
        place.minArea = Math.min(place.minArea, area);
      }
      place.entries.set(number, entry);
    }
  }
  const areas = [...places.entries()]
    .sort((left, right) => left[1].minArea - right[1].minArea)
    .map(([name, place]) => {
      const entries = [...place.entries.values()].sort(
        (left, right) => (left.number ?? 0) - (right.number ?? 0),
      );
      const done = entries.filter((entry) => entry.registered === true).length;
      const monstersInPlace = entries.map((entry) => {
        const number = entry.number ?? 0;
        const status = statusByNumber.get(number) ?? null;
        const info = infoByNumber.get(number);
        const habitats = [...new Set(entry.areas.map((area) => habitatName(bestiary.areas, area)))];
        const guideNote = guide?.monsterNote(number) ?? null;
        return {
          label: monsterLabel(entry),
          registered: entry.registered === true,
          status,
          details:
            info === undefined ? [] : formatMonsterDetails(info, habitats, guideNote, status),
        };
      });
      const missed = monstersInPlace.filter((monster) => monster.status === "不可再获得").length;
      const count =
        `${formatNumber(done)} / ${formatNumber(entries.length)}` +
        (done === entries.length ? " ✓" : "") +
        (missed > 0 ? ` · 已错过 ${formatNumber(missed)}` : "");
      return { name, count, done: done === entries.length, monsters: monstersInPlace };
    });
  return { header, areas };
}

/** The structured content behind `/ach` and the sidebar panel. */
export function achievementView(
  data: AchievementsData,
  monsters: readonly MonsterInfo[] | null = null,
  guide: MonsterGuide | null = null,
): AchievementView {
  const rows = progressRows(data);
  const total = rows.length;
  const title = "FF5 成就 · 当前存档";
  let summary: string[];
  if (data.save === null) {
    summary = ["还没读档，只能看 Steam 的解锁情况。"];
  } else {
    const local = rows.filter((row) => row.current !== null && row.done).length;
    const steam =
      data.account === null
        ? "Steam 进度读不到"
        : `Steam 已解锁 ${formatNumber(rows.filter((row) => row.steam === true).length)} / ${formatNumber(total)}`;
    summary = [
      `游戏时间 ${formatPlayTime(data.save.playTime)},存过 ${formatCount(data.save.saveCount)} 次`,
      `本档达成 ${formatNumber(local)} / ${formatNumber(total)} · ${steam}`,
    ];
  }
  return {
    title,
    summary,
    rows: rows.map((row) => ({
      name: row.name,
      description: row.description,
      save: data.save === null ? "—" : saveCell(row),
      done: row.done,
      steam: row.steam,
    })),
    notes: data.save === null ? [] : achievementNotes(rows, data.save),
    bestiary: bestiaryView(data, monsters, guide),
    treasure: treasureView(data),
  };
}

function formatView(view: AchievementView): string {
  const lines: string[] = [`**${view.title}**`];
  const first = view.summary[0];
  if (first !== undefined) {
    if (view.summary.length > 1) {
      lines[0] = `${lines[0] ?? ""}(${first})`;
      lines.push(...view.summary.slice(1));
    } else {
      lines.push(first);
    }
  }
  lines.push("", "| 成就 | 条件 | 本档 | Steam |", "| --- | --- | --- | --- |");
  for (const row of view.rows) {
    lines.push(
      `| ${cell(row.name)} | ${cell(row.description)} | ${row.save} | ${row.steam === true ? "✓" : "—"} |`,
    );
  }
  if (view.notes.length > 0) lines.push("", ...view.notes);
  const bestiary = view.bestiary;
  if ("message" in bestiary) {
    lines.push("", bestiary.message);
  } else {
    lines.push("", bestiary.header);
    if (bestiary.areas.length > 0) {
      lines.push("", "| 地点 | 已登记 | 未登记 | 不可再获得 |", "| --- | --- | --- | --- |");
      for (const area of bestiary.areas) {
        const missing = area.monsters
          .filter((monster) => !monster.registered)
          .map((monster) => monster.label)
          .join("、");
        const missed = area.monsters
          .filter((monster) => monster.status === "不可再获得")
          .map((monster) => monster.label.split(" ")[0] ?? monster.label)
          .join("、");
        lines.push(`| ${cell(area.name)} | ${area.count} | ${cell(missing)} | ${cell(missed)} |`);
      }
    }
  }
  // No save means the whole per-place section is absent (task 13's exact /ach output).
  if (view.summary.length > 1) {
    const treasure = view.treasure;
    if ("message" in treasure) {
      lines.push("", treasure.message);
    } else {
      lines.push(
        "",
        treasure.header.replace("宝箱和隐藏道具(按地点)", "**宝箱和隐藏道具(按地点)**"),
      );
      if (treasure.warning !== undefined) lines.push(treasure.warning);
      if (treasure.places.length > 0) {
        lines.push("", "| 地点 | 宝箱 | 隐藏道具 | 不可回收 |", "| --- | --- | --- | --- |");
        for (const place of treasure.places) {
          lines.push(`| ${cell(place.name)} | ${place.chests} | ${place.hidden} | ${place.lost} |`);
        }
      }
    }
  }
  return lines.join("\n");
}

/** Markdown for `/ach`: the save's progress next to Steam's unlocked flag for each achievement. */
export function formatAchievements(data: AchievementsData | AchievementView): string {
  return formatView("defs" in data ? achievementView(data) : data);
}
