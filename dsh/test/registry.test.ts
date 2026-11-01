import assert from "node:assert/strict";
import test from "node:test";
import { engineFor, engines, registerEngine } from "../src/plugin/registry.ts";
import type { PlayerEngine } from "../src/plugin/player.ts";

function engine(game: string): PlayerEngine {
  return { game: { game } } as unknown as PlayerEngine;
}

void test("registering a game makes engineFor find it, in any case", () => {
  const first = engine("ff3");
  const undo = registerEngine(first);
  assert.equal(engineFor("ff3"), first);
  assert.equal(engineFor("FF3"), first);
  assert.equal(engines().get("ff3"), first);
  undo();
  assert.equal(engineFor("ff3"), undefined);
});

void test("a reloaded game keeps the new engine when the old instance unloads", () => {
  const oldEngine = engine("ff4");
  const newEngine = engine("ff4");
  const undoOld = registerEngine(oldEngine);
  const undoNew = registerEngine(newEngine);
  assert.equal(engineFor("ff4"), newEngine);
  undoOld();
  assert.equal(engineFor("ff4"), newEngine);
  undoNew();
  assert.equal(engineFor("ff4"), undefined);
});
