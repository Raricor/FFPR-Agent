import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Config } from "../src/plugin/config.ts";
import { installPlayer, type PlayerLog } from "../src/plugin/player.ts";
import type { EngineSlot } from "../src/plugin/registry.ts";
import type { PresetSelector } from "../src/plugin/preset-switch.ts";

const LOG: PlayerLog = { info: () => undefined, warn: () => undefined };

interface Listener {
  readonly name: string;
  readonly callback: (...args: unknown[]) => void;
  readonly global: boolean;
}

function scenario(): {
  readonly ctx: Context;
  readonly registered: string[];
  readonly emit: (name: string, ...args: unknown[]) => void;
} {
  const registered: string[] = [];
  const agent = {
    id: "agent-1",
    session: { header: { origin: "user" } },
    ctx: {
      effect: (start: () => (() => void) | (() => Promise<void>)) => {
        start();
        return () => undefined;
      },
      tools: {
        register: (tool: { name: string }) => {
          registered.push(tool.name);
          return () => undefined;
        },
        restrict: () => () => undefined,
        schemas: () => [],
      },
      systemPrompt: {
        section: () => () => undefined,
        getSectionOrder: () => 0,
        suppressRuntimeContext: () => () => undefined,
      },
    },
  } as unknown as Agent;

  const listeners: Listener[] = [];
  const ctx = {
    effect: (start: () => (() => void) | (() => Promise<void>)) => {
      start();
      return () => undefined;
    },
    on: (name: string, callback: (...args: unknown[]) => void, options?: { global?: boolean }) => {
      listeners.push({ name, callback, global: options?.global === true });
      return () => undefined;
    },
    systemPrompt: { context: () => () => undefined },
    subagents: {},
    agents: { get: (id: string) => (id === "agent-1" ? agent : undefined) },
    get: () => undefined,
  } as unknown as Context;

  const slot = {
    game: "ff5",
    current: () => undefined,
    ensure: () => Promise.reject(new Error("not used")),
    stop: () => undefined,
  } as unknown as EngineSlot;
  const presets: PresetSelector = {
    select: () => Promise.resolve("ffpr"),
    composedPreset: () => undefined,
  };
  installPlayer(
    ctx,
    slot,
    Config({ game: "ff5" }),
    LOG,
    () => Promise.resolve({ ok: true, running: [] }),
    presets,
  );

  return {
    ctx,
    registered,
    emit: (name, ...args) => {
      for (const listener of listeners) {
        // Cordis's scoped dispatch: a listener without `global` is filtered out when the
        // event is emitted by the host context. The preset-selected event is one of those.
        if (name === "agent-preset/selected" && !listener.global) continue;
        if (listener.name === name) listener.callback(...args);
      }
    },
  };
}

void test("a harness-emitted preset selection mounts the new preset before the first turn", () => {
  const { registered, emit } = scenario();
  emit("agent-preset/selected", "agent-1", "ffpr");
  assert.ok(registered.length > 0, "the target plugin should register its tools on the event");
  assert.ok(registered.includes("plan_facts"), "计划模式默认开,注册的是计划工具");
});

void test("another preset's selection does not mount this game's tools", () => {
  const { registered, emit } = scenario();
  emit("agent-preset/selected", "agent-1", "ffpr-ff6");
  assert.equal(registered.length, 0);
});
