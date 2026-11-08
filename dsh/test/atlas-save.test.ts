/**
 * Task 57: the atlas's visited set is save-local. Structure comes back across runs; which maps
 * this save entered comes back from the save-count snapshot, or from `live` after a restart.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Atlas } from "../src/engine/atlas.ts";
import { AtlasSave } from "../src/engine/atlas-save.ts";
import { Game } from "../src/engine/game.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import { FakePilot } from "./fake-pilot.ts";

const LAPTOP: Laptop = { host: "laptop", user: "player", key: "/tmp/key", root: "C:/ffpr" };

void test("a save snapshot is used when an earlier count is loaded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-atlas-earlier-"));
  const atlasPath = join(directory, "atlas.json");
  const savePath = join(directory, "atlas-save-ff5.json");
  try {
    const atlas = await Atlas.load(atlasPath);
    await atlas.visit(30, "图尔村", [], []);
    const store = await AtlasSave.load("ff5", savePath, atlas);
    await store.snapshot(2, "2026-11-05T00:00:00.000Z");
    await atlas.visit(31, "运河", [], []);
    await store.snapshot(3, "2026-11-05T00:10:00.000Z");

    const reloadedAtlas = await Atlas.load(atlasPath);
    const reloaded = await AtlasSave.load("ff5", savePath, reloadedAtlas);
    assert.equal(reloadedAtlas.visited(30), false);
    reloaded.restore(2);
    assert.equal(reloadedAtlas.visited(30), true);
    assert.equal(reloadedAtlas.visited(31), false);
    assert.equal(reloadedAtlas.maps.has("31"), true);
    assert.equal(reloadedAtlas.mark(31), "(没去过)");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a restart before the next save keeps maps entered after the last save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-atlas-restart-"));
  const atlasPath = join(directory, "atlas.json");
  const savePath = join(directory, "atlas-save-ff5.json");
  try {
    const atlas = await Atlas.load(atlasPath);
    await atlas.visit(30, "图尔村", [], []);
    const store = await AtlasSave.load("ff5", savePath, atlas);
    await store.snapshot(2, "2026-11-05T00:00:00.000Z");
    await atlas.visit(31, "运河", [], []); // after the save, before the web restart

    const reloadedAtlas = await Atlas.load(atlasPath);
    const reloaded = await AtlasSave.load("ff5", savePath, reloadedAtlas);
    reloaded.restore(2);
    assert.equal(reloadedAtlas.visited(30), true);
    assert.equal(reloadedAtlas.visited(31), true);
    assert.equal(reloadedAtlas.mark(31), "(去过)");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a larger count with no snapshot keeps the live set and only moves the count", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-atlas-live-"));
  const atlasPath = join(directory, "atlas.json");
  const savePath = join(directory, "atlas-save-ff5.json");
  try {
    const atlas = await Atlas.load(atlasPath);
    await atlas.visit(30, "图尔村", [], []);
    const store = await AtlasSave.load("ff5", savePath, atlas);
    await store.snapshot(2, "2026-11-05T00:00:00.000Z");
    await atlas.visit(31, "运河", [], []);

    store.restore(3); // a save happened, captureBestiary has not written the snapshot yet
    assert.equal(store.saves, 3);
    assert.equal(store.snapshotFor(3), null);
    assert.equal(atlas.visited(30), true);
    assert.equal(atlas.visited(31), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a new game at count 0 with no snapshot clears the visited set", async () => {
  const atlas = new Atlas();
  const store = await AtlasSave.load("ff5", undefined, atlas);
  store.restore(5);
  await atlas.visit(30, "图尔村", [], []);
  store.restore(0);
  assert.equal(atlas.visited(30), false);
  assert.equal(store.saves, 0);
});

void test("a null save count changes nothing", async () => {
  const atlas = new Atlas();
  const store = await AtlasSave.load("ff5", undefined, atlas);
  await atlas.visit(30, "图尔村", [], []);
  store.restore(null);
  assert.equal(atlas.visited(30), true);
  assert.equal(store.saves, null);
});

void test("the game snapshots even after restore moved the count first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-atlas-race-"));
  const options = {
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    atlasFile: join(directory, "atlas.json"),
    atlasSaveFile: join(directory, "atlas-save-ff5.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    bestiarySaveFile: join(directory, "bestiary-save-ff5.json"),
  };
  try {
    const game = await Game.create(options);
    game.atlasSave.restore(10);
    await game.atlas.visit(30, "图尔村", [], []);
    await game.atlas.visit(31, "运河", [], []);
    game.atlasSave.restore(11); // completion ran before the save snapshot
    const pilot = new FakePilot();
    pilot.on("pos", { pos: { state: "Player", map: 31, cell: [1, 1], saves: 11 } });
    pilot.onQuery("achievements", { achievements: { defs: [], save: null, bestiary: null } });
    await game.captureBestiary(pilot);

    const snapshot = game.atlasSave.snapshotFor(11);
    assert.deepEqual(snapshot?.maps, [30, 31]);
    assert.equal(game.atlas.visited(30), true);
    assert.equal(game.atlas.visited(31), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("the game snapshots on a save and a reloaded game starts from it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-atlas-game-"));
  const options = {
    laptop: LAPTOP,
    game: "ff5",
    saveSlot: 20,
    atlasFile: join(directory, "atlas.json"),
    atlasSaveFile: join(directory, "atlas-save-ff5.json"),
    tacticsFile: join(directory, "tactics.json"),
    elementsFile: join(directory, "elements.json"),
    bestiarySaveFile: join(directory, "bestiary-save-ff5.json"),
  };
  try {
    const game = await Game.create(options);
    await game.atlas.visit(30, "图尔村", [], []);
    await game.atlas.visit(31, "运河", [], []);
    const pilot = new FakePilot();
    pilot.on("pos", { pos: { state: "Player", map: 31, cell: [1, 1], saves: 2 } });
    pilot.onQuery("achievements", { achievements: { defs: [], save: null, bestiary: null } });
    await game.captureBestiary(pilot);

    await game.atlas.visit(32, "城堡", [], []);
    const reloaded = await Game.create(options);
    reloaded.atlasSave.restore(2);
    assert.deepEqual(reloaded.atlasSave.snapshotFor(2)?.maps, [30, 31]);
    assert.equal(reloaded.atlas.visited(30), true);
    assert.equal(reloaded.atlas.visited(31), true);
    assert.equal(reloaded.atlas.visited(32), true); // live survived the restart
    assert.equal(reloaded.atlas.maps.has("32"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
