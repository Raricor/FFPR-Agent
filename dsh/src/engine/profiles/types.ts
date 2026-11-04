/**
 * The per-game data the achievement, bestiary and strategy pages need (task 20). One profile
 * per Pixel Remaster title; the engine reads only through GameProfile, so no page is tied to
 * FF5's constants any more.
 */

export interface AchievementInfo {
  readonly api: string;
  readonly name: string;
  readonly description: string;
  readonly hidden: boolean;
}

export interface OneTimePlace {
  readonly area: number;
  /** Until when its boxes can still be taken, for the warning. */
  readonly until: string;
  /** The first story achievement certainly after the deadline; without one the row only warns. */
  readonly past?: string;
}

export interface MissableRule {
  readonly numbers: readonly number[];
  readonly areas: readonly number[];
  readonly until: string;
  /** The first story achievement certainly after the deadline, when one is known. */
  readonly past?: string;
}

/** 「全部在某个地点」: e.g. FF5's sealed weapons are the 12 hidden items of 封印之间. */
export interface AreaGoal {
  readonly api: string;
  readonly area: number;
  readonly kind: "chest" | "hidden";
}

export interface GameProfile {
  /** "ff6" */
  readonly key: string;
  /** The Steam achievement list, in the public page's order. */
  readonly achievements: readonly AchievementInfo[];
  /** Chests lost for good after a story point, by area. */
  readonly oneTimePlaces: readonly OneTimePlace[];
  /** Bestiary numbers lost for good after a story point. */
  readonly bestiaryMissables: readonly MissableRule[];
  /** Achievements counted over one place's treasure of one kind. */
  readonly areaGoals: readonly AreaGoal[];
  /**
   * Element names for ids the game's weak-row sentences leave out. The ids differ by game
   * (10-28 dumps: FF3's 5 is wind, FF4's 6 is thrown weapons), so FF5's table is FF5's only.
   */
  readonly elements: Readonly<Record<number, string>>;
}
