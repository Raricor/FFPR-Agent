/**
 * The segment plan (11-11, the user's direction): the player model writes one complete plan
 * per route-book section — walking and chests, battle rules, grinding, boss preparation and
 * boss actions — and code executes all of it without calling the model. The model only
 * plans again when code reports an exception. Shared by tasks 137 (facts, validation), 138
 * (executor) and 139 (wiring, tools, prompt).
 */

import type { GrindUntil } from "../route/types.ts";
import type { Json } from "../values.ts";

/** What code does at a station. `move` only walks; `story` walks onto a trigger and pages it. */
export type PlanStationAction =
  | "move"
  | "open" // a chest or hidden item
  | "save"
  | "heal" // a recovery point or inn
  | "talk" // speak to an NPC / examine something, then page the dialog
  | "switch" // a mechanism: lever, skull, pushable wall
  | "story" // step on a story trigger
  | "choose" // answer a dialog choice with `choose`
  | "grind"
  | "boss"
  | "buy"; // task 151/152: walk to a town shop and buy `items` (then code re-optimizes gear)

export interface PlanStation {
  /** `"map:x,y"` or `"map"` (anywhere on that map), the spelling the route tool accepts. */
  readonly to: string;
  readonly do: PlanStationAction;
  /** Chinese, one short line: why this station is here. */
  readonly why?: string;
  /** `choose`: the option index (0-based) or its text. */
  readonly choose?: number | string;
  /** `grind`: when to stop (bestiary entries, blue magic, battles, minutes). */
  readonly until?: GrindUntil;
  /** `buy`: what to buy here, in this order (code buys what the gil allows). */
  readonly items?: readonly { readonly item: string; readonly count: number }[];
  /** Code may skip it when it cannot be reached (heal/save default to optional). */
  readonly optional?: boolean;
  /** Where the station came from in the route book, when it did. */
  readonly book?: { readonly section: string; readonly index: number };
}

/** Done once before departure, in this order. Each list may be empty. */
export interface PlanPrep {
  readonly jobs: readonly {
    readonly member: string;
    readonly job: string;
    readonly abilities?: readonly string[];
  }[];
  /** `optimize` = let code pick the strongest gear for everyone. */
  readonly equip: "optimize" | "keep";
  readonly buy: readonly { readonly item: string; readonly count: number }[];
  readonly rows: readonly {
    readonly member: string;
    readonly row: "front" | "back";
  }[];
}

/** Normal-battle rule tables, the same format as `set_tactics`/`fight`. */
export interface PlanBattle {
  /** Maps these tables apply to; empty = every map of the segment. */
  readonly maps: readonly number[];
  /** 1–3 tables; code switches to the next one when a battle goes badly. */
  readonly tables: readonly Json[];
}

export interface PlanBoss {
  readonly name: string;
  readonly map: number | null;
  /** Heal and save right before the boss (code does both when true). */
  readonly healFirst: boolean;
  readonly saveFirst: boolean;
  /** The boss fight's rule tables (same format), tried in order. */
  readonly tables: readonly Json[];
  /** Chinese: anything code should know (e.g. "first turn: Lenna casts Protect on all"). */
  readonly notes?: string;
}

/** When code must stop executing and ask the model for a new plan. */
export interface PlanTurnBack {
  /** Machine-checkable condition, e.g. `party.lowest_hp_pct < 30`, `item.不死鸟之尾 < 1`. */
  readonly when: string;
  readonly then: "heal-and-continue" | "replan";
}

export interface SegmentPlan {
  readonly version: 1;
  /** The route-book section this plan covers ("Wind Shrine"). */
  readonly section: string;
  /** Chinese one-liner: what finishing this segment means. */
  readonly goal: string;
  readonly prep: PlanPrep;
  readonly stations: readonly PlanStation[];
  readonly battle: readonly PlanBattle[];
  readonly bosses: readonly PlanBoss[];
  readonly turnBack: readonly PlanTurnBack[];
  readonly notes?: string;
  /**
   * Task 146: stations the previous plan of this section had not done yet and this plan no
   * longer does, each with a Chinese reason. A revision keeps every other remaining station.
   */
  readonly dropped?: readonly PlanDroppedStation[];
}

export interface PlanDroppedStation {
  readonly to: string;
  readonly do: PlanStationAction;
  readonly why: string;
}

export type PlanExceptionKind =
  | "unreachable" // a required station cannot be reached
  | "boss-lost"
  | "gameover"
  | "story-choice" // a dialog choice the plan did not answer
  | "stuck" // no progress within the time budget
  | "turn-back" // a turnBack condition with then = replan fired
  | "invalid" // the plan referred to something that does not exist
  | "other";

/** What code hands back to the model after executing (or failing to execute) a plan. */
export interface SegmentReport {
  readonly section: string;
  readonly status: "done" | "exception" | "aborted";
  readonly exception?: {
    readonly kind: PlanExceptionKind;
    readonly map: number | null;
    readonly cell: readonly [number, number] | null;
    /** Index into `stations` of the station that failed, when one did. */
    readonly station: number | null;
    /** Chinese: what happened and what code already tried. */
    readonly detail: string;
  };
  readonly done: {
    readonly stations: number;
    readonly chestsOpened: number;
    readonly battles: number;
    readonly bestiaryNew: readonly string[];
    readonly blueMagicNew: readonly string[];
    readonly bossesWon: readonly string[];
  };
  /** Indexes into `stations` not done yet. */
  readonly remaining: readonly number[];
  /** Chinese, one line: party level, HP/MP, ailments, key items. */
  readonly party: string;
  readonly minutes: number;
  /** Model calls made while executing; the goal is 0. */
  readonly modelCalls: number;
}

export type SegmentStationStatus = "pending" | "current" | "done" | "failed" | "skipped";

/**
 * The live progress of the plan being executed (11-11, the user could not see the plan): the
 * executor writes it at the start, after every station and at the end (task 145); the sidebar
 * panel only reads it (task 147). File: `segmentProgressPath(game)` in `store.ts`.
 */
export interface SegmentProgress {
  readonly game: string;
  readonly section: string;
  /**
   * The executed plan's `goal`, so a reader can tell this progress from a newer plan of the
   * same section that was submitted but not executed yet (compare section, goal and stations).
   */
  readonly goal: string;
  /** Plans executed for this section so far, this one included (1 = the first plan). */
  readonly revision: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** null while running. */
  readonly finishedAt: string | null;
  readonly status: "running" | SegmentReport["status"];
  /** One entry per `stations` item of the plan being executed, same order. */
  readonly stations: readonly {
    readonly index: number;
    readonly status: SegmentStationStatus;
    /** Chinese, one line: what happened ("开了 (9,11) 帐篷", "到不了：…"). */
    readonly note: string;
  }[];
  /** Why this plan exists: the previous run of the same section, when it ended in an exception. */
  readonly previousException: {
    readonly kind: PlanExceptionKind;
    readonly detail: string;
  } | null;
}
