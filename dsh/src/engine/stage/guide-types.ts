/**
 * Shapes shared by the guide step parser (task 114) and the route book (task 115), 11-11.
 * A walkthrough section of the Steam guide ("Tule", "Wind Shrine") becomes ordered steps under
 * sub-location headers ("Wind Shrine - 2F"); the route book aligns them with map ids.
 */

/** What one guide line asks the player to do. `note` is anything the parser cannot classify. */
export type GuideStepKind =
  | "move" // go somewhere: "Head east and go up the stairs."
  | "chest" // a [n/225] chest
  | "hidden" // a {n/46} hidden item (barrel, pot, bush ...)
  | "talk" // speak to someone / answer a prompt
  | "switch" // a mechanism: skull switch, lever, push a wall
  | "save" // a save point / consecrated circle
  | "heal" // a recovery point (healing pot, spring)
  | "boss" // a boss fight
  | "cutscene" // a story scene to trigger or watch
  | "shop" // shopping
  | "piano" // a Piano Maestro piano
  | "note"; // anything else (trivia, tips)

/** One monster row of a "BESTIARY: X" table in the guide; `id` is the in-game bestiary number. */
export interface GuideMonster {
  readonly id: number;
  readonly name: string;
  /** "BM: Goblin Punch" right after the row; null when the guide names none. */
  readonly blueMagic: string | null;
}

/** A boss block (name, then the stat table); fields the guide leaves blank are null. */
export interface GuideBoss {
  readonly name: string;
  readonly hp: number | null;
  readonly weak: readonly string[];
  readonly resist: readonly string[];
  readonly absorb: readonly string[];
}

export interface GuideStep {
  /** Position inside the section, from 0, in the guide's order. */
  readonly index: number;
  /** The sub-location header the step sits under ("Wind Shrine - 2F", "Overworld"); null before the first one. */
  readonly where: string | null;
  readonly kind: GuideStepKind;
  /** The guide line as written (English), trimmed. */
  readonly text: string;
  /** A [n/225] chest or {n/46} hidden item reference on this line. */
  readonly ref: { readonly kind: "chest" | "hidden"; readonly n: number } | null;
  /** The item the line names for a chest/hidden step ("Tent", "150 Gil"); null when unclear. */
  readonly item: string | null;
  /** Set on a boss step. */
  readonly boss: GuideBoss | null;
}

export interface GuideSection {
  /** The walkthrough section title ("Tule", "Wind Shrine"). */
  readonly title: string;
  /** Position of the section in the walkthrough, from 0. */
  readonly order: number;
  /** Sub-location headers in first-seen order. */
  readonly places: readonly string[];
  readonly steps: readonly GuideStep[];
  /** Bestiary rows of the section, each with the sub-location header it was listed under. */
  readonly monsters: readonly (GuideMonster & { readonly where: string | null })[];
}
