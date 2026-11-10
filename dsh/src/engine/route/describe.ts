/**
 * The Chinese text a stage official (and the model) reads for one plan (task 79). At most 30
 * lines: legs first, then the waypoints that could not be reached, then non-waypoint warnings.
 */

import type { Cell } from "../nav.ts";
import type { RouteLeg, RoutePlan, WaypointKind } from "./types.ts";

const KIND_NAMES: Readonly<Record<WaypointKind | "end", string>> = {
  chest: "宝箱",
  grind: "刷怪",
  shop: "商店",
  inn: "旅馆",
  save: "存档",
  boss: "首领",
  move: "移动",
  story: "剧情",
  end: "终点",
};

const MAX_LINES = 30;
const MAX_UNREACHABLE_LINES = 8;
const MAX_WARNING_LINES = 4;

function minutesText(minutes: number): string {
  if (minutes < 1 / 60) return "0 秒";
  if (minutes < 1) return `${Math.round(minutes * 60)} 秒`;
  if (minutes < 10) return `${minutes.toFixed(1)} 分钟`;
  return `${Math.round(minutes)} 分钟`;
}

function cellText(cell: Cell | null): string {
  return cell === null ? "任意格" : `(${cell[0]},${cell[1]})`;
}

function legLine(leg: RouteLeg, index: number): string {
  return (
    `  ${index + 1}. ${KIND_NAMES[leg.kind]}「${leg.label}」 ` +
    `地图 ${leg.map} ${cellText(leg.cell)}：` +
    `经过 ${leg.maps.join(" → ")}，${leg.hops} 跳，${Math.round(leg.cells)} 格，` +
    minutesText(leg.minutes)
  );
}

function tailLines(plan: RoutePlan): string[] {
  const lines: string[] = [];
  if (plan.unreachable.length > 0) {
    lines.push(`走不到（${plan.unreachable.length} 个）：`);
    const shown = plan.unreachable.slice(0, MAX_UNREACHABLE_LINES);
    for (const waypoint of shown) {
      lines.push(
        `  - ${KIND_NAMES[waypoint.kind]}「${waypoint.label}」 ` +
          `地图 ${waypoint.map} ${cellText(waypoint.cell)}：${waypoint.reason}`,
      );
    }
    if (plan.unreachable.length > shown.length) {
      lines.push(`  …（还有 ${plan.unreachable.length - shown.length} 个）`);
    }
  }
  if (plan.warnings.length > 0) {
    lines.push("提醒：");
    for (const warning of plan.warnings.slice(0, MAX_WARNING_LINES)) {
      lines.push(`  - ${warning}`);
    }
    if (plan.warnings.length > MAX_WARNING_LINES) {
      lines.push(`  …（还有 ${plan.warnings.length - MAX_WARNING_LINES} 条）`);
    }
  }
  return lines;
}

/** One plan as Chinese text, at most 30 lines. */
export function describe(plan: RoutePlan): string {
  const header =
    `路线：${plan.legs.length} 段，${plan.total.hops} 跳，` +
    `约 ${Math.round(plan.total.cells)} 格、${minutesText(plan.total.minutes)}`;
  const tail = tailLines(plan);
  const budget = MAX_LINES - 1 - tail.length;
  const legLines = plan.legs.map((leg, index) => legLine(leg, index));
  let shown = legLines;
  if (shown.length > budget) {
    const keep = Math.max(0, budget - 1);
    shown = [...legLines.slice(0, keep), `  …（还有 ${legLines.length - keep} 段）`];
  }
  const lines = [header, ...shown, ...tail];
  return lines.join("\n");
}
