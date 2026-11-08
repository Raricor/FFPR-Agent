/**
 * Compare one or more play sessions by their metrics (task 64).
 *
 *   node scripts/metrics.ts --session <会话号> [--session <另一个>] [--json]
 *
 * A session id may be a prefix (8 characters is enough). Missing files print 无 instead of
 * failing the whole comparison; the reason is printed below the table.
 */

import { pathToFileURL } from "node:url";
import { collectSessionMetrics, type SessionMetrics } from "../src/engine/metrics.ts";

const USAGE =
  "用法: node scripts/metrics.ts --session <会话号> [--session <另一个>] [--json]\n" +
  "会话号可以只给前 8 位。";

function parseArguments(argv: readonly string[]): { sessions: string[]; json: boolean } {
  const sessions: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--session") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--session 后面缺会话号");
      sessions.push(value);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`不认识的参数:${arg ?? ""}`);
    }
  }
  if (sessions.length === 0) throw new Error("至少给一个 --session");
  return { sessions, json };
}

const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const twoDecimals = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const threeDecimals = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

function shortId(id: string): string {
  return id.replace(/^session-/u, "").slice(0, 8);
}

function clock(iso: string | null): string {
  if (iso === null) return "无";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "无";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function range(metrics: SessionMetrics): string {
  if (metrics.totals === null) return "无";
  return `${clock(metrics.totals.start)} → ${clock(metrics.totals.end)}`;
}

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "无" : integer.format(value);
}

function rate(value: number | null | undefined): string {
  return value === null || value === undefined ? "无" : oneDecimal.format(value);
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "无" : `${oneDecimal.format(value * 100)}%`;
}

function seconds(
  value: number | null | undefined,
  digits: "one" | "two" | "three" = "one",
): string {
  if (value === null || value === undefined) return "无";
  if (digits === "three") return threeDecimals.format(value);
  if (digits === "two") return twoDecimals.format(value);
  return oneDecimal.format(value);
}

function per(value: number, hours: number | null): number | null {
  return hours !== null && hours > 0 ? value / hours : null;
}

function perHourText(value: number | null | undefined, hours: number | null): string {
  if (value === null || value === undefined) return "无";
  return rate(per(value, hours));
}

function guideSummary(metrics: SessionMetrics): string {
  const repetition = metrics.repetition;
  if (repetition === null) return "无";
  return `${count(repetition.guideCalls)} 次 / 去重 ${count(repetition.guideDistinct)}`;
}

function guideRepeatSummary(metrics: SessionMetrics): string {
  const repetition = metrics.repetition;
  if (repetition === null) return "无";
  if (repetition.guideRepeats.length === 0) return "0 组";
  const most = repetition.guideRepeats[0]?.count ?? 0;
  return `${repetition.guideRepeats.length} 组(最多 ${count(most)} 次)`;
}

function failureSummary(metrics: SessionMetrics): string {
  const repetition = metrics.repetition;
  if (repetition === null) return "无";
  return (
    `${count(repetition.failureRetries)} 次(最长 ${count(repetition.longestFailureStreak)}、` +
    `${count(repetition.failureRepeats.length)} 组)`
  );
}

function clip(value: string, limit = 100): string {
  const points = Array.from(value.replace(/\s+/gu, " ").trim());
  return points.length <= limit ? points.join("") : `${points.slice(0, limit - 1).join("")}…`;
}

function interventionSummary(metrics: SessionMetrics): string {
  const list = metrics.interventions;
  if (list === null) return "无";
  const continues = list.filter((entry) => entry.kind === "继续").length;
  return `${count(list.length)} 条(继续 ${count(continues)} / 其他 ${count(list.length - continues)})`;
}

function movementLabel(metrics: SessionMetrics): string {
  const walking = metrics.walking;
  if (walking === null) return "无";
  const labels: Record<string, string> = {
    go: "go",
    walk_to: "walk_to",
    mixed: "go+旧工具",
    none: "无",
  };
  return labels[walking.tool] ?? walking.tool;
}

function movementCalls(metrics: SessionMetrics): string {
  const walking = metrics.walking;
  if (walking === null) return "无";
  return `${count(walking.calls)} 次(${movementLabel(metrics)})`;
}

function movementSplit(metrics: SessionMetrics): string {
  const walking = metrics.walking;
  if (walking === null) return "无";
  return `地图 ${count(walking.mapCalls)} / 坐标 ${count(walking.cellCalls)}`;
}

function walkTiming(metrics: SessionMetrics): string {
  const walking = metrics.walking;
  if (walking === null) return "无";
  if (walking.walkCount === null || walking.walkOp === null) return "无";
  return `${walking.walkOp} ${count(walking.walkCount)} 次 / ${seconds(walking.walkSeconds)} 秒`;
}

function tacticianSummary(metrics: SessionMetrics): string {
  const tactician = metrics.tactician;
  if (tactician === null) return "无";
  const kinds = Object.entries(tactician.byKind).map(([kind, amount]) => `${kind} ${amount}`);
  return `${count(tactician.total)} 次${kinds.length === 0 ? "" : `(${kinds.join("、")})`}`;
}

function baseRows(metrics: SessionMetrics): [string, string][] {
  const totals = metrics.totals;
  const progress = metrics.progress;
  const battles = metrics.battles;
  const walking = metrics.walking;
  const hours = totals?.activeHours ?? null;
  return [
    ["读取", metrics.error === null ? "好" : "无"],
    ["时间范围", range(metrics)],
    ["活跃时长(小时)", seconds(hours, "two")],
    ["轮次", count(totals?.turns)],
    ["模型步数", count(totals?.steps)],
    ["模型步数/时", perHourText(totals?.steps, hours)],
    ["输入 token", count(totals?.inputTokens)],
    ["输入 token/时", perHourText(totals?.inputTokens, hours)],
    ["输出 token", count(totals?.outputTokens)],
    ["输出 token/时", perHourText(totals?.outputTokens, hours)],
    ["地点首次到达", count(progress?.locations)],
    ["地点/时", rate(progress?.perHour.locations)],
    ["首领击败", count(progress?.bosses)],
    ["首领击败/时", rate(progress?.perHour.bosses)],
    ["宝箱", count(progress?.chests)],
    ["宝箱/时", rate(progress?.perHour.chests)],
    ["队伍最高等级", count(progress?.maxLevel)],
    ["战斗场数", count(battles?.total)],
    ["战斗胜率", percent(battles?.winRate)],
    [
      "wipe",
      battles === null ? "无" : `${count(battles.wipes)}(剧情战失败 ${count(battles.storyWipes)})`,
    ],
    ["首领战场数", count(battles?.bossTotal)],
    ["首领战失败", count(battles?.bossLosses)],
    ["战斗平均秒", seconds(battles?.averageSeconds)],
    ["guide 查询/去重", guideSummary(metrics)],
    ["guide 重复", guideRepeatSummary(metrics)],
    ["同参连续失败", failureSummary(metrics)],
    ["插手", interventionSummary(metrics)],
    ["移动调用", movementCalls(metrics)],
    ["地图/坐标", movementSplit(metrics)],
    ["walk 计时", walkTiming(metrics)],
    ["walk 格数", count(walking?.cells)],
    ["每格秒", seconds(walking?.secondsPerCell, "three")],
    ["被挡住", count(walking?.blocked)],
    ["战术官", tacticianSummary(metrics)],
  ];
}

/** The union of tool names, ordered by total calls across the compared sessions. */
function toolNames(results: readonly SessionMetrics[]): string[] {
  const totals = new Map<string, number>();
  for (const metrics of results) {
    for (const tool of metrics.tools ?? []) {
      totals.set(tool.name, (totals.get(tool.name) ?? 0) + tool.calls);
    }
  }
  return [...totals.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name]) => name);
}

/**
 * Rows for every session in the same order. Tool rows come from the union of names, so a
 * session that never called a tool shows 无 on that row instead of shifting another tool up.
 */
export function comparisonRows(results: readonly SessionMetrics[]): [string, string][][] {
  const names = toolNames(results);
  return results.map((metrics) => {
    const rows = baseRows(metrics);
    for (const name of names) {
      const tool = metrics.tools?.find((entry) => entry.name === name);
      rows.push([
        `工具 ${name}`,
        tool === undefined ? "无" : `${count(tool.calls)} 次 / 失败 ${count(tool.failures)}`,
      ]);
    }
    return rows;
  });
}

function characterWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff);
  return wide ? 2 : 1;
}

function width(value: string): number {
  let total = 0;
  for (const character of value) total += characterWidth(character);
  return total;
}

function pad(value: string, target: number): string {
  return value + " ".repeat(Math.max(0, target - width(value)));
}

function printTable(results: readonly SessionMetrics[]): void {
  const headers = ["指标", ...results.map((metrics) => shortId(metrics.id))];
  const body = comparisonRows(results);
  const columnCount = headers.length;
  const widths: number[] = headers.map((header) => width(header));
  for (const table of body) {
    for (const row of table) {
      row.forEach((cell, index) => {
        widths[index] = Math.max(widths[index] ?? 0, width(cell));
      });
    }
  }
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => pad(cell, (widths[index] ?? 0) + 2))
      .join("")
      .trimEnd();
  console.log(line(headers));
  console.log(
    widths
      .map((value) => "-".repeat(value + 2))
      .join("")
      .trimEnd(),
  );
  for (let index = 0; index < (body[0]?.length ?? 0); index += 1) {
    const cells = [body[0]?.[index]?.[0] ?? ""];
    for (const table of body) cells.push(table[index]?.[1] ?? "无");
    if (cells.length !== columnCount) continue;
    console.log(line(cells));
  }
}

function printInterventions(results: readonly SessionMetrics[]): void {
  const any = results.some((metrics) => (metrics.interventions?.length ?? 0) > 0);
  if (!any) return;
  console.log("");
  console.log("插手记录(第一条是开局目标,不计):");
  for (const metrics of results) {
    const list = metrics.interventions;
    if (list === null) continue;
    console.log(`[${shortId(metrics.id)}] ${list.length} 条`);
    for (const entry of list) {
      const kind = entry.kind === "继续" ? "继续" : "其他";
      console.log(`  ${clock(entry.at)}  ${kind}  ${entry.text}`);
    }
  }
}

function printRepeats(results: readonly SessionMetrics[]): void {
  const any = results.some(
    (metrics) =>
      metrics.repetition !== null &&
      (metrics.repetition.guideRepeats.length > 0 || metrics.repetition.failureRepeats.length > 0),
  );
  if (!any) return;
  console.log("");
  console.log("重复调用:");
  for (const metrics of results) {
    const repetition = metrics.repetition;
    if (repetition === null) continue;
    if (repetition.guideRepeats.length === 0 && repetition.failureRepeats.length === 0) continue;
    console.log(`[${shortId(metrics.id)}]`);
    for (const entry of repetition.guideRepeats) {
      console.log(`  guide ${count(entry.count)} 次  ${clip(entry.arguments)}`);
    }
    for (const entry of repetition.failureRepeats) {
      console.log(
        `  ${entry.name} 同参失败 ${count(entry.retries)} 次(最长 ${count(entry.longestStreak)})  ` +
          clip(entry.arguments),
      );
    }
  }
}

function printNotes(results: readonly SessionMetrics[]): void {
  for (const metrics of results) {
    if (metrics.error !== null) console.log(`注意 [${shortId(metrics.id)}] ${metrics.error}`);
    for (const note of metrics.notes) console.log(`注意 [${shortId(metrics.id)}] ${note}`);
  }
}

async function main(): Promise<void> {
  let options: { sessions: string[]; json: boolean };
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exit(2);
  }

  const results: SessionMetrics[] = [];
  for (const session of options.sessions) {
    results.push(await collectSessionMetrics(session));
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printTable(results);
    printInterventions(results);
    printRepeats(results);
    printNotes(results);
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) await main();
