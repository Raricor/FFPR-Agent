import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UnknownGame } from "../src/engine/games.ts";
import { DEPS, LAPTOP_ENV } from "../src/engine/paths.ts";
import { Config, gameDefaults } from "../src/plugin/config.ts";

void test("Config defaults point at FF5's deployment paths and slot", () => {
  const config = Config({});
  assert.equal(config.role, "player");
  assert.equal(config.tacticianBoss, true);
  assert.equal(config.secretsFile, join(homedir(), ".config", "ffpr-agent", "secrets.env"));
  assert.equal(config.laptopEnv, LAPTOP_ENV);
  assert.equal(config.game, "ff5");
  assert.equal(config.saveSlot, 20);
  assert.equal(config.notesFile, join(DEPS, "ds", "notes-ff5.json"));
  assert.equal(config.atlasFile, join(DEPS, "ds", "atlas-ff5.json"));
  assert.equal(config.tacticsFile, join(DEPS, "ds", "tactics-ff5.json"));
  assert.equal(config.elementsFile, join(DEPS, "ds", "elements-ff5.json"));
  assert.equal(config.battlesFile, join(DEPS, "ds", "battles-ff5.jsonl"));
  assert.equal(config.checkEveryMs, 60000);
  assert.equal(config.detectCacheMs, 10000);
  assert.equal(config.autoPresetWaitMs, 3000);
  assert.equal(config.travelMaxHops, 12);
  assert.equal(config.travelMaxMinutes, 10);
  assert.equal(config.bestiaryDeferBattles, 15);
  assert.equal(config.bestiaryMissableMinutes, 40);
  assert.equal(config.walkpathTimeoutMs, 60000);
  assert.equal(config.walkpathBlockedMs, 800);
  assert.equal(config.walkpathTurnLead, 0.6);
  assert.equal(config.walkpathEventPollMs, 200);
  assert.equal(config.walkpathEventWaitMs, 2500);
  assert.equal(config.blockedTrustCount, 3);
  assert.equal(config.tacticianKeepVisible, 2);
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
    assert.equal(defaults.battlesFile, join(DEPS, "ds", `battles-${key}.jsonl`));
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
  assert.equal(config.battlesFile, join(DEPS, "ds", "battles-ff6.jsonl"));
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
    battlesFile: "/tmp/battles.jsonl",
    checkEveryMs: 250,
    detectCacheMs: 1234,
    autoPresetWaitMs: 25,
    travelMaxHops: 20,
    travelMaxMinutes: 45,
    bestiaryDeferBattles: 8,
    bestiaryMissableMinutes: 25,
    walkpathTimeoutMs: 15000,
    walkpathBlockedMs: 120,
    walkpathTurnLead: 0.8,
    walkpathEventPollMs: 50,
    walkpathEventWaitMs: 900,
    blockedTrustCount: 5,
    tacticianKeepVisible: 5,
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
  assert.equal(config.battlesFile, "/tmp/battles.jsonl");
  assert.equal(config.travelMaxHops, 20);
  assert.equal(config.travelMaxMinutes, 45);
  assert.equal(config.bestiaryDeferBattles, 8);
  assert.equal(config.bestiaryMissableMinutes, 25);
  assert.equal(config.checkEveryMs, 250);
  assert.equal(config.detectCacheMs, 1234);
  assert.equal(config.autoPresetWaitMs, 25);
  assert.equal(config.walkpathTimeoutMs, 15000);
  assert.equal(config.walkpathBlockedMs, 120);
  assert.equal(config.walkpathTurnLead, 0.8);
  assert.equal(config.walkpathEventPollMs, 50);
  assert.equal(config.walkpathEventWaitMs, 900);
  assert.equal(config.blockedTrustCount, 5);
  assert.equal(config.tacticianKeepVisible, 5);
});
