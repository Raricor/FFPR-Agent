/**
 * Departure and turn-back checks for the stage layer (task 96, 11-10). Both are pure: they
 * read a StagePlan and the party's state and never touch the game or the bridge. Wiring them
 * into `go`/`route` and saving the result is a later task.
 */

import type { StageFacts, StagePlan, StageTarget } from "./types.ts";

/** The part of StageFacts these checks need; kept separate so callers can pass a live snapshot. */
export type StageTravelState = Pick<StageFacts, "party" | "bag" | "gil">;

/** A point still ahead on the route, with the walking distance in cells. */
export interface AheadPoint {
  readonly kind: "recovery" | "save";
  readonly target: StageTarget;
  readonly distance: number;
}

export interface DepartureCheck {
  readonly ok: boolean;
  readonly unmet: string[];
}

export interface TurnBackCheck {
  readonly turnBack: boolean;
  readonly reasons: string[];
  readonly continueTo: StageTarget | null;
}

/**
 * 11-10, the user's example: the fire-powered ship's boss room has a recovery device right in
 * front of it, and a party that can be cured there should walk on instead of turning back.
 * Twenty cells is the measured distance from that room's entrance to the device; anything
 * farther is treated as "not close enough to count on".
 */
export const MAX_RECOVERY_DISTANCE = 20;

export interface TurnBackOptions {
  /** A caller-configurable version of MAX_RECOVERY_DISTANCE (task 97 Config). */
  readonly maxRecoveryDistance?: number;
}

/** Item cures by status, matching the Chinese FF5 names in gambit.CURES (skills/gambit.ts). */
const STATUS_CURES: Readonly<
  Record<string, { readonly item: string; readonly spell: string | null }>
> = {
  毒: { item: "解毒药", spell: "解毒" },
  中毒: { item: "解毒药", spell: "解毒" },
  黑暗: { item: "眼药", spell: null },
  石化: { item: "金针", spell: null },
  青蛙: { item: "少女之吻", spell: null },
  迷你: { item: "木槌", spell: null },
  沉默: { item: "回音草", spell: null },
  睡眠: { item: "万能药", spell: null },
  麻痹: { item: "万能药", spell: null },
  混乱: { item: "万能药", spell: null },
};

/** FF5's all-purpose cure; it also covers a status the table above does not name. */
const GENERIC_CURE = "万能药";

/** Both Chinese names the games use for the revive item (grind.ts has the same pair). */
const REVIVE_ITEMS: readonly string[] = ["不死鸟之尾", "凤凰尾"];

function bagCount(bag: StageFacts["bag"], item: string): number {
  let total = 0;
  for (const row of bag) {
    if (row.name === item) total += Math.max(0, row.count);
  }
  return total;
}

function findMember(
  state: StageTravelState,
  name: string,
): StageFacts["party"][number] | undefined {
  return state.party.find((member) => member.name === name);
}

function knowsSpell(member: StageFacts["party"][number], spell: string): boolean {
  return member.spells.some((known) => known === spell || known.includes(spell));
}

function statusMatches(carried: string, wanted: string): boolean {
  return carried === wanted || carried.includes(wanted) || wanted.includes(carried);
}

function carriesStatus(member: StageFacts["party"][number], status: string): boolean {
  return member.status.some((carried) => statusMatches(carried, status));
}

function statusCureItem(status: string): string {
  return STATUS_CURES[status]?.item ?? GENERIC_CURE;
}

function canCureStatus(state: StageTravelState, status: string): boolean {
  if (bagCount(state.bag, statusCureItem(status)) > 0) return true;
  if (bagCount(state.bag, GENERIC_CURE) > 0) return true;
  const spell = STATUS_CURES[status]?.spell;
  if (spell === null || spell === undefined) return false;
  return state.party.some((member) => knowsSpell(member, spell));
}

function hasRevive(state: StageTravelState): boolean {
  if (REVIVE_ITEMS.some((item) => bagCount(state.bag, item) > 0)) return true;
  return state.party.some((member) =>
    member.spells.some((spell) => /复活|Raise|レイズ/iu.test(spell)),
  );
}

function averageHpPercent(party: StageFacts["party"]): number | null {
  const rows = party.filter((member) => member.maxHp > 0);
  if (rows.length === 0) return null;
  let total = 0;
  for (const member of rows) total += Math.min(1, Math.max(0, member.hp / member.maxHp));
  return (total / rows.length) * 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pointName(point: AheadPoint): string {
  return point.target.label === "" ? "回复点" : point.target.label;
}

/** The nearest recovery point that is close enough to walk to before giving up. */
function nearestRecovery(ahead: readonly AheadPoint[], maxDistance: number): AheadPoint | null {
  let best: AheadPoint | null = null;
  for (const point of ahead) {
    if (point.kind !== "recovery") continue;
    if (!Number.isFinite(point.distance) || point.distance < 0) continue;
    if (point.distance > maxDistance) continue;
    if (best === null || point.distance < best.distance) best = point;
  }
  return best;
}

/** Every supply, spell, job and level the plan asks for, one Chinese sentence per miss. */
export function departureCheck(plan: StagePlan, state: StageTravelState): DepartureCheck {
  const unmet: string[] = [];
  for (const supply of plan.supplies) {
    const have = bagCount(state.bag, supply.item);
    if (have < supply.min) {
      unmet.push(`「${supply.item}」不够:要 ${supply.min} 个,背包里只有 ${have} 个`);
    }
  }
  for (const spell of plan.spells) {
    if (spell.for === null) {
      if (!state.party.some((member) => knowsSpell(member, spell.spell))) {
        unmet.push(`没人学会「${spell.spell}」`);
      }
      continue;
    }
    const member = findMember(state, spell.for);
    if (member === undefined) {
      unmet.push(`队伍里没有「${spell.for}」,检查不了「${spell.spell}」`);
    } else if (!knowsSpell(member, spell.spell)) {
      unmet.push(`「${spell.for}」还不会「${spell.spell}」`);
    }
  }
  for (const job of plan.jobs) {
    const member = findMember(state, job.member);
    if (member === undefined) {
      unmet.push(`队伍里没有「${job.member}」,换不了「${job.job}」`);
    } else if (member.job !== job.job) {
      unmet.push(`「${job.member}」现在是「${member.job || "无职业"}」,要换成「${job.job}」`);
    }
  }
  if (plan.minLevel !== null) {
    const minLevel = plan.minLevel;
    const low = state.party.filter((member) => member.level < minLevel);
    if (low.length > 0) {
      const names = low.map((member) => `${member.name}(${member.level} 级)`).join("、");
      unmet.push(`等级不够:要 ${minLevel} 级以上,${names} 还没到`);
    }
  }
  return { ok: unmet.length === 0, unmet };
}

/**
 * Check the plan's turn-back conditions. A status or HP problem that a recovery point within
 * MAX_RECOVERY_DISTANCE can solve does not stop the walk: `continueTo` points at that device.
 * Everything else (a scarce item, no revive, or no close recovery point) stops the party.
 */
export function turnBackCheck(
  plan: StagePlan,
  state: StageTravelState,
  ahead: readonly AheadPoint[],
  options: TurnBackOptions = {},
): TurnBackCheck {
  const maxDistance = options.maxRecoveryDistance ?? MAX_RECOVERY_DISTANCE;
  const reasons: string[] = [];
  let blocked = false;
  let continueTo: StageTarget | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  const recovery = nearestRecovery(ahead, maxDistance);
  const keepGoing = (point: AheadPoint): void => {
    if (point.distance < nearestDistance) {
      nearestDistance = point.distance;
      continueTo = point.target;
    }
  };

  for (const condition of plan.turnBack) {
    switch (condition.kind) {
      case "item-below": {
        const have = bagCount(state.bag, condition.item);
        if (have >= condition.count) break;
        blocked = true;
        reasons.push(`「${condition.item}」只剩 ${have} 个,少于 ${condition.count} 个`);
        break;
      }
      case "status-uncurable": {
        const carriers = state.party.filter((member) => carriesStatus(member, condition.status));
        if (carriers.length === 0) break;
        if (canCureStatus(state, condition.status)) break;
        const item = statusCureItem(condition.status);
        const spell = STATUS_CURES[condition.status]?.spell;
        const who = carriers.map((member) => member.name).join("、");
        if (recovery !== null) {
          reasons.push(
            `${who} 带着「${condition.status}」,背包里没有${item}` +
              `${spell === null || spell === undefined ? "、也没人会治" : `、也没人学会${spell}`},` +
              `前面 ${recovery.distance} 格有回复点「${pointName(recovery)}」,先到那里治`,
          );
          keepGoing(recovery);
        } else {
          blocked = true;
          reasons.push(
            `${who} 带着「${condition.status}」,背包里没有${item}` +
              `${spell === null || spell === undefined ? "、也没人会治" : `、也没人学会${spell}`},` +
              `前面 ${maxDistance} 格内也没有回复点`,
          );
        }
        break;
      }
      case "no-revive": {
        if (hasRevive(state)) break;
        blocked = true;
        reasons.push("没有复活手段:背包里没有不死鸟之尾,也没人学会复活");
        break;
      }
      case "hp-below": {
        const average = averageHpPercent(state.party);
        if (average === null || average >= condition.percent) break;
        const shown = round1(average);
        if (recovery !== null) {
          reasons.push(
            `全队平均 HP 只有 ${shown}%(低于 ${condition.percent}%),` +
              `前面 ${recovery.distance} 格有回复点「${pointName(recovery)}」,先到那里回复`,
          );
          keepGoing(recovery);
        } else {
          blocked = true;
          reasons.push(
            `全队平均 HP 只有 ${shown}%(低于 ${condition.percent}%),` +
              `前面 ${maxDistance} 格内没有回复点`,
          );
        }
        break;
      }
    }
  }

  return {
    turnBack: blocked,
    reasons,
    continueTo: blocked ? null : continueTo,
  };
}
