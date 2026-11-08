/**
 * Per-session metrics for one play run (task 64): duration, token use, progress, battles,
 * repeated calls, player interventions, walking and the tactician, all normalized by the
 * session's wall-clock hours.
 *
 * The session log is the authority for what the model did; the `.deps/ds` JSONL files are
 * filtered by the session's first/last event time. Every source is optional: a missing or
 * unreadable file leaves that metric `null`, which the CLI prints as 无, instead of failing the
 * whole report.
 */

import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { zstdDecompressSync } from "node:zlib";
import { describeError } from "./errors.ts";
import { DEPS } from "./paths.ts";
import { isRecord, list, num, text, type Json } from "./values.ts";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_FILE = "session.v4.jsonl.zstd";
const MOVEMENT_TOOLS = new Set(["go", "walk_to", "go_to", "walk"]);
const MAX_INTERVENTION_CHARS = 40;
/** A gap longer than this between events is idle time, not play time (task 64 rework). */
export const IDLE_GAP = 5 * 60_000;

export interface MetricsPaths {
  /** `~/.dsh/sessions` unless a test passes a temporary root. */
  readonly sessionsRoot?: string;
  /** The checkout's `.deps` unless a test passes a temporary one. */
  readonly depsDir?: string;
  /** `ff5`; the only game the task measures for now. */
  readonly game?: string;
}

export interface SessionLogSources {
  readonly id: string;
  readonly log: string;
  readonly activityFile?: string;
  readonly battlesFiles?: readonly string[];
  readonly tacticianFile?: string;
  readonly timingFile?: string;
}

export interface Totals {
  readonly start: string | null;
  readonly end: string | null;
  /** Time between events, with gaps over IDLE_GAP left out. */
  readonly activeHours: number | null;
  readonly turns: number | null;
  readonly steps: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface Progress {
  readonly locations: number;
  readonly bosses: number;
  readonly chests: number;
  readonly maxLevel: number | null;
  readonly perHour: {
    readonly locations: number | null;
    readonly bosses: number | null;
    readonly chests: number | null;
  };
}

export interface BattleStats {
  readonly total: number;
  readonly wins: number;
  readonly winRate: number | null;
  readonly wipes: number;
  /** Wipes the story continues after; see `storyWipe`. */
  readonly storyWipes: number;
  readonly bossTotal: number;
  readonly bossLosses: number;
  readonly averageSeconds: number | null;
}

export interface GuideRepeat {
  readonly arguments: string;
  readonly count: number;
}

export interface FailureRepeat {
  readonly name: string;
  readonly arguments: string;
  /** Failed calls beyond the first in each same-arguments run of this call. */
  readonly retries: number;
  readonly longestStreak: number;
}

export interface Repetition {
  readonly guideCalls: number;
  readonly guideDistinct: number;
  readonly guideRepeats: readonly GuideRepeat[];
  /** Failed calls beyond the first of a same-tool, same-arguments run. */
  readonly failureRetries: number;
  readonly longestFailureStreak: number;
  readonly failureRepeats: readonly FailureRepeat[];
}

export interface Intervention {
  readonly at: string;
  /** At most 40 code points, as the report shows it. */
  readonly text: string;
  readonly kind: "继续" | "其他";
}

export interface ToolStat {
  readonly name: string;
  readonly calls: number;
  readonly failures: number;
}

export interface Walking {
  readonly tool: "go" | "walk_to" | "mixed" | "none";
  readonly calls: number;
  readonly mapCalls: number;
  readonly cellCalls: number;
  /** `walkpath` on new bridges, `walk` for the old closed loop; null when no timing file. */
  readonly walkOp: string | null;
  readonly walkCount: number | null;
  readonly walkSeconds: number | null;
  /** Cells from the `(x, y) → (x, y):N 格` lines in movement tool results. */
  readonly cells: number | null;
  readonly secondsPerCell: number | null;
  readonly blocked: number | null;
}

export interface TacticianStats {
  readonly total: number;
  readonly byKind: Readonly<Record<string, number>>;
}

export interface SessionMetrics {
  readonly id: string;
  readonly log: string | null;
  /** Why the session log could not be read; every metric is then null. */
  readonly error: string | null;
  readonly totals: Totals | null;
  readonly progress: Progress | null;
  readonly battles: BattleStats | null;
  readonly repetition: Repetition | null;
  readonly interventions: readonly Intervention[] | null;
  readonly walking: Walking | null;
  readonly tools: readonly ToolStat[] | null;
  readonly tactician: TacticianStats | null;
  readonly notes: readonly string[];
}

interface ParsedSession {
  readonly header: Json | null;
  readonly events: readonly Json[];
}

interface ToolCall {
  readonly name: string;
  readonly args: string;
  readonly callId: string;
}

interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

interface MovementCounts {
  readonly tool: Walking["tool"];
  readonly calls: number;
  readonly mapCalls: number;
  readonly cellCalls: number;
  readonly cells: number;
  readonly blocked: number;
}

interface SessionWindow {
  readonly start: number;
  readonly end: number;
  readonly activeHours: number | null;
}

interface TimingSummary {
  readonly op: string | null;
  readonly count: number;
  readonly seconds: number;
}

function isoOf(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function milliseconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Decode the zstd frames dsh appends to one session log; each append is its own frame. */
function decodeSessionBytes(bytes: Buffer): string {
  try {
    return zstdDecompressSync(bytes).toString("utf8");
  } catch {
    // A crash can leave the last frame cut in half. Fall back to frame starts so the complete
    // prefix is still readable; a magic number inside compressed data only costs that frame.
    const starts: number[] = [];
    for (let i = bytes.indexOf(ZSTD_MAGIC); i >= 0; i = bytes.indexOf(ZSTD_MAGIC, i + 1)) {
      starts.push(i);
    }
    if (starts.length === 0) throw new Error("文件里没有 zstd 帧");
    let body = "";
    for (let k = 0; k < starts.length; k += 1) {
      const start = starts[k] ?? 0;
      const end = starts[k + 1] ?? bytes.length;
      try {
        body += zstdDecompressSync(bytes.subarray(start, end)).toString("utf8");
      } catch {
        // A truncated last frame, or magic bytes that were part of compressed data.
      }
    }
    if (body === "") throw new Error("zstd 帧都解不开");
    return body;
  }
}

function parseSession(bytes: Buffer): ParsedSession {
  const lines = decodeSessionBytes(bytes)
    .split(/\r\n|\r|\n/u)
    .filter((line) => line.trim() !== "");
  let header: Json | null = null;
  const events: Json[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // One broken line costs one event, not the whole report.
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") continue;
    if (parsed.type === "session") {
      header ??= parsed;
      continue;
    }
    events.push(parsed);
  }
  return { header, events };
}

function eventData(event: Json): Json {
  return isRecord(event.data) ? event.data : {};
}

function eventTime(event: Json): number | null {
  return num(event.time) ?? null;
}

function blockText(value: unknown): string {
  if (typeof value === "string") return value;
  const parts: string[] = [];
  for (const block of list(value)) {
    if (!isRecord(block) || block.type !== "text") continue;
    const part = text(block.text);
    if (part !== undefined) parts.push(part);
  }
  return parts.join("");
}

function userText(event: Json): string {
  const data = eventData(event);
  return blockText(data.content);
}

function assistantUsage(event: Json): { input: number | null; output: number | null } | null {
  const usage = eventData(event).usage;
  if (!isRecord(usage)) return null;
  const input = num(usage.inputTokens) ?? null;
  const output = num(usage.outputTokens) ?? null;
  if (input === null && output === null) return null;
  return { input, output };
}

function directUser(event: Json): boolean {
  const source = eventData(event).source;
  return isRecord(source) && source.kind === "user";
}

function clipPoints(value: string, limit: number): string {
  const points = Array.from(value.trim());
  const clipped = points.slice(0, limit).join("");
  return points.length > limit ? `${clipped}…` : clipped;
}

function interventionKind(value: string): Intervention["kind"] {
  return /^继续[。.!！]?$/u.test(value.trim()) ? "继续" : "其他";
}

function toolCalls(events: readonly Json[]): {
  calls: readonly ToolCall[];
  results: ReadonlyMap<string, ToolResult>;
} {
  const calls: ToolCall[] = [];
  const results = new Map<string, ToolResult>();
  for (const event of events) {
    const data = eventData(event);
    if (event.type === "tool/call") {
      const name = text(data.name);
      const callId = text(data.callId);
      const args = text(data.arguments);
      if (name !== undefined && callId !== undefined) {
        calls.push({ name, args: args ?? "", callId });
      }
    } else if (event.type === "tool/result") {
      const message = isRecord(data.message) ? data.message : {};
      const callId = text(message.toolCallId);
      if (callId === undefined) continue;
      results.set(callId, {
        text: blockText(message.content),
        isError: message.isError === true,
      });
    }
  }
  return { calls, results };
}

function failedResult(result: ToolResult): boolean {
  if (result.isError) return true;
  const body = result.text.trim();
  return body.startsWith("工具出错") || /"?ok"?\s*:\s*false/u.test(body);
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!isRecord(value)) return value;
  const sorted: Json = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortedValue(value[key]);
  return sorted;
}

/** Compare arguments by value, not by key order or whitespace. */
function canonicalArguments(raw: string): string {
  try {
    return JSON.stringify(sortedValue(JSON.parse(raw)));
  } catch {
    return raw.trim();
  }
}

function parseArguments(raw: string): Json {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function coordinateTarget(value: unknown): boolean {
  if (Array.isArray(value))
    return value.length === 2 && value.every((item) => typeof item === "number");
  if (typeof value !== "string") return false;
  return /^\s*\[?\s*-?\d+\s*,\s*-?\d+\s*\]?\s*$/u.test(value);
}

function movementCounts(
  calls: readonly ToolCall[],
  results: ReadonlyMap<string, ToolResult>,
): MovementCounts {
  const movement = calls.filter((call) => MOVEMENT_TOOLS.has(call.name));
  const names = new Set(movement.map((call) => call.name));
  const tool: Walking["tool"] =
    names.size === 0 ? "none" : names.size > 1 ? "mixed" : names.has("go") ? "go" : "walk_to";
  let mapCalls = 0;
  let cellCalls = 0;
  let cells = 0;
  let blocked = 0;
  for (const call of movement) {
    const args = parseArguments(call.args);
    if (call.name === "go") {
      if (coordinateTarget(args.to)) cellCalls += 1;
      else mapCalls += 1;
    } else if (num(args.x) !== undefined && num(args.y) !== undefined) {
      cellCalls += 1;
    } else if (args.to !== undefined || args.map !== undefined) {
      mapCalls += 1;
    }
    const resultText = results.get(call.callId)?.text ?? "";
    for (const matched of resultText.matchAll(/:(\d+)\s*格/gu)) {
      cells += Number.parseInt(matched[1] ?? "0", 10);
    }
    let hits = resultText.match(/被挡住/gu)?.length ?? 0;
    if (resultText.includes("走不过去")) hits += 1;
    if (resultText.includes("没走通的出口")) hits += 1;
    blocked += hits;
  }
  return { tool, calls: movement.length, mapCalls, cellCalls, cells, blocked };
}

function summarizeEvents(parsed: ParsedSession): {
  totals: Totals;
  interventionList: Intervention[];
  repetition: Repetition;
  tools: ToolStat[];
  movement: MovementCounts;
} {
  const events = parsed.events;
  const times = events
    .map(eventTime)
    .filter((time): time is number => time !== null)
    .sort((left, right) => left - right);
  const startMs = times[0] ?? null;
  const endMs = times[times.length - 1] ?? null;
  let activeMs = 0;
  for (let index = 1; index < times.length; index += 1) {
    const gap = (times[index] ?? 0) - (times[index - 1] ?? 0);
    if (gap <= IDLE_GAP) activeMs += gap;
  }
  const activeHours = times.length > 0 ? activeMs / 3_600_000 : null;

  let turns = 0;
  let stepStarts = 0;
  let assistantMessages = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let inputSeen = false;
  let outputSeen = false;
  const interventionList: Intervention[] = [];
  for (const event of events) {
    if (event.type === "turn/start") turns += 1;
    else if (event.type === "step/start") stepStarts += 1;
    else if (event.type === "assistant/message") {
      assistantMessages += 1;
      const usage = assistantUsage(event);
      if (usage !== null) {
        if (usage.input !== null) {
          inputSeen = true;
          inputTokens += usage.input;
        }
        if (usage.output !== null) {
          outputSeen = true;
          outputTokens += usage.output;
        }
      }
    } else if (event.type === "user/message" && directUser(event)) {
      interventionList.push({
        at: isoOf(eventTime(event) ?? Number.NaN) ?? "",
        text: clipPoints(userText(event), MAX_INTERVENTION_CHARS),
        kind: interventionKind(userText(event)),
      });
    }
  }
  // A direct user message always opens the run; every later one is an intervention.
  if (interventionList.length > 0) interventionList.shift();

  const { calls, results } = toolCalls(events);
  const toolMap = new Map<string, { calls: number; failures: number }>();
  let guideCalls = 0;
  const guideCounts = new Map<string, { arguments: string; count: number }>();
  const failureCounts = new Map<
    string,
    { name: string; arguments: string; retries: number; longestStreak: number }
  >();
  let failureRetries = 0;
  let longestFailureStreak = 0;
  let streakKey = "";
  let streakLength = 0;
  for (const call of calls) {
    const stat = toolMap.get(call.name) ?? { calls: 0, failures: 0 };
    stat.calls += 1;
    const result = results.get(call.callId);
    const failed = result !== undefined && failedResult(result);
    if (failed) stat.failures += 1;
    toolMap.set(call.name, stat);

    if (call.name === "guide") {
      guideCalls += 1;
      const key = canonicalArguments(call.args);
      const entry = guideCounts.get(key) ?? { arguments: call.args, count: 0 };
      entry.count += 1;
      guideCounts.set(key, entry);
    }

    if (result === undefined) continue;
    if (failed) {
      const key = `${call.name}\u0000${canonicalArguments(call.args)}`;
      streakLength = key === streakKey ? streakLength + 1 : 1;
      streakKey = key;
      if (streakLength > 1) {
        failureRetries += 1;
        const group = failureCounts.get(key) ?? {
          name: call.name,
          arguments: call.args,
          retries: 0,
          longestStreak: 0,
        };
        group.retries += 1;
        group.longestStreak = Math.max(group.longestStreak, streakLength);
        failureCounts.set(key, group);
      }
      longestFailureStreak = Math.max(longestFailureStreak, streakLength);
    } else {
      streakKey = "";
      streakLength = 0;
    }
  }
  const tools = [...toolMap.entries()]
    .map(([name, stat]) => ({ name, calls: stat.calls, failures: stat.failures }))
    .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
  const guideRepeats = [...guideCounts.values()]
    .filter((entry) => entry.count > 1)
    .sort(
      (left, right) => right.count - left.count || left.arguments.localeCompare(right.arguments),
    );
  const failureRepeats = [...failureCounts.values()].sort(
    (left, right) =>
      right.retries - left.retries ||
      right.longestStreak - left.longestStreak ||
      left.name.localeCompare(right.name),
  );

  return {
    totals: {
      start: startMs === null ? null : isoOf(startMs),
      end: endMs === null ? null : isoOf(endMs),
      activeHours,
      turns,
      steps: stepStarts > 0 ? stepStarts : assistantMessages,
      inputTokens: inputSeen ? inputTokens : null,
      outputTokens: outputSeen ? outputTokens : null,
    },
    interventionList,
    repetition: {
      guideCalls,
      guideDistinct: guideCounts.size,
      guideRepeats,
      failureRetries,
      longestFailureStreak,
      failureRepeats,
    },
    tools,
    movement: movementCounts(calls, results),
  };
}

function inWindow(at: string, startMs: number, endMs: number): boolean {
  const parsed = milliseconds(at);
  return parsed !== null && parsed >= startMs && parsed <= endMs;
}

async function readJsonLines(file: string): Promise<Json[]> {
  const body = await readFile(file, "utf8");
  const rows: Json[] = [];
  for (const line of body.split(/\r\n|\r|\n/u)) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) rows.push(parsed);
    } catch {
      // A crash can leave one broken last line; the rest of the file is still usable.
    }
  }
  return rows;
}

function perHour(value: number, hours: number | null): number | null {
  return hours !== null && hours > 0 ? value / hours : null;
}

function activityProgress(
  rows: readonly Json[],
  startMs: number,
  endMs: number,
  activeHours: number | null,
): Progress {
  let locations = 0;
  let bosses = 0;
  let chests = 0;
  let maxLevel: number | null = null;
  for (const row of rows) {
    const at = text(row.at);
    const body = text(row.text);
    if (
      at === undefined ||
      body === undefined ||
      text(row.kind) !== "event" ||
      !inWindow(at, startMs, endMs)
    ) {
      continue;
    }
    if (body.startsWith("地点 首次到达")) locations += 1;
    else if (body.startsWith("首领 击败")) bosses += 1;
    else if (body.startsWith("宝箱 ")) chests += 1;
    for (const matched of body.matchAll(/升级\s+\S+\s+(\d+)\s*→\s*(\d+)/gu)) {
      const level = Number.parseInt(matched[2] ?? "0", 10);
      if (Number.isFinite(level)) maxLevel = maxLevel === null ? level : Math.max(maxLevel, level);
    }
  }
  return {
    locations,
    bosses,
    chests,
    maxLevel,
    perHour: {
      locations: perHour(locations, activeHours),
      bosses: perHour(bosses, activeHours),
      chests: perHour(chests, activeHours),
    },
  };
}

/**
 * The west-valley goblin story battle is logged as a regular wipe and the story continues;
 * a real boss wipe on the same map stays a loss. This is the narrowest distinction the battle
 * record offers (map 577 + regular), so the report counts it in the wipe column and lists it
 * separately instead of hiding it.
 */
function storyWipe(row: Json): boolean {
  if (text(row.result) !== "wipe") return false;
  if (text(row.detail)?.includes("剧情") === true) return true;
  return num(row.mapId) === 577 && text(row.kind) !== "boss";
}

function battleSeconds(row: Json): number | null {
  const seconds = num(row.seconds);
  if (seconds !== undefined) return seconds;
  const start = milliseconds(row.startedAt);
  const end = milliseconds(row.endedAt);
  if (start === null || end === null || end < start) return null;
  return (end - start) / 1000;
}

function battleStats(rows: readonly Json[], startMs: number, endMs: number): BattleStats {
  let total = 0;
  let wins = 0;
  let wipes = 0;
  let storyWipes = 0;
  let bossTotal = 0;
  let bossLosses = 0;
  let seconds = 0;
  let timed = 0;
  for (const row of rows) {
    const started = milliseconds(row.startedAt);
    const ended = milliseconds(row.endedAt) ?? started;
    if (started === null || ended === null) continue;
    if (started > endMs || ended < startMs) continue;
    total += 1;
    const result = text(row.result) ?? "";
    if (result === "ok" || result === "hard") wins += 1;
    if (result === "wipe") {
      wipes += 1;
      if (storyWipe(row)) storyWipes += 1;
    }
    if (text(row.kind) === "boss") {
      bossTotal += 1;
      if (result !== "ok" && result !== "hard") bossLosses += 1;
    }
    const length = battleSeconds(row);
    if (length !== null) {
      seconds += length;
      timed += 1;
    }
  }
  return {
    total,
    wins,
    winRate: total > 0 ? wins / total : null,
    wipes,
    storyWipes,
    bossTotal,
    bossLosses,
    averageSeconds: timed > 0 ? seconds / timed : null,
  };
}

interface BattleRowWithFile {
  readonly row: Json;
  readonly file: string;
}

function battleKey(row: Json): string {
  // Battle ids restart at 1 in every rotated file, so the id alone would merge yesterday's
  // battle with today's. The start time distinguishes them while still deduplicating a record
  // that survived a rotation in two files.
  const id = num(row.id);
  if (id !== undefined) return `id:${id}|${String(row.startedAt)}`;
  return [row.startedAt, row.mapId, row.kind, row.result].map((value) => String(value)).join("|");
}

function dedupeBattles(rows: readonly BattleRowWithFile[]): Json[] {
  const seen = new Map<string, Json>();
  for (const { row } of rows) {
    const key = battleKey(row);
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

function tacticianStats(rows: readonly Json[], startMs: number, endMs: number): TacticianStats {
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const at = text(row.at);
    const kind = text(row.kind);
    if (at === undefined || kind === undefined || !inWindow(at, startMs, endMs)) continue;
    total += 1;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(byKind).sort()) sorted[key] = byKind[key] ?? 0;
  return { total, byKind: sorted };
}

/** Stream the 35 MB timing log and sum the walking op inside the session window. */
async function readTiming(file: string, startMs: number, endMs: number): Promise<TimingSummary> {
  const sums = new Map<string, { count: number; ms: number }>();
  const stream = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of stream) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const op = text(parsed.op);
    const at = milliseconds(parsed.t);
    const ms = num(parsed.ms);
    if (op === undefined || at === null || ms === undefined || ms < 0) continue;
    if (at < startMs || at > endMs) continue;
    if (op !== "walkpath" && op !== "walk") continue;
    const sum = sums.get(op) ?? { count: 0, ms: 0 };
    sum.count += 1;
    sum.ms += ms;
    sums.set(op, sum);
  }
  const walkpath = sums.get("walkpath");
  const walk = sums.get("walk");
  let chosen: { op: string; count: number; ms: number } | null = null;
  if (walkpath !== undefined && walkpath.count > 0) chosen = { op: "walkpath", ...walkpath };
  else if (walk !== undefined && walk.count > 0) chosen = { op: "walk", ...walk };
  if (chosen === null) return { op: null, count: 0, seconds: 0 };
  return { op: chosen.op, count: chosen.count, seconds: chosen.ms / 1000 };
}

async function timingOrNull(
  file: string | undefined,
  window: SessionWindow | null,
  notes: string[],
): Promise<TimingSummary | null> {
  if (file === undefined || window === null) return null;
  try {
    return await readTiming(file, window.start, window.end);
  } catch (error) {
    notes.push(`读不了走路计时 ${file}:${describeError(error)}`);
    return null;
  }
}

async function activityOrNull(
  file: string | undefined,
  window: SessionWindow | null,
  notes: string[],
): Promise<Progress | null> {
  if (file === undefined || window === null) return null;
  try {
    return activityProgress(
      await readJsonLines(file),
      window.start,
      window.end,
      window.activeHours,
    );
  } catch (error) {
    notes.push(`读不了活动日志 ${file}:${describeError(error)}`);
    return null;
  }
}

async function battlesOrNull(
  files: readonly string[] | undefined,
  window: SessionWindow | null,
  notes: string[],
): Promise<BattleStats | null> {
  if (files === undefined || files.length === 0 || window === null) return null;
  const rows: BattleRowWithFile[] = [];
  for (const file of files) {
    try {
      for (const row of await readJsonLines(file)) rows.push({ row, file });
    } catch (error) {
      notes.push(`读不了战斗记录 ${file}:${describeError(error)}`);
    }
  }
  if (rows.length === 0) return null;
  return battleStats(dedupeBattles(rows), window.start, window.end);
}

async function tacticianOrNull(
  file: string | undefined,
  window: SessionWindow | null,
  notes: string[],
): Promise<TacticianStats | null> {
  if (file === undefined || window === null) return null;
  try {
    return tacticianStats(await readJsonLines(file), window.start, window.end);
  } catch (error) {
    notes.push(`读不了战术官记录 ${file}:${describeError(error)}`);
    return null;
  }
}

/** Battle logs rotate per play run; collect the current file and every backup beside it. */
export async function battleFilesFor(depsDir: string, game: string): Promise<string[]> {
  const dir = join(depsDir, "ds");
  try {
    const names = await readdir(dir);
    const current = `battles-${game}.jsonl`;
    return names
      .filter((name) => name === current || name.startsWith(`${current}.bak-`))
      .sort((left, right) =>
        left === current ? -1 : right === current ? 1 : left.localeCompare(right),
      )
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function emptyMetrics(
  id: string,
  log: string | null,
  error: string,
  notes: string[],
): SessionMetrics {
  return {
    id,
    log,
    error,
    totals: null,
    progress: null,
    battles: null,
    repetition: null,
    interventions: null,
    walking: null,
    tools: null,
    tactician: null,
    notes,
  };
}

/** Collect one session from explicit file paths; tests use this and the CLI fills the paths. */
export async function metricsForLog(sources: SessionLogSources): Promise<SessionMetrics> {
  const notes: string[] = [];
  let parsed: ParsedSession;
  try {
    parsed = parseSession(await readFile(sources.log));
  } catch (error) {
    return emptyMetrics(
      sources.id,
      sources.log,
      `读不了会话日志 ${sources.log}:${describeError(error)}`,
      notes,
    );
  }

  const summary = summarizeEvents(parsed);
  const { totals } = summary;
  const startMs = milliseconds(totals.start);
  const endMs = milliseconds(totals.end);
  const window =
    startMs !== null && endMs !== null
      ? { start: startMs, end: endMs, activeHours: totals.activeHours }
      : null;

  const progress = await activityOrNull(sources.activityFile, window, notes);
  const battles = await battlesOrNull(sources.battlesFiles, window, notes);
  const tactician = await tacticianOrNull(sources.tacticianFile, window, notes);
  const timing = await timingOrNull(sources.timingFile, window, notes);

  const base = summary.movement;
  const walking: Walking = {
    ...base,
    walkOp: timing === null ? null : timing.op,
    walkCount: timing === null ? null : timing.count,
    walkSeconds: timing === null ? null : timing.seconds,
    secondsPerCell:
      timing === null || base.cells <= 0
        ? null
        : Math.round((timing.seconds / base.cells) * 1000) / 1000,
  };
  if (timing === null && sources.timingFile !== undefined)
    notes.push("走路秒数:无(计时文件读不到)");
  if (battles !== null && battles.storyWipes > 0) {
    notes.push("剧情战失败:按地图 577(西侧山谷)的 regular 战斗判断,仍计入 wipe");
  }
  if (base.calls > 0) {
    notes.push("走路格数:只统计工具结果里写明的 (x, y) → (x, y):N 格");
  }

  return {
    id: sources.id,
    log: sources.log,
    error: null,
    totals,
    progress,
    battles,
    repetition: summary.repetition,
    interventions: summary.interventionList,
    walking,
    tools: summary.tools,
    tactician,
    notes,
  };
}

export interface ResolvedSession {
  readonly id: string;
  readonly log: string;
}

/** Find a full session id or its first 8 characters under `~/.dsh/sessions/<project>/`. */
export async function resolveSession(root: string, prefix: string): Promise<ResolvedSession> {
  // dsh ids start with `session-`, while the report is written with the 8 meaningful
  // characters. Accept both the raw id prefix and the same prefix after `session-`.
  const prefixes = prefix.startsWith("session-") ? [prefix] : [prefix, `session-${prefix}`];
  const groups = await readdir(root, { withFileTypes: true });
  const found: ResolvedSession[] = [];
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    let sessions;
    try {
      sessions = await readdir(join(root, group.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      if (!prefixes.some((wanted) => session.name.startsWith(wanted))) continue;
      const names = await readdir(join(root, group.name, session.name)).catch((): string[] => []);
      if (!names.includes(SESSION_FILE)) continue;
      found.push({ id: session.name, log: join(root, group.name, session.name, SESSION_FILE) });
    }
  }
  const exact = found.filter((entry) => prefixes.includes(entry.id));
  const candidates = exact.length > 0 ? exact : found;
  const chosen = candidates[0];
  if (chosen === undefined) throw new Error(`找不到会话 ${prefix}`);
  if (candidates.length > 1) {
    throw new Error(`会话号前缀 ${prefix} 对上了 ${candidates.length} 个会话`);
  }
  return chosen;
}

/** Resolve a session id/prefix and collect it with the FF5 data files under `.deps`. */
export async function collectSessionMetrics(
  prefix: string,
  paths: MetricsPaths = {},
): Promise<SessionMetrics> {
  const root = paths.sessionsRoot ?? join(homedir(), ".dsh", "sessions");
  const deps = paths.depsDir ?? DEPS;
  const game = paths.game ?? "ff5";
  let resolved: ResolvedSession;
  try {
    resolved = await resolveSession(root, prefix);
  } catch (error) {
    return emptyMetrics(prefix, null, describeError(error), []);
  }
  const ds = join(deps, "ds");
  return metricsForLog({
    id: resolved.id,
    log: resolved.log,
    activityFile: join(ds, `activity-${game}.jsonl`),
    battlesFiles: await battleFilesFor(deps, game),
    tacticianFile: join(ds, `tactician-${game}.jsonl`),
    timingFile: join(deps, "pilot", "timing.jsonl"),
  });
}
