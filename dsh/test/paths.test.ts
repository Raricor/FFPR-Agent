import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { configDir, DEPS, REPO, secretsPath } from "../src/engine/paths.ts";

void test("the repo is the FFPR-Agent checkout above the package", () => {
  assert.ok(existsSync(join(REPO, "agent", "src", "ffpr_agent")));
  assert.equal(DEPS, join(REPO, ".deps"));
});

void test("config and secrets paths follow paths.py's overrides", () => {
  assert.equal(configDir({ HOME: "/h", FFPR_CONFIG_DIR: "/c" }), "/c");
  assert.equal(configDir({ XDG_CONFIG_HOME: "/x" }), "/x/ffpr-agent");
  assert.equal(secretsPath({ FFPR_SECRETS: "/s.env" }), "/s.env");
  assert.equal(secretsPath({ FFPR_CONFIG_DIR: "/c" }), "/c/secrets.env");
});
