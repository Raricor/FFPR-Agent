/**
 * The shapes of the knowledge module (task 93).
 *
 * Three layers, kept apart here:
 * - game data: `master` (the bridge plugin's export) and `guide` (the walkthroughs);
 * - this save's progress: `save`;
 * - what walking found: `observed` (the atlas and the collision cache).
 *
 * Every answer carries `sources`; a fact both layers know and disagree on also carries
 * `conflicts` instead of one side silently winning. Numbers prefer `master`, prose prefers
 * `guide`. The export file format is documented at the top of `index.ts`.
 */

import type { Atlas } from "../atlas.ts";
import type { Guide } from "../guide/kb.ts";
import type { GameProfile } from "../profiles/types.ts";
import type { CollisionStore } from "../regions.ts";
import type { GameMapFile, TrilingualNames } from "./game-files.ts";

/**
 * `master` is the bridge export, `files` the extracted game files (task 121), `guide` a
 * walkthrough, `save` this save's progress and `observed` what walking recorded.
 */
export type SourceKind = "master" | "files" | "guide" | "save" | "observed";

/** One origin: the export file, a guide section, a save record or the atlas. */
export interface SourceRef {
  readonly kind: SourceKind;
  readonly ref: string;
}

export type ConflictValue =
  string | number | boolean | null | readonly string[] | readonly number[];

/** A field the two sources disagree on; neither value is thrown away. */
export interface FactConflict {
  readonly field: string;
  readonly master: ConflictValue;
  readonly guide: ConflictValue;
}

/** The module's common wrapper: the chosen value, where it came from, and any disagreement. */
export interface MergedFact<T> {
  readonly value: T;
  readonly sources: readonly SourceRef[];
  readonly conflicts?: readonly FactConflict[];
}

// ---------------------------------------------------------------------------------------------
// The bridge export (`.deps/knowledge/<game>/static/<table>.json`). Missing fields are null,
// arrays are empty rather than absent, and every row keeps every key.

export interface ExportFile<R> {
  readonly game: string;
  readonly build: string | null;
  readonly bridge: string | null;
  readonly exportedAt: string | null;
  readonly table: string;
  readonly rows: readonly R[];
}

export interface MapsRow {
  readonly id: number | null;
  readonly name: string | null;
  readonly areaId: number | null;
  readonly areaName: string | null;
  readonly areaType: string | null;
}

export interface MonsterDropRow {
  readonly itemId: number | null;
  readonly name: string | null;
  readonly rate: number | null;
}

export interface MonsterMoveRow {
  readonly abilityId: number | null;
  readonly name: string | null;
  readonly blueMagic: boolean | null;
  readonly conditions: readonly string[];
  readonly rate: number | null;
}

export interface MonstersRow {
  readonly id: number | null;
  readonly name: string | null;
  readonly bookId: number | null;
  readonly level: number | null;
  readonly hp: number | null;
  readonly mp: number | null;
  readonly weak: readonly string[];
  readonly absorb: readonly string[];
  readonly nullify: readonly string[];
  readonly statusImmune: readonly string[];
  readonly drops: readonly MonsterDropRow[];
  readonly steal: readonly MonsterDropRow[];
  readonly boss: boolean | null;
  readonly scriptId: string | null;
  readonly moves: readonly MonsterMoveRow[] | null;
}

export interface EncountersRow {
  readonly scope: "map" | "area" | null;
  readonly mapId: number | null;
  readonly areaId: number | null;
  readonly groupId: number | null;
  readonly weight: number | null;
  readonly monsterIds: readonly number[];
}

export interface TreasuresRow {
  readonly id: number | null;
  readonly areaId: number | null;
  readonly mapId: number | null;
  readonly cell: readonly [number, number] | null;
  readonly hidden: boolean | null;
  readonly contentId: number | null;
  readonly contentName: string | null;
  readonly count: number | null;
  readonly flag: string | null;
}

export interface ShopProductRow {
  readonly itemId: number | null;
  readonly name: string | null;
  readonly price: number | null;
}

export interface ShopsRow {
  readonly id: number | null;
  readonly mapId: number | null;
  readonly areaName: string | null;
  readonly kind: string | null;
  readonly products: readonly ShopProductRow[];
}

export interface ItemRestores {
  readonly hp?: number;
  readonly mp?: number;
}

export interface ItemsRow {
  readonly id: number | null;
  readonly name: string | null;
  readonly kind: string | null;
  readonly price: number | null;
  readonly cures: readonly string[];
  readonly restores: ItemRestores | null;
}

export interface MagicRow {
  readonly id: number | null;
  readonly name: string | null;
  readonly school: string | null;
  readonly mp: number | null;
  readonly cures: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Save progress, passed in by the caller (the game knows the current save count). The static
// export never contains it, and the module never writes it.

export interface SaveProgress {
  /** Whether the caller actually read this save's opened chests; absent means unknown. */
  readonly openedChestsKnown?: boolean;
  /** Treasure ids or flags this save has opened. */
  readonly openedChests: readonly (number | string)[];
  /** Bestiary numbers registered in this save. */
  readonly bestiary: readonly number[];
  /** Blue magic ability ids or names this save has learned. */
  readonly blueMagic: readonly (number | string)[];
  /** Whether the caller actually read this save's visited maps; absent means unknown. */
  readonly visitedMapsKnown?: boolean;
  /** Map ids entered in this save. */
  readonly visitedMaps: readonly number[];
}

export type SaveProgressInput = Partial<SaveProgress>;

// ---------------------------------------------------------------------------------------------
// The merged knowledge a query reads. Everything here is plain data except the reused Guide,
// Atlas and CollisionStore, which stay live objects so callers can enrich them.

export interface MapKnowledge {
  readonly id: number | null;
  readonly name: string | null;
  readonly areaId: number | null;
  readonly areaName: string | null;
  readonly areaType: string | null;
  readonly visited: boolean | null;
  readonly sources: readonly SourceRef[];
  readonly conflicts: readonly FactConflict[];
}

export interface EncounterKnowledge {
  /**
   * `map` is one dungeon map's monster set, `world` is one world map encounter region. The old
   * `area` scope came from the bridge export, which mixed map areas and encounter areas.
   */
  readonly scope: "map" | "area" | "world" | null;
  readonly mapId: number | null;
  /** The map's `area_id` (a dungeon's area, or the world map area). */
  readonly areaId: number | null;
  /** `encount_area.csv` id; null for dungeon rows and for the old bridge rows. */
  readonly encounterAreaId: number | null;
  /** Every map this row applies to (a world region covers both halves of its world map). */
  readonly mapIds: readonly number[];
  readonly mapName: string | null;
  readonly areaName: string | null;
  readonly groupId: number | null;
  readonly weight: number | null;
  readonly monsterIds: readonly number[];
  /** World map rows: false when all foot sets are merged because the terrain was not read. */
  readonly terrainSubdivided: boolean | null;
  readonly sources: readonly SourceRef[];
}

export interface MoveKnowledge {
  readonly abilityId: number | null;
  readonly name: string;
  readonly blueMagic: boolean | null;
  readonly conditions: readonly string[];
  readonly rate: number | null;
  readonly sources: readonly SourceRef[];
}

export interface MonsterKnowledge {
  readonly id: number | null;
  readonly bookId: number | null;
  readonly name: string;
  readonly level: number | null;
  readonly hp: number | null;
  readonly mp: number | null;
  readonly boss: boolean | null;
  readonly weak: readonly string[];
  readonly absorb: readonly string[];
  readonly nullify: readonly string[];
  readonly statusImmune: readonly string[];
  readonly drops: readonly MonsterDropRow[];
  readonly steal: readonly MonsterDropRow[];
  readonly moves: readonly MoveKnowledge[];
  /** Statuses the moves can inflict, unique and in move order. */
  readonly statuses: readonly string[];
  /** Blue spells the guide says this monster teaches, when the master has no move rows. */
  readonly guideBlueMagic: readonly string[];
  /** Areas the guide names for this monster (English walkthrough names). */
  readonly guideAreas: readonly string[];
  readonly guideNote: string | null;
  /** Encounter groups, filled in by `monstersIn` for its filter; all groups otherwise. */
  readonly encounters: readonly EncounterKnowledge[];
  /** Sum of the selected groups' weights; null when no group's weight is readable. */
  readonly encounterWeight: number | null;
  /** 0-1 chance one battle has this monster; null when the weights are unknown. */
  readonly encounterChance: number | null;
  readonly sources: readonly SourceRef[];
  readonly conflicts: readonly FactConflict[];
}

export interface StatusMoveThreat {
  readonly monster: string;
  readonly bookId: number | null;
  readonly move: string;
  /** The move's rate as 0-1, or null when the export did not carry one. */
  readonly rate: number | null;
  readonly chance: number | null;
  /** chance × rate; null when either side is unknown. */
  readonly score: number | null;
  readonly sources: readonly SourceRef[];
}

export interface StatusThreat {
  readonly status: string;
  /** Sum of the known scores; null when every contribution is unknown. */
  readonly score: number | null;
  /** True when at least one move's rate or encounter chance is unknown. */
  readonly unknown: boolean;
  readonly moves: readonly StatusMoveThreat[];
  readonly sources: readonly SourceRef[];
}

export interface BlueMagicMonster {
  readonly monster: string;
  readonly bookId: number | null;
  readonly move: string;
  readonly areas: readonly string[];
  readonly sources: readonly SourceRef[];
}

export interface BlueMagicSource {
  readonly abilityId: number | null;
  readonly name: string;
  readonly learned: boolean;
  readonly from: readonly BlueMagicMonster[];
  readonly sources: readonly SourceRef[];
}

export interface ChestGuide {
  readonly n: number | null;
  readonly section: string;
  readonly where: string;
  readonly text: string;
  readonly kind: "chest" | "hidden";
}

export interface ChestKnowledge {
  readonly id: number | null;
  readonly areaId: number | null;
  readonly areaName: string | null;
  readonly mapId: number | null;
  readonly mapName: string | null;
  readonly cell: readonly [number, number] | null;
  readonly hidden: boolean;
  readonly contentId: number | null;
  readonly contentName: string | null;
  /** `contentId` in Japanese, English and Simplified Chinese, from `files/items.json`. */
  readonly contentNames: TrilingualNames | null;
  readonly count: number | null;
  /** The game file's numeric flag, kept beside the string form the old export used. */
  readonly flagId: number | null;
  readonly flag: string | null;
  /** true / false from this save, null when the save has not said. */
  readonly opened: boolean | null;
  readonly guide: ChestGuide | null;
  /** Found by walking (the atlas recorded it), even when no export or guide lists it. */
  readonly observed: boolean;
  readonly sources: readonly SourceRef[];
  readonly conflicts: readonly FactConflict[];
}

export interface ShopProduct {
  readonly itemId: number | null;
  readonly name: string;
  /** Guide/other-language names for the same product (11-11: Fire and 火炎). */
  readonly aliases?: readonly string[];
  readonly price: number | null;
  readonly sources: readonly SourceRef[];
  readonly conflicts: readonly FactConflict[];
}

export interface ShopKnowledge {
  readonly id: number | null;
  readonly mapId: number | null;
  readonly areaName: string | null;
  readonly kind: string | null;
  readonly products: readonly ShopProduct[];
  readonly guideWhere: string | null;
  readonly sources: readonly SourceRef[];
  readonly conflicts: readonly FactConflict[];
}

export interface ItemKnowledge {
  readonly id: number | null;
  readonly name: string;
  readonly kind: string | null;
  readonly price: number | null;
  readonly cures: readonly string[];
  readonly restores: ItemRestores | null;
  readonly sources: readonly SourceRef[];
  readonly conflicts: readonly FactConflict[];
}

export interface MagicKnowledge {
  readonly id: number | null;
  readonly name: string;
  readonly school: string | null;
  readonly mp: number | null;
  readonly cures: readonly string[];
  readonly sources: readonly SourceRef[];
  readonly conflicts: readonly FactConflict[];
}

export interface ContentItemKnowledge {
  readonly id: number;
  readonly kind: string | null;
  readonly names: TrilingualNames;
  readonly sources: readonly SourceRef[];
}

/** A save point or a restore point read from a map file. */
export interface PointKnowledge {
  readonly mapId: number | null;
  readonly mapName: string | null;
  readonly areaId: number | null;
  readonly areaName: string | null;
  readonly cell: readonly [number, number];
  readonly name: string;
  readonly sources: readonly SourceRef[];
}

export interface CureKnowledge {
  readonly kind: "item" | "magic";
  readonly id: number | null;
  readonly name: string;
  readonly cures: readonly string[];
  readonly sources: readonly SourceRef[];
}

export interface MissableKnowledge {
  readonly kind: "treasure" | "monster";
  /** The place for treasure rules, the bestiary label for monster rules. */
  readonly label: string;
  readonly areaIds: readonly number[];
  readonly numbers: readonly number[];
  readonly until: string;
  /** The story flag that is surely after the deadline, when the profile names one. */
  readonly past: string | null;
  /** True when the queried story point is at or past the rule's `past`. */
  readonly lostAfter: boolean;
  readonly sources: readonly SourceRef[];
  readonly conflicts: readonly FactConflict[];
}

/** Everything a query needs; built once by `load`, then read by the pure functions. */
export interface Knowledge {
  readonly game: string;
  readonly build: string | null;
  readonly bridge: string | null;
  /** The static export directory actually read, for diagnostics. */
  readonly staticDir: string;
  /** `.deps/knowledge/<game>/files/`, when the extracted game files are present. */
  readonly filesDir: string | null;
  /** The exported map files, kept for shops: clerk cells and map titles (11-11). */
  readonly mapFiles?: readonly GameMapFile[];
  /** Table names that had a file; an absent table is an empty list, not an error. */
  readonly tables: readonly string[];
  readonly guide: Guide | null;
  readonly atlas: Atlas | null;
  readonly collisions: CollisionStore | null;
  readonly profile: GameProfile | null;
  readonly progress: SaveProgress;
  readonly maps: readonly MapKnowledge[];
  readonly encounters: readonly EncounterKnowledge[];
  readonly monsters: readonly MonsterKnowledge[];
  readonly chests: readonly ChestKnowledge[];
  readonly shops: readonly ShopKnowledge[];
  readonly items: readonly ItemKnowledge[];
  readonly magic: readonly MagicKnowledge[];
  /** `contentId` → three-language name, from the game files (empty before task 121 data). */
  readonly contentItems: readonly ContentItemKnowledge[];
  readonly savePoints: readonly PointKnowledge[];
  readonly restorePoints: readonly PointKnowledge[];
  readonly sources: readonly SourceRef[];
  readonly conflicts: readonly FactConflict[];
}
