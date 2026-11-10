/**
 * Chinese renderings of one stage plan (task 97, 11-10). The stage officer and the game's tool
 * result show the same summary, so the text lives in the engine where both can use it.
 */

import type { StageGrindUntil, StagePlan, TurnBack } from "./types.ts";

function grindUntilText(until: StageGrindUntil): string {
  const parts: string[] = [];
  if (until.bestiary !== undefined && until.bestiary.length > 0) {
    parts.push(`图鉴:${until.bestiary.join("、")}`);
  }
  if (until.blueMagic !== undefined && until.blueMagic.length > 0) {
    parts.push(`青魔法:${until.blueMagic.join("、")}`);
  }
  if (until.battles !== undefined) parts.push(`${until.battles} 场`);
  if (until.minutes !== undefined) parts.push(`${until.minutes} 分钟`);
  return parts.join(";");
}

function turnBackText(condition: TurnBack): string {
  switch (condition.kind) {
    case "item-below":
      return `${condition.item} 少于 ${condition.count} 个`;
    case "status-uncurable":
      return `带着「${condition.status}」治不了`;
    case "no-revive":
      return "没有复活手段";
    case "hp-below":
      return `全队平均 HP 低于 ${condition.percent}%`;
  }
}

/** A short Chinese rendering of the plan; problems (when present) are appended verbatim. */
export function describeStagePlan(
  plan: StagePlan,
  label: string,
  problems: readonly string[] = [],
): string {
  const lines = [`### 阶段计划${label.trim() === "" ? "" : `：${label.trim()}`}`];
  lines.push(plan.threats.length === 0 ? "威胁：无" : `威胁：${plan.threats.join("、")}`);
  lines.push(
    plan.supplies.length === 0
      ? "补给：无"
      : `补给：${plan.supplies
          .map((supply) => `${supply.item} 至少 ${supply.min}、买到 ${supply.buyTo}`)
          .join("；")}`,
  );
  lines.push(
    plan.spells.length === 0
      ? "法术：无"
      : `法术：${plan.spells
          .map((entry) => `${entry.spell}${entry.for === null ? "" : `（${entry.for}）`}`)
          .join("、")}`,
  );
  lines.push(plan.gear.length === 0 ? "装备：无" : `装备：${plan.gear.join("、")}`);
  lines.push(
    plan.jobs.length === 0
      ? "职业：不换"
      : `职业：${plan.jobs.map((job) => `${job.member}→${job.job}（${job.reason}）`).join("；")}`,
  );
  lines.push(`最低等级：${plan.minLevel ?? "不限"}`);
  lines.push(
    plan.route.length === 0
      ? "路线：无"
      : `路线：${plan.route
          .map((stop, index) => {
            const action = stop.do === undefined ? "" : `[${stop.do}]`;
            const until =
              stop.do === "grind" && stop.until !== undefined
                ? `(${grindUntilText(stop.until)})`
                : "";
            const optional = stop.optional === true ? "（可选）" : "";
            return `${index + 1}. ${stop.to}${action}${until}${optional}`;
          })
          .join(" → ")}`,
  );
  lines.push(
    plan.turnBack.length === 0
      ? "回头条件：无"
      : `回头条件：${plan.turnBack.map(turnBackText).join("；")}`,
  );
  if (plan.notes.trim() !== "") lines.push(`备注：${plan.notes.trim()}`);
  if (problems.length > 0) {
    lines.push("", "### 还没通过检查");
    for (const problem of problems) lines.push(`- ${problem}`);
  }
  return lines.join("\n");
}
