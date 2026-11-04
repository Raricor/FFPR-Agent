/**
 * Build the key log (design doc §12.2) from bridge probe records, ported from
 * ffpr_agent/logs/key_log.py. Each probe file is one run; entries come from what the bridge
 * reports: chest dialogs and the game's chest counter, "得到了【X】" lines, party levels, who
 * joins and leaves, story scenes, battles, bestiary registrations, saves and first visits.
 *
 * The same Builder runs live in events.ts, fed from the bridge's stream; its entries are the
 * windows of key events the planning layers read. The command line (render, main, build) is not
 * part of the plugin.
 */

import { readFile } from "node:fs/promises";
import { describeError } from "./errors.ts";
import { isRecord, list, num, records, text, truthy, type Json } from "./values.ts";

/** Shanghai time is fixed at +08:00 (no daylight saving). */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const BRACKETED = /【([^】]+)】/u;
const GOT = /(得到了|获得了|拿到了)/u;
const SCENE = /^(E\d+_\d+_\d+)/;
// A scene's lines more than this far apart are two visits (the same scene can replay).
const SCENE_GAP_S = 120;

export const LABEL: Readonly<Record<string, string>> = {
  run: "运行",
  place: "地点",
  chest: "宝箱",
  item: "道具",
  level: "升级",
  party: "队伍",
  story: "剧情",
  bossfight: "首领战",
  boss: "首领",
  defeat: "战败",
  bestiary: "图鉴",
  save: "存档",
  buy: "购买",
  equip: "装备",
};

export interface KeyEntry {
  ts: string;
  run: string;
  seq?: unknown;
  key: true;
  type: string;
  text: string;
  progress: string;
  data?: Json;
}

interface BattleState {
  record: Json;
  gil: number | null;
  counts: [number | null, number | null];
  enemies: string[];
  boss: boolean | null;
  announced: boolean;
}

/** Python's datetime.fromisoformat(stamp).astimezone(SHANGHAI), as an absolute instant. */
export function localTime(stamp: string): Date {
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) throw new Error(`读不懂时间戳:${stamp}`);
  return date;
}

/** ISO text in Shanghai time with second precision, Python's isoformat(timespec="seconds"). */
export function formatLocalTime(value: Date): string {
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hour = String(shifted.getUTCHours()).padStart(2, "0");
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  const second = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
}

export async function load(path: string, signal?: AbortSignal): Promise<Json[]> {
  let body: string;
  try {
    body = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`读不了探针文件 ${path}:${describeError(error)}`, { cause: error });
  }
  const records_: Json[] = [];
  for (const line of body.split(/\r\n|\r|\n/)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) records_.push(parsed);
    } catch {
      // The game may be mid-write on the last line; a bad line is skipped, like Python.
    }
  }
  return records_;
}

/** Python's `user.get("wins"), user.get("escapes")`; null stands in for None. */
export function counters(user: Json): [number | null, number | null] {
  return [num(user.wins) ?? null, num(user.escapes) ?? null];
}

/** The story scene a dialog belongs to: E0001_00_071 for E0001_00_071_a_01. */
export function sceneOf(ids: readonly unknown[]): string | null {
  for (const value of ids) {
    const id = text(value) ?? "";
    const match = SCENE.exec(id);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function partyLevels(sample: Json): Map<string, number> {
  const levels = new Map<string, number>();
  for (const member of records(sample.party)) {
    const name = text(member.name);
    const level = num(member.lv);
    if (name && level !== undefined) levels.set(name, level);
  }
  return levels;
}

function partyNames(sample: Json): string[] {
  const names: string[] = [];
  for (const member of records(sample.party)) {
    const name = text(member.name);
    if (name) names.push(name);
  }
  return names;
}

function battleEnemyNames(battle: Json): string[] {
  const names: string[] = [];
  for (const enemy of records(battle.enemies)) {
    const name = text(enemy.name);
    if (name) names.push(name);
  }
  return names;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Python's f-string on a JSON scalar: a missing value prints as "None". */
function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value) || "";
}

/** Walks one run's records in order and emits key entries. */
export class Builder {
  readonly run: string;
  readonly entries: KeyEntry[] = [];
  levels = new Map<string, number>();
  places = new Set<string>();
  chests: number | null = null;
  gil: number | null = null;
  pictureBook: unknown = null;
  battle: BattleState | null = null;
  party: string[] | null = null;
  story: KeyEntry | null = null;
  storyAt: Date | null = null;
  pendingChest: [string, Json] | null = null;
  // The level entry being merged: name → [from, to] and when it was last updated.
  levelChanges = new Map<string, [number, number]>();
  levelAt: Date | null = null;

  constructor(run: string) {
    this.run = run;
  }

  add(record: Json, kind: string, entryText: string, progress = "—", data: Json = {}): void {
    const stamp = text(record.t);
    if (stamp === undefined) throw new Error("探针记录缺少时间 t,没法写关键日志");
    const entry: KeyEntry = {
      ts: formatLocalTime(localTime(stamp)),
      run: this.run,
      seq: record.seq ?? null,
      key: true,
      type: kind,
      text: entryText,
      progress,
    };
    if (Object.keys(data).length > 0) entry.data = data;
    this.entries.push(entry);
  }

  feed(record: Json): void {
    switch (record.type) {
      case "hello":
        this.onHello(record);
        break;
      case "sample":
        this.onSample(record);
        break;
      case "dialog.play":
        this.onDialogPlay(record);
        break;
      case "save.write":
        this.onSaveWrite(record);
        break;
      case "bestiary.register":
        this.onBestiaryRegister(record);
        break;
      case "steam.setProgress":
      case "achievement.steamProgress": // bridge before 0.1.1
        this.onSteamSetProgress(record);
        break;
      default:
        break;
    }
  }

  onHello(record: Json): void {
    this.add(
      record,
      "run",
      `开始:${scalarText(record.product)} ${scalarText(record.gameVersion)},桥插件 ${scalarText(record.plugin)}`,
    );
  }

  onSample(record: Json): void {
    const user = isRecord(record.user) ? record.user : {};
    const battle = isRecord(record.battle) ? record.battle : {};
    const place = text(user.areaText);
    if (place && !this.places.has(place)) {
      this.places.add(place);
      this.add(record, "place", `首次到达「${place}」`, "—", { map: user.mapId ?? null });
    }

    const chests = num(user.chests);
    if (this.pendingChest && chests !== undefined) {
      const [item, chestRecord] = this.pendingChest;
      const progress = chests !== 0 ? `本作已开 ${chests} 个` : "—";
      this.add(chestRecord, "chest", `地图 ${scalarText(user.mapId)}:${item}`, progress, { item });
      this.pendingChest = null;
    }
    if (chests !== undefined) this.chests = chests;

    if (truthy(battle.active)) {
      this.startBattle(record, user, battle);
    } else if (this.battle !== null) {
      this.endBattle(record, user);
    }

    const names = partyNames(record); // empty on the title screen and while a save loads
    if (names.length > 0) this.partyChange(record, names);

    const levels = partyLevels(record);
    const ups = new Map<string, number>();
    for (const [name, level] of levels) {
      if (level > (this.levels.get(name) ?? level)) ups.set(name, level);
    }
    if (ups.size > 0) this.levelUp(record, ups, Math.min(...levels.values()));
    if (levels.size > 0) this.levels = levels;
    if (num(user.gil) !== undefined) this.gil = num(user.gil) ?? null;
  }

  private startBattle(record: Json, user: Json, battle: Json): void {
    if (this.battle === null) {
      this.battle = {
        record,
        gil: this.gil,
        counts: counters(user),
        enemies: [],
        boss: null,
        announced: false,
      };
      this.levelAt = null; // level-ups after this battle get their own entry
    }
    const names = battleEnemyNames(battle);
    if (names.length > 0) this.battle.enemies = names;
    if (Object.hasOwn(battle, "boss")) {
      // bridge 0.3.1+: the monster master's boss flag
      this.battle.boss = Boolean(battle.boss) || Boolean(this.battle.boss);
    }
    if (this.battle.boss && this.battle.enemies.length > 0 && !this.battle.announced) {
      this.battle.announced = true;
      const enemies = unique(this.battle.enemies).join("、");
      this.add(record, "bossfight", `开始:「${enemies}」`, "—", {
        enemies: this.battle.enemies,
      });
    }
  }

  private partyChange(record: Json, names: string[]): void {
    if (this.party !== null) {
      const size = `队伍 ${names.length} 人`;
      for (const name of this.party) {
        if (!names.includes(name)) {
          this.add(record, "party", `${name} 离队`, size, { name, change: "leave" });
        }
      }
      for (const name of names) {
        if (!this.party.includes(name)) {
          this.add(record, "party", `${name} 入队`, size, { name, change: "join" });
        }
      }
    }
    this.party = names;
  }

  /**
   * One entry per battle: the result screen updates members one by one, so changes within 90 s
   * with no other entry in between join the previous level entry.
   */
  private levelUp(record: Json, ups: Map<string, number>, lowest: number): void {
    const stamp = text(record.t);
    if (stamp === undefined) throw new Error("探针记录缺少时间 t,没法写升级记录");
    const now = localTime(stamp);
    let last = this.entries[this.entries.length - 1];
    const joined =
      last?.type === "level" &&
      this.levelAt !== null &&
      (now.getTime() - this.levelAt.getTime()) / 1000 <= 90;
    if (!joined) {
      this.levelChanges = new Map();
      this.add(record, "level", "", "");
      last = this.entries[this.entries.length - 1];
    }
    for (const [name, level] of ups) {
      const from = this.levels.get(name);
      if (from === undefined) continue;
      const change = this.levelChanges.get(name);
      if (change) change[1] = level;
      else this.levelChanges.set(name, [from, level]);
    }
    if (last === undefined) return;
    last.text = [...this.levelChanges]
      .map(([name, [from, to]]) => `${name} ${from}→${to}`)
      .join("、");
    last.progress = `全员最低 Lv${lowest}`;
    this.levelAt = now;
  }

  private endBattle(record: Json, user: Json): void {
    const start = this.battle;
    this.battle = null;
    if (start === null) return;
    const gained = (num(user.gil) ?? 0) - (start.gil ?? 0);
    const party = records(record.party);
    const alive = party.every((member) => (num(member.hp) ?? 0) > 0);
    const wiped = party.length > 0 && party.every((member) => (num(member.hp) ?? 0) <= 0);
    const down = party
      .filter((member) => (num(member.hp) ?? 0) <= 0)
      .map((member) => text(member.name))
      .filter((name): name is string => name !== undefined);
    const enemies = unique(start.enemies).join("、") || "未知敌人";
    const [wins, escapes] = start.counts;
    const [winsNow, escapesNow] = counters(user);
    let outcome: "win" | "fled" | "lost" | null = null;
    if (wins !== null && escapes !== null && winsNow !== null && escapesNow !== null) {
      outcome = winsNow > wins ? "win" : escapesNow > escapes ? "fled" : "lost";
    }
    if (outcome === "lost" || (outcome === null && wiped)) {
      const what = wiped ? `全灭:「${enemies}」` : `没有打赢「${enemies}」(战斗中止)`;
      this.add(record, "defeat", what, "—", {
        boss: Boolean(start.boss),
        enemies: start.enemies,
      });
      return;
    }
    if (outcome === "fled") {
      if (start.boss) {
        this.add(record, "bossfight", `从「${enemies}」逃跑`, "—", { enemies: start.enemies });
      }
      return;
    }
    if (start.boss !== null) {
      if (start.boss && (outcome === "win" || alive)) {
        const fallen = down.length > 0 ? `,${down.join("、")} 倒下` : "";
        this.add(record, "boss", `击败「${enemies}」${fallen}`, "—", { enemies: start.enemies });
      }
      return;
    }
    // Logs from before bridge 0.3.1 lack the flag. Bosses in FF5 drop no gil and regular
    // encounters always do, so a gil-less win is the best signal there.
    if (gained === 0 && alive && start.gil !== null) {
      const entryText = `击败「${enemies}」(推测为首领:战后没有金钱)`;
      this.add(record, "boss", entryText, "—", { enemies: start.enemies });
    }
  }

  onDialogPlay(record: Json): void {
    const lines = list(record.lines).filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const dialogText = lines.join("");
    const ids = list(record.ids);
    const scene = sceneOf(ids);
    if (scene && dialogText) {
      this.storyLine(record, scene, text(record.speaker) ?? "", dialogText);
    }
    const item = BRACKETED.exec(dialogText);
    if (
      ids.some((id) => typeof id === "string" && id.startsWith("T")) &&
      dialogText.includes("宝箱中发现了") &&
      item?.[1]
    ) {
      // Written once the chest counter in the next sample confirms it.
      this.pendingChest = [item[1], record];
    } else if (item?.[1] && GOT.test(dialogText)) {
      this.add(record, "item", `得到「${item[1]}」`, "—", { source: "事件" });
    }
  }

  /** One entry per scene: its lines are added as the pages come. */
  private storyLine(record: Json, scene: string, speaker: string, line: string): void {
    const stamp = text(record.t);
    if (stamp === undefined) throw new Error("探针记录缺少时间 t,没法写剧情记录");
    const now = localTime(stamp);
    let current = this.story;
    const same =
      current !== null &&
      current.data?.scene === scene &&
      this.storyAt !== null &&
      (now.getTime() - this.storyAt.getTime()) / 1000 <= SCENE_GAP_S;
    if (!same) {
      this.add(record, "story", "", "", { scene, lines: [] });
      current = this.entries[this.entries.length - 1] ?? null;
      this.story = current;
    }
    if (current === null) return;
    const data = current.data;
    if (!data) return;
    const lines: unknown[] = Array.isArray(data.lines) ? data.lines : [];
    if (!Array.isArray(data.lines)) data.lines = lines;
    lines.push(speaker ? `${speaker}:${line}` : line);
    const firstValue = lines[0];
    const lastValue = lines[lines.length - 1];
    const first = typeof firstValue === "string" ? firstValue : "";
    const last = typeof lastValue === "string" ? lastValue : "";
    current.text = lines.length === 1 ? first : `${first} …… ${last}`;
    current.progress = `${lines.length} 句`;
    this.storyAt = now;
  }

  onSaveWrite(record: Json): void {
    const result = record.result;
    const ok =
      result === undefined ||
      result === null ||
      result === "Success" ||
      result === "Succeeded" ||
      result === "Ok";
    const suffix = ok ? "" : `(结果 ${scalarText(result)})`;
    this.add(record, "save", `存档到 ${scalarText(record.slot)} 号位${suffix}`);
  }

  onBestiaryRegister(record: Json): void {
    const progress = truthy(this.pictureBook) ? `图鉴 ${String(this.pictureBook)}` : "—";
    this.add(record, "bestiary", `新增怪物 #${scalarText(record.monster)}`, progress, {
      monster: record.monster ?? null,
    });
  }

  onSteamSetProgress(record: Json): void {
    if (record.api === "picture_book") this.pictureBook = record.value ?? null;
  }
}
