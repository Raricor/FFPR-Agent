import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Config } from "../src/plugin/config.ts";

void test("Config defaults point at the deployment paths", () => {
  const config = Config({});
  assert.equal(config.role, "player");
  assert.equal(config.tacticianBoss, true);
  assert.equal(config.secretsFile, join(homedir(), ".config", "ffpr-agent", "secrets.env"));
  assert.equal(config.laptopEnv, "/root/data/mediaflow/FFPR-Agent/agent/laptop.env");
  assert.equal(config.game, "ff5");
  assert.equal(config.notesFile, "/root/data/mediaflow/FFPR-Agent/.deps/ds/notes-ff5.json");
  assert.equal(config.atlasFile, "/root/data/mediaflow/FFPR-Agent/.deps/ds/atlas-ff5.json");
  assert.equal(config.tacticsFile, "/root/data/mediaflow/FFPR-Agent/.deps/ds/tactics-ff5.json");
  assert.equal(config.checkEveryMs, 60000);
  assert.equal(config.bridgeUrl, undefined);
});

void test("Config keeps explicit values", () => {
  const config = Config({
    role: "tactician",
    tacticianBoss: false,
    secretsFile: "/tmp/secrets.env",
    laptopEnv: "/tmp/laptop.env",
    bridgeUrl: "http://127.0.0.1:47800",
    game: "ff6",
    notesFile: "/tmp/notes.json",
    atlasFile: "/tmp/atlas.json",
    tacticsFile: "/tmp/tactics.json",
    checkEveryMs: 250,
  });
  assert.equal(config.role, "tactician");
  assert.equal(config.tacticianBoss, false);
  assert.equal(config.secretsFile, "/tmp/secrets.env");
  assert.equal(config.laptopEnv, "/tmp/laptop.env");
  assert.equal(config.bridgeUrl, "http://127.0.0.1:47800");
  assert.equal(config.game, "ff6");
  assert.equal(config.notesFile, "/tmp/notes.json");
  assert.equal(config.atlasFile, "/tmp/atlas.json");
  assert.equal(config.tacticsFile, "/tmp/tactics.json");
  assert.equal(config.checkEveryMs, 250);
});
