/**
 * The chapter plan (11-11, the user's direction, after the per-section plans stayed short):
 * the player model reads the walkthrough for a whole chapter (several guide sections, up to
 * the next story milestone), plans everything in it at the highest thinking effort — routes
 * with every chest and hidden item, bestiary and blue magic per map, shopping in each town,
 * long-term levelling and gil, boss preparation and actions — and writes it as one rule file.
 * Code checks the file for coverage, then executes the whole chapter without the model. The
 * model is called again only when code's own fallbacks (retry, reroute, heal, grind and retry
 * a boss, skip-and-record an optional station) all failed.
 *
 * Shared by tasks 150 (chapter ranges and facts), 151 (draft, validation, tools), 152
 * (executor) and 153 (wiring, prompt, panel). A chapter's sections are SegmentPlans
 * (`types.ts`), so everything the section executor learned stays in use.
 */

import type { Cell } from "../nav.ts";
import type { SegmentFactsData } from "./facts.ts";
import type { PlanExceptionKind, SegmentPlan, SegmentReport } from "./types.ts";

/**
 * One chapter: walkthrough sections `from`..`to` (indexes into the guide's walkthrough list,
 * inclusive). The list lives in `chapters.ts` (task 150) as numbers only; titles are read from
 * the guide at run time, so no guide text is committed.
 */
export interface ChapterRange {
  /** 1-based chapter number. */
  readonly chapter: number;
  readonly from: number;
  readonly to: number;
}

/** Long-term growth: before segment `before` starts, code grinds until the targets hold. */
export interface ChapterGrowthTarget {
  /** Index into `ChapterPlan.segments`. */
  readonly before: number;
  /** Lowest level in the party. */
  readonly level?: number;
  /** Gil in hand. */
  readonly gil?: number;
  /** Where to grind: `"map"` or `"map:x,y"`, the station spelling. */
  readonly where: string;
  /** Chinese, one line. */
  readonly why: string;
  /** Hard stop so a bad estimate cannot grind forever. */
  readonly maxMinutes: number;
}

/** What code does on its own before it calls the model (the user chose this on 11-11). */
export interface ChapterFallback {
  /** Times a failed station is retried with a fresh route before it counts as failed. */
  readonly retries: number;
  /** A boss that wins: grind `levels` more levels at `where`, heal, try again, `tries` times. */
  readonly bossLost: {
    readonly levels: number;
    readonly where: string | null;
    readonly tries: number;
  };
  /** An optional station (chest, hidden item, grind) that stays unreachable: skip, record it. */
  readonly skipOptional: boolean;
  /** Walk back to the nearest inn / recovery point when the lowest HP% drops below this and
   *  no one can heal in the field. */
  readonly healBelowPct: number;
}

export interface ChapterSkipped {
  readonly kind: "bestiary" | "blueMagic" | "hidden" | "chest" | "shop" | "boss";
  /** The name as the facts spell it (monster, spell, item, shop). */
  readonly name: string;
  /** `"map"` or `"map:x,y"` when it is tied to a place. */
  readonly where?: string;
  readonly why: string;
}

export interface ChapterPlan {
  readonly version: 1;
  readonly chapter: number;
  /** Chinese one-liner: what finishing this chapter means. */
  readonly goal: string;
  /** The chapter's remaining guide sections, in play order; each is a full section plan. */
  readonly segments: readonly SegmentPlan[];
  readonly growth: readonly ChapterGrowthTarget[];
  readonly fallback: ChapterFallback;
  /**
   * Collection targets in the facts this plan deliberately does not go for (a bestiary entry,
   * blue magic, hidden item, chest or shop), each with a Chinese reason; task 151 requires
   * every uncovered target to be here.
   */
  readonly skipped?: readonly ChapterSkipped[];
  readonly notes?: string;
}

/** A hidden item (examine spot, pot, invisible treasure) found in the game files (task 150). */
export interface ChapterHiddenItem {
  /**
   * `hidden`: an invisible treasure on a cell (has a treasure flag, examine the cell).
   * `event`: an item a script hands out (song at a piano, NPC reward); how to trigger it is in
   * the walkthrough, and the cell may only be where the event starts (11-11 real export).
   */
  readonly kind: "hidden" | "event";
  readonly mapId: number;
  readonly cell: Cell;
  readonly item: string;
  readonly opened: boolean | null;
  /** Where the fact came from ("游戏文件 sc_e_0123", "攻略"). */
  readonly source: string;
}

/** One town shop with what it sells (task 150); prices in gil, null when unknown. */
export interface ChapterShop {
  readonly mapId: number;
  readonly town: string;
  readonly kind: string;
  /** Where to stand to talk to the clerk, when known. */
  readonly counter: Cell | null;
  readonly products: readonly {
    readonly name: string;
    readonly price: number | null;
  }[];
}

/** One map's encounters, so bestiary / blue magic / gil / exp can be planned per map. */
export interface ChapterEncounterMap {
  readonly mapId: number;
  readonly mapName: string;
  readonly monsters: readonly {
    readonly name: string;
    readonly bookId: number | null;
    readonly registered: boolean | null;
    readonly blueMagic: readonly string[];
    readonly exp: number | null;
    readonly gil: number | null;
    readonly abp: number | null;
  }[];
}

/** What the chapter's progress file says (task 152 writes, 153's panel reads). */
export interface ChapterProgress {
  readonly game: string;
  readonly chapter: number;
  readonly goal: string;
  readonly revision: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly status: "running" | "done" | "exception" | "blocked" | "aborted";
  /** Index into `segments` being executed. */
  readonly segment: number;
  /** Per segment: the section, its stations' state (same shape as SegmentProgress). */
  readonly segments: readonly {
    readonly section: string;
    readonly stations: readonly {
      readonly index: number;
      readonly status: "pending" | "current" | "done" | "failed" | "skipped";
      readonly note: string;
    }[];
  }[];
  /** Fallbacks code used on its own ("第 2 节第 5 站重试 1 次后走通"). */
  readonly fallbacks: readonly string[];
  readonly previousException: {
    readonly kind: PlanExceptionKind;
    readonly detail: string;
  } | null;
  /** Task 155: set when the executor's own fallbacks failed and an operator must repair it. */
  readonly blockedText?: string;
}

/** What code hands back after a chapter run. */
export interface ChapterReport {
  readonly chapter: number;
  readonly status: "done" | "exception" | "blocked" | "aborted";
  /** The segment reports in order (the failed one last). */
  readonly segments: readonly SegmentReport[];
  readonly fallbacks: readonly string[];
  /** Set when status is "exception": where it stopped and why, after every fallback failed. */
  readonly exception?: {
    readonly kind: PlanExceptionKind;
    /** Index into `ChapterPlan.segments`. */
    readonly segment: number;
    readonly station: number | null;
    /** Chinese: what happened and which fallbacks code already tried. */
    readonly detail: string;
  };
  readonly minutes: number;
  /** Model calls during execution; the goal is 0. */
  readonly modelCalls: number;
  /** Task 155: "等待修复：第 x 节第 y 站：原因" when the run stopped for an operator. */
  readonly blockedText?: string;
}

/**
 * Everything the model reads before it writes a chapter plan (task 150 builds it, 151 checks
 * plans against it). Each section keeps the per-section sheet the section planner already had.
 */
export interface ChapterFactsData {
  readonly game: string;
  readonly chapter: number;
  readonly from: number;
  readonly to: number;
  readonly sections: readonly {
    /** Index into the guide's walkthrough list. */
    readonly index: number;
    /** The guide's section title, read at run time. */
    readonly title: string;
    /** True when the route book / story flags say this section is finished. */
    readonly done: boolean;
    readonly facts: SegmentFactsData;
  }[];
  readonly hiddenItems: readonly ChapterHiddenItem[];
  readonly shops: readonly ChapterShop[];
  readonly encounters: readonly ChapterEncounterMap[];
}
