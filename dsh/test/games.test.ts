import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GAMES, TOTAL_ACHIEVEMENTS, UnknownGame, byAppId, byKey } from "../src/engine/games.ts";

interface GamesFixture {
  readonly games: readonly {
    readonly key: string;
    readonly app_id: number;
    readonly title: string;
    readonly achievement_count: number;
    readonly label: string;
  }[];
  readonly total_achievements: number;
  readonly by_key: Record<string, string>;
  readonly by_app_id: Record<string, string>;
  readonly unknown_key: string;
  readonly unknown_app_id: string;
}

const fixture = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "games.json"), "utf8"),
) as GamesFixture;

void test("the registry matches the Python list and the Steam total", () => {
  assert.deepEqual(
    GAMES.map((game) => ({
      key: game.key,
      app_id: game.appId,
      title: game.title,
      achievement_count: game.achievementCount,
      label: game.label,
    })),
    fixture.games,
  );
  assert.equal(TOTAL_ACHIEVEMENTS, fixture.total_achievements);
});

void test("byKey is case-insensitive and byAppId finds the same titles", () => {
  for (const [key, expected] of Object.entries(fixture.by_key)) {
    assert.equal(byKey(key).key, expected);
  }
  for (const [appId, expected] of Object.entries(fixture.by_app_id)) {
    assert.equal(byAppId(Number(appId)).key, expected);
  }
});

void test("unknown keys and App IDs use the Python error messages", () => {
  assert.throws(
    () => byKey("ff7"),
    (error: unknown) => {
      assert.ok(error instanceof UnknownGame);
      assert.equal(error.message, fixture.unknown_key);
      return true;
    },
  );
  assert.throws(() => byAppId(42), new RegExp(fixture.unknown_app_id));
});
