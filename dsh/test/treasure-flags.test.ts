/**
 * Task 135: the bridge 0.14.8 treasure flag reply. The parse must separate a real table from
 * the title-screen answer and from an older bridge's unknown op, so the caller only falls back
 * for the last two.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseTreasureFlags } from "../src/engine/treasure-flags.ts";

void test("a flag table keeps true, false and an unreadable null", () => {
  const read = parseTreasureFlags({
    ok: true,
    treasureflags: { flags: { "12": true, "13": false, "14": null }, total: 3 },
  });
  assert.equal(read.kind, "flags");
  assert.deepEqual(
    [...read.flags],
    [
      [12, true],
      [13, false],
      [14, null],
    ],
  );
  assert.equal(read.total, 3);
});

void test("the title screen / a loading save is not an error", () => {
  assert.deepEqual(parseTreasureFlags({ ok: true, treasureflags: { ready: false } }), {
    kind: "not-ready",
  });
});

void test("an old bridge's unknown op asks for the entity fallback, not an error", () => {
  assert.deepEqual(
    parseTreasureFlags({ ok: false, error: "bridge_error:未知的 op:treasureflags" }),
    { kind: "unsupported" },
  );
  assert.deepEqual(
    parseTreasureFlags({ ok: false, error: "bridge_error:Unknown op:treasureflags" }),
    {
      kind: "unsupported",
    },
  );
});

void test("a broken reply is an error, not a silently empty table", () => {
  assert.equal(parseTreasureFlags({ ok: true }).kind, "error");
  assert.equal(parseTreasureFlags({ ok: true, treasureflags: { flags: [] } }).kind, "error");
});
