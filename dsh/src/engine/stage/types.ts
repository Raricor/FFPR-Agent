/**
 * Shared shapes of the stage layer (tasks 94/95/96, 11-10). A stage is one destination
 * (a dungeon or story place) with the town it starts from and the world map in between.
 */

import type { Json } from "../values.ts";

export type Cell = readonly [number, number];

/** Where the stage goes: a map, an area name from the guide, or both. */
export interface StageTarget {
  readonly mapId: number | null;
  readonly areaName: string | null;
  readonly label: string;
}

export interface StageMonster {
  readonly id: number | null;
  readonly bookId: number | null;
  readonly name: string;
  readonly weak: readonly string[];
  readonly absorb: readonly string[];
  readonly statusMoves: readonly {
    readonly name: string;
    readonly conditions: readonly string[];
  }[];
  readonly blueMagic: readonly string[];
  readonly boss: boolean;
  readonly sources: readonly string[];
  /** Task 100: false when this save's bestiary has not registered this monster yet. */
  readonly registered?: boolean;
}

/** Task 100: what a stage route's `do: "grind"` stop farms until. */
export interface StageGrindUntil {
  readonly bestiary?: readonly (string | number)[];
  readonly blueMagic?: readonly string[];
  readonly battles?: number;
  readonly minutes?: number;
}

/** What the code puts in front of the stage officer. */
export interface StageFacts {
  readonly target: StageTarget;
  readonly monsters: readonly StageMonster[];
  readonly statusThreats: readonly {
    readonly status: string;
    readonly monsters: readonly string[];
    readonly likelihood: "high" | "medium" | "low" | "unknown";
  }[];
  readonly blueMagicMissing: readonly {
    readonly name: string;
    readonly monsters: readonly string[];
    readonly missable: boolean | null;
  }[];
  readonly chests: readonly {
    readonly label: string;
    readonly content: string | null;
    readonly mapId: number | null;
    readonly cell: Cell | null;
    readonly opened: boolean | null;
    readonly missable: boolean | null;
  }[];
  readonly savePoints: readonly {
    readonly mapId: number;
    readonly cell: Cell;
  }[];
  readonly recoveryPoints: readonly {
    readonly mapId: number;
    readonly cell: Cell;
    readonly label: string;
  }[];
  readonly shops: readonly {
    readonly area: string;
    readonly kind: string;
    readonly products: readonly {
      readonly name: string;
      readonly price: number | null;
    }[];
  }[];
  readonly party: readonly {
    readonly name: string;
    readonly job: string;
    readonly level: number;
    readonly hp: number;
    readonly maxHp: number;
    readonly mp: number;
    readonly maxMp: number;
    readonly status: readonly string[];
    readonly spells: readonly string[];
  }[];
  readonly bag: readonly { readonly name: string; readonly count: number }[];
  readonly gil: number;
  readonly bossNotes: readonly string[];
  readonly guideText: string;
}

export type TurnBack =
  | {
      readonly kind: "item-below";
      readonly item: string;
      readonly count: number;
    }
  | { readonly kind: "status-uncurable"; readonly status: string }
  | { readonly kind: "no-revive" }
  | { readonly kind: "hp-below"; readonly percent: number };

/**
 * Task 117: one route-book station carried on a stage-plan stop, so the executor can hand the
 * station back with its guide text and the code can learn the cell the model acted on.
 */
export interface StageBookPoint {
  /** The guide section title ("Wind Shrine"). */
  readonly section: string;
  /** The station's index in that section. */
  readonly index: number;
  /** The guide step kind ("chest", "switch", "cutscene" ...). */
  readonly kind: string;
  /** The guide line as written. */
  readonly text: string;
  /** The sub-location header the step sat under. */
  readonly where: string | null;
  /** For a multi-cell station: this stop's 1-based part and the part count. */
  readonly part?: number;
  readonly parts?: number;
  /** Task 117: a cutscene/talk handoff found exactly one story event and walks it itself. */
  readonly autoStory?: boolean;
  /** The chest/hidden item's name, when the station is a collection stop. */
  readonly item?: string | null;
  /** Task 133: guide step indexes this stop completes (adjacent steps merged into one). */
  readonly indexes?: readonly number[];
  /** Task 133: events and NPCs to show when a story station stays a handoff. */
  readonly candidates?: readonly StageBookCandidate[];
}

/** One event/NPC candidate printed in a handoff's instruction. */
export interface StageBookCandidate {
  readonly kind: "event" | "npc";
  readonly mapId: number;
  readonly name: string;
  readonly names?: {
    readonly ja: string | null;
    readonly en: string | null;
    readonly zhc: string | null;
  } | null;
  readonly cell: readonly [number, number];
}

/** What the stage officer hands back; the code checks it before using it. */
export interface StagePlan {
  readonly threats: readonly string[];
  readonly supplies: readonly {
    readonly item: string;
    readonly min: number;
    readonly buyTo: number;
  }[];
  readonly spells: readonly {
    readonly spell: string;
    readonly for: string | null;
  }[];
  readonly gear: readonly string[];
  readonly jobs: readonly {
    readonly member: string;
    readonly job: string;
    readonly reason: string;
  }[];
  readonly minLevel: number | null;
  readonly route: readonly {
    readonly to: string;
    readonly do?: "open" | "save" | "talk" | "grind" | "boss" | "handoff";
    /** Task 100: a grind stop's conditions; absent for every other action. */
    readonly until?: StageGrindUntil;
    readonly optional?: boolean;
    /** Task 117: set when this stop came from the route book. */
    readonly book?: StageBookPoint;
  }[];
  readonly turnBack: readonly TurnBack[];
  readonly notes: string;
}

/** The party the boss table was written for; jobs and levels are what a later rewrite checks. */
export interface StageBossPartyMember {
  readonly name: string;
  readonly job: string;
  readonly level: number;
}

/**
 * A boss table written before the stage starts (task 106). `mapId` is the map knowledge could
 * pin the boss to; when it is null the record is the stage's own table and the fight matches it
 * by enemy name or bestiary number. The table is kept in the stage plan as well as in Tactics,
 * so a boss on a map nobody could name still starts with the table it was planned with.
 */
export interface StageBossTable {
  readonly names: readonly string[];
  readonly bookIds: readonly number[];
  readonly monsterIds: readonly number[];
  /** The boss's map when knowledge could name one; null means "this stage's table". */
  readonly mapId: number | null;
  readonly table: Json;
  readonly at: string;
  readonly result: string;
  readonly walkerNotes?: string;
  readonly askUp?: string;
  readonly party?: readonly StageBossPartyMember[];
}
