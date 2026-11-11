/**
 * The second layer's page (task 40): the tactician's walker notes, every rule table translated
 * to strategy 2.0 Chinese one rule per line, how often each rule fired or was skipped in the
 * recent battles, each table's record, the boss table and mid-battle rewrites, and the recent
 * calls. Pure formatting: the route supplies Tactics and the battle records.
 */

import type { BattleRecord } from "./battle-record.ts";
import { byKey, gameHeading } from "./games.ts";
import { fromLegacy, describe, parseStrategy } from "./strategy/index.ts";
import type { Tactics, TacticsEntry } from "./tactics.ts";
import type { TacticianCall } from "./tactician-log.ts";
import { firstSentence } from "./tactician-log.ts";
import { isRecord } from "./values.ts";

export interface TacticianRuleLine {
  readonly text: string;
  readonly hits: number;
  /** "跳过 2 次：没有这个指令(现在是武僧)"; "" when the rule was never skipped. */
  readonly skipText: string;
  readonly skipped: boolean;
}

export interface TacticianMemberView {
  readonly name: string;
  readonly rules: readonly TacticianRuleLine[];
}

export interface TacticianTableView {
  readonly title: string;
  readonly inUse: boolean;
  readonly members: readonly TacticianMemberView[];
  /** "用过 3 次 · 赢 2 / 吃力 1 / 全灭 0" */
  readonly recordText: string;
  readonly error: string | null;
}

export interface TacticianMapView {
  readonly mapId: number;
  readonly name: string;
  readonly walkerNotes: string;
  readonly askUp: string;
  readonly writtenAt: string;
  readonly tables: readonly TacticianTableView[];
  readonly tableEmpty: string;
  readonly boss: TacticianBossView | null;
  readonly bossEmpty: string;
}

export interface TacticianBossView {
  readonly title: string;
  readonly table: TacticianTableView;
  readonly result: string;
  readonly atText: string;
  readonly rewrites: readonly string[];
}

export interface TacticianCallView {
  readonly line: string;
  readonly atText: string;
}

export interface TacticianPanelView {
  readonly title: string;
  readonly status: string;
  readonly message: string | null;
  readonly map: TacticianMapView | null;
  readonly calls: readonly TacticianCallView[];
  readonly callsEmpty: string;
  readonly others: readonly TacticianMapView[];
}

export interface TacticianViewInput {
  readonly game: string;
  readonly tactics: Tactics;
  readonly records: readonly BattleRecord[];
  readonly calls: readonly TacticianCall[];
  readonly mapId: number | null;
  readonly mapNameOf: (mapId: number) => string;
  readonly status?: string;
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function recordText(entry: TacticsEntry, table: number): string {
  const rows = entry.results.filter((result) => Number(result.table) === table);
  const count = (verdict: string): number =>
    rows.filter((result) => String(result.verdict) === verdict).length;
  const wins = count("ok");
  const hard = count("hard");
  const wipes = count("lost");
  return `用过 ${rows.length} 次 · 赢 ${wins} / 吃力 ${hard} / 全灭 ${wipes}`;
}

function skipTextFor(skips: readonly { readonly why: string; readonly count: number }[]): {
  text: string;
  skipped: boolean;
} {
  if (skips.length === 0) return { text: "", skipped: false };
  const total = skips.reduce((sum, item) => sum + item.count, 0);
  const why = [...skips]
    .sort((left, right) => right.count - left.count)
    .map((item) => (item.count > 1 ? `${item.why}×${item.count}` : item.why))
    .join("；");
  return { text: `跳过 ${total} 次：${why}`, skipped: true };
}

function ruleStatsOf(
  records: readonly BattleRecord[],
  mapId: number,
  table: number,
): Map<string, { hits: number; skips: { why: string; count: number }[] }> {
  const out = new Map<string, { hits: number; skips: { why: string; count: number }[] }>();
  const entry = (key: string): { hits: number; skips: { why: string; count: number }[] } => {
    const found = out.get(key);
    if (found !== undefined) return found;
    const created = { hits: 0, skips: [] as { why: string; count: number }[] };
    out.set(key, created);
    return created;
  };
  for (const record of records) {
    if (record.table.kind !== "map") continue;
    if (record.table.mapId !== mapId || record.table.table !== table) continue;
    for (const turn of record.turns) {
      if (turn.rule > 0) entry(`${turn.actor}\u0000${turn.rule}`).hits += 1;
      for (const skip of turn.skipped) {
        const skips = entry(`${turn.actor}\u0000${skip.rule}`).skips;
        const found = skips.find((item) => item.why === skip.why);
        if (found === undefined) skips.push({ why: skip.why, count: 1 });
        else found.count += 1;
      }
    }
  }
  return out;
}

/** One legacy table translated through strategy 2.0; a malformed table says why. */
function tableView(
  table: unknown,
  title: string,
  inUse: boolean,
  record: string,
): TacticianTableView {
  try {
    const strategy = strategyOf(table);
    const members = new Map<string, TacticianRuleLine[]>();
    for (const rule of strategy.rules) {
      const lines = members.get(rule.who) ?? [];
      lines.push({
        text: describe(rule),
        hits: 0,
        skipText: "",
        skipped: false,
      });
      members.set(rule.who, lines);
    }
    return {
      title,
      inUse,
      members: [...members].map(([name, rules]) => ({ name, rules })),
      recordText: record,
      error: null,
    };
  } catch (error) {
    return {
      title,
      inUse,
      members: [],
      recordText: record,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Attach hit/skip counts to the freshly translated lines, keyed by actor and 1-based rule. */
function withStats(
  view: TacticianTableView,
  stats: Map<string, { hits: number; skips: { why: string; count: number }[] }>,
): TacticianTableView {
  return {
    ...view,
    members: view.members.map((member) => ({
      ...member,
      rules: member.rules.map((rule, ruleIndex) => {
        // A table's members come from fromLegacy's actor order; rule numbers restart per actor.
        const key = `${member.name}\u0000${ruleIndex + 1}`;
        const found = stats.get(key);
        const skipped = skipTextFor(found?.skips ?? []);
        return {
          ...rule,
          hits: found?.hits ?? 0,
          skipText: skipped.text,
          skipped: skipped.skipped,
        };
      }),
    })),
  };
}

function mapView(input: TacticianViewInput, mapId: number): TacticianMapView {
  const entry = input.tactics.maps.get(String(mapId));
  const note = input.tactics.note(mapId);
  const currentIndex =
    entry === undefined || entry.tables.length === 0
      ? 0
      : ((entry.current % entry.tables.length) + entry.tables.length) % entry.tables.length;
  const tables = (entry?.tables ?? []).map((table, index) => {
    const view = tableView(
      table,
      `策略 ${index + 1}${index === currentIndex ? "(正在用)" : ""}`,
      index === currentIndex,
      entry === undefined ? "" : recordText(entry, index),
    );
    return withStats(view, ruleStatsOf(input.records, mapId, index));
  });
  const boss = entry?.boss;
  return {
    mapId,
    name: input.mapNameOf(mapId),
    walkerNotes: note?.walkerNotes ?? "",
    askUp: note?.askUp ?? "",
    writtenAt: note?.writtenAt ?? "",
    tables,
    tableEmpty: "这张地图还没有规则表",
    boss:
      boss === undefined
        ? null
        : {
            title: `首领表(${input.mapNameOf(mapId)})`,
            table: tableView(boss.table, "首领战规则", true, ""),
            result: boss.result,
            atText: clock(boss.at),
            rewrites: (boss.rewrites ?? []).map(
              (rewrite) =>
                `${rewrite.reason} → ${rewrite.ok ? "换了新表" : "没有新表"}：${rewrite.summary}`,
            ),
          },
    bossEmpty: "这张地图还没有首领表",
  };
}

function callView(call: TacticianCall): TacticianCallView {
  const problems = call.problems.length === 0 ? "" : ` · 问题：${call.problems.join("；")}`;
  const notes = call.walkerFirst === "" ? "" : ` · ${call.walkerFirst}`;
  return {
    atText: clock(call.at),
    line:
      `${clock(call.at)} 地图 ${call.mapId} · ${call.kind}：${call.detail} · ` +
      `交回 ${call.tables} 套${problems}${notes}`,
  };
}

export function tacticianView(input: TacticianViewInput): TacticianPanelView {
  const current = input.mapId === null ? null : mapView(input, input.mapId);
  const ids = [...input.tactics.maps.keys()]
    .map((key) => Number(key))
    .filter((mapId) => Number.isFinite(mapId))
    .sort((left, right) => left - right);
  const others = ids.filter((mapId) => mapId !== input.mapId).map((mapId) => mapView(input, mapId));
  return {
    title: `${gameHeading(input.game)} 战术官`,
    status:
      input.status ??
      (input.mapId === null ? "读不到当前地图" : `当前地图：${input.mapNameOf(input.mapId)}`),
    message: byKey(input.game).key === "ff5" ? null : "这一作还没有 AI 玩家，没有战斗策略",
    map: current,
    calls: input.calls.slice(-15).reverse().map(callView),
    callsEmpty: "还没叫过战术官",
    others,
  };
}

/** A table stored in a battle record, translated for the ③ 战斗 tab's rule-hit summary. */
export function translatedRules(table: unknown): string[] {
  try {
    return strategyOf(table).rules.map((rule) => describe(rule));
  } catch {
    return [];
  }
}

/** A stored table in either language: 2.0 parsed as written, old tables converted. */
function strategyOf(table: unknown): ReturnType<typeof fromLegacy> {
  if (!isRecord(table) || table.version !== 2) return fromLegacy(table);
  const parsed = parseStrategy(table);
  if (Array.isArray(parsed)) throw new Error(parsed.join(";"));
  return parsed;
}

/** "法利斯 黑魔法:火炎 → 跳过 2 次：没有这个指令(现在是武僧)" */
export function skippedLine(actor: string, rule: string, why: string, count: number): string {
  return `${actor} ${rule} → 跳过 ${count} 次：${why}`;
}

/** The first sentence helper is shared with Game's call log. */
export { firstSentence };
