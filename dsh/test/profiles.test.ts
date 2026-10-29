import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GAMES, UnknownGame } from "../src/engine/games.ts";
import { profileFor } from "../src/engine/profiles/index.ts";

void test("every game has a profile whose Steam list matches its achievement count", () => {
  for (const game of GAMES) {
    const profile = profileFor(game.key);
    assert.equal(profile.key, game.key);
    assert.equal(profile.achievements.length, game.achievementCount, game.key);
  }
});

void test("the six Steam counts are the ones the games registry knows", () => {
  assert.deepEqual(
    GAMES.map((game) => profileFor(game.key).achievements.length),
    [24, 28, 31, 30, 39, 37],
  );
});

void test("an unknown game key is an error, not an empty profile", () => {
  assert.throws(() => profileFor("ff7"), UnknownGame);
});

interface ProfileFixture {
  readonly treasure: readonly { area: number; name: string; type: number; total: number }[];
  readonly bestiary: readonly { number: number; name: string; areas: readonly number[] }[];
}

/** Title-screen dumps of the games whose missables were matched against the guides. */
async function fixture(key: string): Promise<ProfileFixture> {
  const path = new URL(`./fixtures/profiles/${key}.json`, import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as ProfileFixture;
}

const DUMPED = ["ff2", "ff3", "ff4", "ff6"];

void test("every one-time place is an area of the game that holds boxes", async () => {
  for (const key of DUMPED) {
    const { treasure } = await fixture(key);
    for (const place of profileFor(key).oneTimePlaces) {
      assert.ok(
        treasure.some((row) => row.area === place.area),
        `${key} area ${place.area}`,
      );
    }
  }
});

void test("every missable monster exists and lives only where its rule looks", async () => {
  // The bestiary page trusts a rule only when all recorded areas are the rule's own.
  for (const key of DUMPED) {
    const { bestiary } = await fixture(key);
    for (const rule of profileFor(key).bestiaryMissables) {
      for (const number of rule.numbers) {
        const entry = bestiary.find((item) => item.number === number);
        assert.ok(entry, `${key} No.${number}`);
        assert.ok(
          entry.areas.every((area) => rule.areas.includes(area)),
          `${key} No.${number} ${entry.name} lives in ${entry.areas.join(",")}`,
        );
      }
    }
  }
});

void test("FF6's one-time places hold the guide's 88 chests and 8 hidden items", async () => {
  // 回归者总部 has 3 hidden items where the guide names 1: two more than the guide.
  const { treasure } = await fixture("ff6");
  const areas = new Set(profileFor("ff6").oneTimePlaces.map((place) => place.area));
  const total = (type: number) =>
    treasure
      .filter((row) => row.type === type && areas.has(row.area))
      .reduce((sum, row) => sum + row.total, 0);
  assert.equal(total(1), 88);
  assert.equal(total(2), 8 + 2);
});
