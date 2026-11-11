/**
 * Task 150: the game-file inputs a chapter fact sheet needs. The map export already carries
 * hidden item spots and clerk NPCs; `Data/Master/monster.csv` supplies exp / gil / ABP, which
 * the knowledge module does not keep. This module is the only file reader: `chapter-facts.ts`
 * stays pure and takes the result as a value.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describeError, isMissingFile } from "../errors.ts";
import { DEPS } from "../paths.ts";
import {
  parseMonsterRewards,
  type GameMapFile,
  type MonsterPartyResource,
  type MonsterReward,
} from "./game-files.ts";
import { readGameFiles } from "./load.ts";

/** What `buildChapterFacts` receives when the caller has read the game files. */
export interface ChapterFileData {
  readonly maps: readonly GameMapFile[];
  /** `monster.csv` id → battle reward; absent rows mean "unknown", not zero. */
  readonly rewards: ReadonlyMap<number, MonsterReward>;
}

async function readOptionalText(path: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (isMissingFile(error)) return null;
    signal?.throwIfAborted();
    throw new Error(`读不了怪物表 ${path}:${describeError(error)}`, {
      cause: error,
    });
  }
}

async function readRewards(
  filesDir: string,
  game: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, MonsterReward>> {
  const candidates = [
    join(filesDir, "master", "monster.csv"),
    join(DEPS, game, "files", "Data", "Master", "monster.csv"),
  ];
  for (const path of candidates) {
    const text = await readOptionalText(path, signal);
    if (text !== null) return parseMonsterRewards(text);
  }
  return new Map();
}

/**
 * ABP is `monster_party.csv`'s `get_ap`, not a monster column: one battle with a party gives it.
 * A monster may sit in several parties; use the most common value, then the smallest.
 */
function abpByMonster(parties: readonly MonsterPartyResource[]): Map<number, number> {
  const counts = new Map<number, Map<number, number>>();
  for (const party of parties) {
    if (party.getAp === null) continue;
    for (const monsterId of party.monsterIds) {
      const values = counts.get(monsterId) ?? new Map<number, number>();
      values.set(party.getAp, (values.get(party.getAp) ?? 0) + 1);
      counts.set(monsterId, values);
    }
  }
  const out = new Map<number, number>();
  for (const [monsterId, values] of counts) {
    const best = [...values.entries()].sort(
      ([leftAp, leftCount], [rightAp, rightCount]) => rightCount - leftCount || leftAp - rightAp,
    )[0];
    if (best !== undefined) out.set(monsterId, best[0]);
  }
  return out;
}

/** Read the exported maps and the master monster table; a missing directory gives empty data. */
export async function readChapterFileData(
  filesDir: string,
  game = "ff5",
  signal?: AbortSignal,
): Promise<ChapterFileData> {
  const files = await readGameFiles(filesDir, game, signal);
  const rewards = new Map(await readRewards(filesDir, game, signal));
  for (const [monsterId, abp] of abpByMonster(files?.monsterParties ?? [])) {
    const reward = rewards.get(monsterId) ?? {
      exp: null,
      gil: null,
      abp: null,
    };
    rewards.set(monsterId, { ...reward, abp });
  }
  return {
    maps: files?.maps ?? [],
    rewards,
  };
}
