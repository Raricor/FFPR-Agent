/**
 * The route book's live progress (11-11): the executor (task 117) writes it after every
 * station, the sidebar panel (task 118) only reads it. File:
 * `.deps/ds/routebook-progress-<game>.json`, next to `routebook-<game>.json`.
 */

/** done: finished by code; handoff: given to the model (it finished or skipped it). */
export type BookStationStatus = "pending" | "current" | "done" | "handoff" | "skipped";

export interface BookStationProgress {
  /** The station's index in the route book section (RouteBook stations order). */
  readonly index: number;
  readonly status: BookStationStatus;
  /** Chinese, one line: what happened ("开了 (9,11) 帐篷", "交回 AI:骷髅开关，坐标未知"). */
  readonly note: string;
}

/** The acceptance numbers of one section (the user's 11-11 bar: model calls, go, chests ...). */
export interface BookSectionStats {
  /** Game tool calls by the model while this section ran. */
  readonly tools: number;
  readonly go: number;
  readonly route: number;
  /** Stations the model had to take over. */
  readonly handoffs: number;
  readonly chestsOpened: number;
  readonly chestsTotal: number;
  /** null when unknown (no bestiary/blue magic reading). */
  readonly bestiaryMissing: number | null;
  readonly blueMagicMissing: number | null;
  readonly minutes: number;
  /** Task 133: working time, without idle gaps longer than ten minutes. */
  readonly activeMs?: number;
  /** Task 133: when the last counted tool call ended. */
  readonly lastToolAt?: string;
}

export interface BookProgress {
  readonly game: string;
  /** The guide section title being run ("Wind Shrine"). */
  readonly section: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** null while running. */
  readonly finishedAt: string | null;
  readonly stations: readonly BookStationProgress[];
  readonly stats: BookSectionStats;
}
