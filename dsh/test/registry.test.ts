import assert from "node:assert/strict";
import test from "node:test";
import { engineFor, registerSlot, slotFor, slots } from "../src/plugin/registry.ts";
import type { PlayerEngine } from "../src/plugin/player.ts";
import type { EngineSlot } from "../src/plugin/registry.ts";

function engine(game: string): PlayerEngine {
  return { game: { game } } as unknown as PlayerEngine;
}

function slotOf(game: string, started = false): EngineSlot {
  const item = engine(game);
  let current = started ? item : undefined;
  return {
    game,
    current: () => current,
    ensure: () => {
      current = item;
      return Promise.resolve(item);
    },
    stop: () => {
      current = undefined;
    },
  };
}

void test("registering a game makes engineFor find its started engine, in any case", async () => {
  const slot = slotOf("ff3");
  const undo = registerSlot(slot);
  assert.equal(slotFor("ff3"), slot);
  assert.equal(engineFor("ff3"), undefined); // a slot is not a started engine
  const started = await slot.ensure();
  assert.equal(engineFor("ff3"), started);
  assert.equal(engineFor("FF3"), started);
  assert.equal(slots().get("ff3"), slot);
  undo();
  assert.equal(engineFor("ff3"), undefined);
  assert.equal(slot.current(), undefined);
});

void test("a reloaded game keeps the new slot when the old instance unloads", () => {
  const oldSlot = slotOf("ff4", true);
  const newSlot = slotOf("ff4", true);
  const undoOld = registerSlot(oldSlot);
  const undoNew = registerSlot(newSlot);
  assert.equal(engineFor("ff4"), newSlot.current());
  undoOld();
  assert.equal(engineFor("ff4"), newSlot.current());
  undoNew();
  assert.equal(engineFor("ff4"), undefined);
});
