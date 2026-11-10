import assert from "node:assert/strict";
import test from "node:test";
import { ActivityLog } from "../src/engine/activity.ts";
import { Redactor } from "../src/engine/redact.ts";
import { createPlayerLog } from "../src/plugin/player.ts";

void test("plugin warnings also reach the activity log, with secrets masked", () => {
  const redactor = new Redactor();
  redactor.add("super-secret");
  const activity = new ActivityLog({
    game: "ff5",
    redact: (value) => redactor.redact(value),
    now: () => new Date("2026-11-10T10:00:00.000Z"),
  });
  const dsh: { info: string[]; warn: string[] } = { info: [], warn: [] };
  const log = createPlayerLog(
    {
      info: (message) => dsh.info.push(message),
      warn: (message) => dsh.warn.push(message),
    },
    () => [activity, undefined],
  );

  log.warn("桥插件断开:super-secret");
  log.info("跟随事件流");

  assert.deepEqual(dsh.warn, ["桥插件断开:super-secret"]);
  assert.deepEqual(dsh.info, ["跟随事件流"]);
  assert.equal(activity.entries.length, 1);
  assert.equal(activity.entries[0]?.kind, "warn");
  assert.equal(activity.entries[0].text, "桥插件断开:***");
});

void test("a warning logged before the engine starts is flushed into its activity log", () => {
  const activity = new ActivityLog({
    game: "ff5",
    now: () => new Date("2026-11-10T10:00:00.000Z"),
  });
  const state: { engine?: ActivityLog } = {};
  const dsh: string[] = [];
  const log = createPlayerLog(
    { info: () => undefined, warn: (message) => dsh.push(message) },
    () => (state.engine === undefined ? [] : [state.engine]),
  );

  log.warn("拿不到 agentPresets 服务");
  assert.equal(activity.entries.length, 0);
  assert.deepEqual(dsh, ["拿不到 agentPresets 服务"]);

  state.engine = activity;
  log.flush?.(activity);
  assert.equal(activity.entries[0]?.kind, "warn");
  assert.equal(activity.entries[0].text, "拿不到 agentPresets 服务");
});
