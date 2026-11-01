import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UnknownGame } from "../src/engine/games.ts";
import { DEPS } from "../src/engine/paths.ts";
import { Config, gameDefaults } from "../src/plugin/config.ts";

void test("Config defaults point at FF5's deployment paths and slot", () => {
  const config = Config({});
  assert.equal(config.role, "player");
  assert.equal(config.tacticianBoss, true);
  assert.equal(config.secretsFile, join(homedir(), ".config", "ffpr-agent", "secrets.env"));
  assert.equal(config.laptopEnv, "/root/data/mediaflow/FFPR-Agent/agent/laptop.env");
  assert.equal(config.game, "ff5");
  assert.equal(config.saveSlot, 20);
  assert.equal(config.notesFile, join(DEPS, "ds", "notes-ff5.json"));
  assert.equal(config.atlasFile, join(DEPS, "ds", "atlas-ff5.json"));
  assert.equal(config.tacticsFile, join(DEPS, "ds", "tactics-ff5.json"));
  assert.equal(config.elementsFile, join(DEPS, "ds", "elements-ff5.json"));
  assert.equal(config.checkEveryMs, 60000);
  assert.equal(config.bridgeUrl, undefined);
});

void test("all six games write save slot 20 but keep their own port and files", () => {
  const expected = [
    ["ff1", 20, 47801],
    ["ff2", 20, 47802],
    ["ff3", 20, 47803],
    ["ff4", 20, 47804],
    ["ff5", 20, 47800],
    ["ff6", 20, 47806],
  ] as const;
  for (const [key, slot, port] of expected) {
    const defaults = gameDefaults(key);
    assert.equal(defaults.game.key, key);
    assert.equal(defaults.game.label, key.toUpperCase());
    assert.equal(defaults.saveSlot, slot);
    assert.equal(defaults.bridgePort, port);
    assert.equal(defaults.notesFile, join(DEPS, "ds", `notes-${key}.json`));
    assert.equal(defaults.atlasFile, join(DEPS, "ds", `atlas-${key}.json`));
    assert.equal(defaults.tacticsFile, join(DEPS, "ds", `tactics-${key}.json`));
    assert.equal(defaults.elementsFile, join(DEPS, "ds", `elements-${key}.json`));
  }
});

void test("Config resolves a non-FF5 game's defaults without a preset spelling them out", () => {
  const config = Config({ game: "FF6" });
  assert.equal(config.game, "ff6");
  assert.equal(config.saveSlot, 20);
  assert.equal(config.notesFile, join(DEPS, "ds", "notes-ff6.json"));
  assert.equal(config.atlasFile, join(DEPS, "ds", "atlas-ff6.json"));
  assert.equal(config.tacticsFile, join(DEPS, "ds", "tactics-ff6.json"));
  assert.equal(config.elementsFile, join(DEPS, "ds", "elements-ff6.json"));
});

void test("Config rejects a game the plugin does not know", () => {
  assert.throws(
    () => Config({ game: "ff7" }),
    (error: unknown) => {
      assert.ok(error instanceof UnknownGame);
      assert.match(error.message, /未知的作品/);
      return true;
    },
  );
});

void test("Config keeps explicit values", () => {
  const config = Config({
    role: "tactician",
    tacticianBoss: false,
    secretsFile: "/tmp/secrets.env",
    laptopEnv: "/tmp/laptop.env",
    bridgeUrl: "http://127.0.0.1:47800",
    game: "ff6",
    saveSlot: 4,
    notesFile: "/tmp/notes.json",
    atlasFile: "/tmp/atlas.json",
    tacticsFile: "/tmp/tactics.json",
    elementsFile: "/tmp/elements.json",
    checkEveryMs: 250,
  });
  assert.equal(config.role, "tactician");
  assert.equal(config.tacticianBoss, false);
  assert.equal(config.secretsFile, "/tmp/secrets.env");
  assert.equal(config.laptopEnv, "/tmp/laptop.env");
  assert.equal(config.bridgeUrl, "http://127.0.0.1:47800");
  assert.equal(config.game, "ff6");
  assert.equal(config.saveSlot, 4);
  assert.equal(config.notesFile, "/tmp/notes.json");
  assert.equal(config.atlasFile, "/tmp/atlas.json");
  assert.equal(config.tacticsFile, "/tmp/tactics.json");
  assert.equal(config.elementsFile, "/tmp/elements.json");
  assert.equal(config.checkEveryMs, 250);
});
