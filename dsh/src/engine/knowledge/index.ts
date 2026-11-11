/**
 * The knowledge module (task 93): game data, this save's progress and what walking observed,
 * kept apart and queried through one object. FF5 first; the other five games migrate once this
 * shape has held.
 *
 * Three layers:
 * - game data (same for every save, per game and game build): maps, monsters (moves, the
 *   statuses they inflict, blue magic), encounter tables, chests (place, content, flag), shops,
 *   items, equipment and magic. Sources are `master` (the bridge plugin's export), `files`
 *   (the extracted game files, task 121) and `guide` (the Steam walkthrough and ludo.guide).
 *   `files` wins for encounters, chests and positions: `master:encounters.json` mixed map areas
 *   with the separate world-map encounter regions (task 121), so it is only a fallback now.
 * - this save's progress: opened chests, registered bestiary numbers, learned blue magic,
 *   visited maps. Source `save`.
 * - what walking found: landings, conveyors, drops, lifts, "cannot get through" records (with
 *   a count), met monsters, battle records. Source `observed`.
 *
 * Source rules (the user's, 11-10): both game data and guides are primary. Numbers (HP, price,
 * encounter weight, chest content) prefer `master`; how to walk, order, tactics, missable
 * reminders and boss notes prefer `guide`. When both know a field and disagree, both values are
 * kept in `conflicts` — nothing is silently chosen. Every fact carries `sources`.
 *
 * The export (shared with task 92, written by the bridge plugin) is
 * `.deps/knowledge/ff5/static/<table>.json`, one file per table:
 *
 *     { "game": "ff5", "build": "<游戏 build 号或 null>", "bridge": "0.14.5",
 *       "exportedAt": "ISO 时间", "table": "<表名>", "rows": [ ... ] }
 *
 * Tables and rows:
 * - `maps`: {id, name, areaId, areaName, areaType}
 * - `monsters`: {id, name, bookId, level, hp, mp, weak, absorb, nullify, statusImmune, drops,
 *   steal, boss, scriptId, moves}
 * - `encounters`: {scope: "map"|"area", mapId, areaId, groupId, weight, monsterIds}
 * - `treasures`: {id, areaId, mapId, cell, hidden, contentId, contentName, count, flag}
 * - `shops`: {id, mapId, areaName, kind, products}
 * - `items`: {id, name, kind, price, cures, restores}
 * - `magic`: {id, name, school, mp, cures}
 *
 * A missing field is `null`; a missing key is not omitted. A missing directory or table is an
 * empty list, never an error.
 *
 *     const knowledge = await loadKnowledge({ game: "ff5", saves, progress });
 *     const monsters = monstersIn(knowledge, { areaIds: [71] });
 *     const fireShip = monstersIn(knowledge, { areaName: "火力船" }); // guide-only too
 *     statusThreats(monsters);
 *     blueMagicSources(knowledge, { learned: ["青魔法 id"] });
 *     chestsIn(knowledge, { mapIds: [252], opened: false });
 *     chestsIn(knowledge, { areaName: "火力船" }); // before any areaId/mapId export
 *     monstersIn(knowledge, { encounterAreaIds: [65] }); // a world encounter region
 *     contentName(knowledge, 4); // {ja, en, zhc}
 *     contentByName(knowledge, "Potion");
 *     savePointsIn(knowledge, { mapIds: [30] });
 *     shopsNear(knowledge, "沃尔斯城");
 *     itemsThatCure(knowledge, "中毒");
 *     missablesAfter(knowledge, "scenario_5");
 *
 * Adding the other five games: export the same tables per game; `loadKnowledge({game})` already
 * reads `.deps/knowledge/<game>/static`. The matching rules do not change. The only FF5-specific
 * parts are the profile deadlines (`profiles/<game>.ts`) and the guide's area aliases
 * (`guide/kb.ts`, currently FF5's), which should gain one table per game rather than branching
 * inside this module. Until then, a non-FF5 game answers from `master` and its own save stores.
 */

export {
  TABLES,
  defaultFiles,
  loadInputs,
  loadKnowledge,
  readGameFiles,
  readStatic,
  type FilesData,
  type KnowledgeOptions,
  type LoadedKnowledge,
  type StaticData,
  type TableName,
} from "./load.ts";

export { areaKeys, buildKnowledge, mergeSources, normalizeName } from "./merge.ts";
export { shopsOnMap, type MapShop, type MapShopProduct } from "./shops.ts";

export type { TrilingualNames } from "./game-files.ts";

export {
  blueMagicSources,
  bossMapIds,
  chestsIn,
  contentByName,
  contentItemsNamed,
  contentName,
  itemsThatCure,
  missablesAfter,
  monstersIn,
  restorePointsIn,
  savePointsIn,
  shopsNear,
  statusThreats,
  type BlueMagicOptions,
  type BossMapQuery,
  type ChestFilter,
  type MonsterFilter,
  type PointFilter,
} from "./query.ts";

export type {
  BlueMagicMonster,
  BlueMagicSource,
  ChestGuide,
  ChestKnowledge,
  ConflictValue,
  ContentItemKnowledge,
  CureKnowledge,
  EncountersRow,
  EncounterKnowledge,
  ExportFile,
  FactConflict,
  ItemKnowledge,
  ItemRestores,
  ItemsRow,
  Knowledge,
  MagicKnowledge,
  MagicRow,
  MapKnowledge,
  MapsRow,
  MergedFact,
  MissableKnowledge,
  MonsterDropRow,
  MonsterKnowledge,
  MonsterMoveRow,
  MonstersRow,
  MoveKnowledge,
  PointKnowledge,
  SaveProgress,
  SaveProgressInput,
  ShopKnowledge,
  ShopProduct,
  ShopProductRow,
  ShopsRow,
  SourceKind,
  SourceRef,
  StatusMoveThreat,
  StatusThreat,
  TreasuresRow,
} from "./types.ts";
