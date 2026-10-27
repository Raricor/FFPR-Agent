import assert from "node:assert/strict";
import test from "node:test";
import { Config, inject, name } from "../src/index.ts";

void test("the plugin exposes its loader identity, services, and config schema", () => {
  assert.equal(name, "ffpr");
  assert.deepEqual(inject, ["tools", "agents", "systemPrompt", "subagents", "commands"]);
  assert.equal(typeof Config, "function");
});
