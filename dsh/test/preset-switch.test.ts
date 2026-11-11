import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import { Config } from "../src/plugin/config.ts";
import type { DetectionResult } from "../src/plugin/detect.ts";
import {
  presetMountFor,
  registerPresetMount,
  resetPresetMounts,
} from "../src/plugin/preset-hooks.ts";
import { buildSystemPrompt, installPlayer } from "../src/plugin/player.ts";
import {
  playerPresetId,
  switchToOpenGame,
  type CreatedAgent,
  type PresetSelector,
} from "../src/plugin/preset-switch.ts";
import type { EngineSlot } from "../src/plugin/registry.ts";

interface SelectCall {
  readonly agent: Agent;
  readonly preset: string;
}

function fakePresets(failure?: Error): {
  readonly service: PresetSelector;
  readonly calls: SelectCall[];
} {
  const calls: SelectCall[] = [];
  return {
    service: {
      select: (agent, preset) => {
        calls.push({ agent, preset });
        if (failure !== undefined) return Promise.reject(failure);
        return Promise.resolve(preset);
      },
      composedPreset: () => undefined,
    },
    calls,
  };
}

function fakeAgent(origin?: "subagent"): Agent {
  return {
    id: "agent-1",
    session: { header: origin === undefined ? {} : { origin } },
  } as unknown as Agent;
}

function fakeAgentWithRegistration(): Agent {
  const ctx = {
    effect: (start: () => (() => void) | (() => Promise<void>)) => {
      start();
      return () => undefined;
    },
    tools: {
      register: () => () => undefined,
      restrict: () => () => undefined,
      schemas: () => [],
    },
    systemPrompt: {
      section: () => () => undefined,
      getSectionOrder: () => 0,
      suppressRuntimeContext: () => () => undefined,
    },
  };
  return {
    id: "agent-1",
    session: { header: {} },
    ctx,
  } as unknown as Agent;
}

interface Logs {
  readonly infos: string[];
  readonly warnings: string[];
  readonly log: { info(message: string): void; warn(message: string): void };
}

function fakeLog(): Logs {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    infos,
    warnings,
    log: {
      info: (message) => infos.push(message),
      warn: (message) => warnings.push(message),
    },
  };
}

function fakeSlot(game = "ff5"): EngineSlot {
  return {
    game,
    current: () => undefined,
    ensure: () => Promise.reject(new Error("这个测试不启动引擎")),
    stop: () => undefined,
  };
}

interface CreatedServer {
  readonly ctx: Context;
  readonly created: ((payload: CreatedAgent) => Promise<unknown>)[];
}

function fakeContext(presets: PresetSelector | null): CreatedServer {
  const created: ((payload: CreatedAgent) => Promise<unknown>)[] = [];
  const ctx = {
    get: (name: string) => (name === "agentPresets" ? (presets ?? undefined) : undefined),
    on: (name: string, listener: (payload: CreatedAgent) => Promise<unknown>) => {
      if (name === "agent/created") created.push(listener);
      return () => undefined;
    },
    effect: (start: () => (() => void) | (() => Promise<void>)) => {
      start();
      return () => undefined;
    },
    systemPrompt: { context: () => () => undefined },
    subagents: {},
  } as unknown as Context;
  return { ctx, created };
}

function config(waitMs = 3000): Config {
  return Config({ game: "ff5", autoPresetWaitMs: waitMs });
}

async function created(
  detection: DetectionResult,
  presets: PresetSelector,
  source: CreatedAgent["source"] = "startup",
  origin?: "subagent",
): Promise<Logs> {
  const logs = fakeLog();
  await switchToOpenGame(presets, config(), logs.log, () => Promise.resolve(detection), {
    agent: fakeAgent(origin),
    source,
  });
  return logs;
}

void test("a fresh session with FF3 open switches FF5's agent to the FF3 player preset", async () => {
  resetPresetMounts();
  const fake = fakePresets();
  const agent = fakeAgent();
  const logs = fakeLog();
  const mounted: Agent[] = [];
  const unregister = registerPresetMount("ff3", {
    mount: (target) => mounted.push(target),
    unmount: () => undefined,
  });
  try {
    await switchToOpenGame(
      fake.service,
      config(),
      logs.log,
      () => Promise.resolve({ ok: true, running: ["ff3"] }),
      { agent, source: "startup" },
      { unmount: () => undefined },
    );
  } finally {
    unregister();
  }
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.ok(call);
  assert.equal(call.agent, agent);
  assert.equal(call.preset, "ffpr-ff3");
  assert.deepEqual(mounted, [agent]);
  assert.equal(logs.infos.length, 1);
  assert.match(logs.infos[0] ?? "", /笔记本上开着 FF3.*从 FF5\(ffpr\) 换到 ffpr-ff3/);
  assert.equal(logs.warnings.length, 0);
});

void test("the same game, no game, two games, failed detection, and timeout never switch", async () => {
  const cases: { name: string; detection: DetectionResult }[] = [
    { name: "已经是本作", detection: { ok: true, running: ["ff5"] } },
    { name: "没开", detection: { ok: true, running: [] } },
    { name: "开着两作", detection: { ok: true, running: ["ff3", "ff4"] } },
    { name: "检测失败", detection: { ok: false, error: "连不上笔记本" } },
  ];
  for (const item of cases) {
    const fake = fakePresets();
    const logs = await created(item.detection, fake.service);
    assert.equal(fake.calls.length, 0, item.name);
    assert.equal(logs.warnings.length, 0, item.name);
  }

  const fake = fakePresets();
  const logs = fakeLog();
  const startedAt = Date.now();
  await switchToOpenGame(
    fake.service,
    config(10),
    logs.log,
    (signal) =>
      new Promise<DetectionResult>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("检测超时"));
          },
          { once: true },
        );
      }),
    { agent: fakeAgent(), source: "startup" },
  );
  assert.equal(fake.calls.length, 0);
  assert.ok(Date.now() - startedAt < 1000, "超时后应该及时返回");
  assert.equal(logs.warnings.length, 0);
});

void test("resume, clear, compact, and subagent creation never switch", async () => {
  const cases: {
    name: string;
    source: CreatedAgent["source"];
    origin?: "subagent";
  }[] = [
    { name: "恢复", source: "resume" },
    { name: "清空", source: "clear" },
    { name: "压缩", source: "compact" },
    { name: "子智能体", source: "startup", origin: "subagent" },
  ];
  for (const item of cases) {
    const fake = fakePresets();
    await created({ ok: true, running: ["ff3"] }, fake.service, item.source, item.origin);
    assert.equal(fake.calls.length, 0, item.name);
  }
});

void test("a failed select is logged and the listener still resolves", async () => {
  const fake = fakePresets(new Error("会话已经开始"));
  const logs = fakeLog();
  await switchToOpenGame(
    fake.service,
    config(),
    logs.log,
    () => Promise.resolve({ ok: true, running: ["ff3"] }),
    { agent: fakeAgent(), source: "startup" },
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(logs.infos.length, 0);
  assert.equal(logs.warnings.length, 1);
  assert.match(logs.warnings[0] ?? "", /从 FF5\(ffpr\) 换到 ffpr-ff3失败.*会话已经开始/);
});

void test("installPlayer uses agentPresets from the context and switches once", async () => {
  const fake = fakePresets();
  const server = fakeContext(fake.service);
  const logs = fakeLog();
  installPlayer(server.ctx, fakeSlot(), config(), logs.log, () =>
    Promise.resolve({ ok: true, running: ["ff3"] }),
  );
  const listener = server.created.at(-1);
  assert.ok(listener, "installPlayer 应该注册换预设的 agent/created 监听");
  await listener({ agent: fakeAgentWithRegistration(), source: "startup" });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.preset, "ffpr-ff3");
});

void test("a missing agentPresets service warns but the plugin still loads", () => {
  const server = fakeContext(null);
  const logs = fakeLog();
  installPlayer(server.ctx, fakeSlot(), config(), logs.log, () =>
    Promise.resolve({ ok: true, running: ["ff3"] }),
  );
  assert.match(logs.warnings.join("\n"), /拿不到 agentPresets 服务/);
  assert.equal(server.created.length, 1, "只应保留注册工具和人格的监听");
});

interface PatchPlayer {
  readonly id: string;
  readonly game: string;
}

async function patchPlayers(): Promise<PatchPlayer[]> {
  const text = await readFile(join(import.meta.dirname, "..", "cordis.patch.yml"), "utf8");
  const lines = text.split("\n");
  const starts = lines.flatMap((line, index) =>
    line.startsWith("    - id: preset-") ? [index] : [],
  );
  const players: PatchPlayer[] = [];
  for (const [position, start] of starts.entries()) {
    const chunk = lines.slice(start, starts[position + 1] ?? lines.length);
    if (chunk.join("\n").includes("role: tactician")) continue;
    const id = chunk
      .find((line) => line.startsWith("        id: "))
      ?.slice(12)
      .trim();
    const game = chunk
      .find((line) => line.startsWith("              game: "))
      ?.slice(20)
      .trim();
    if (id === undefined || game === undefined) assert.fail("玩家预设缺少 id 或 game");
    players.push({ id, game });
  }
  return players;
}

void test("the player preset id table matches all six ids in cordis.patch.yml", async () => {
  const players = await patchPlayers();
  assert.equal(players.length, 6);
  for (const player of players) {
    assert.equal(playerPresetId(player.game), player.id, player.game);
  }
});

interface FakeTools {
  readonly names: Set<string>;
  restrictions: number;
  register(definition: { readonly name: string }): () => void;
  restrict(filter: unknown): () => void;
  guard(guard: unknown): () => void;
  schemas(): readonly { readonly name: string }[];
}

interface PreStepPayload {
  readonly agent: Agent;
  readonly step: number;
  readonly signal: AbortSignal;
}

type PreStepListener = (
  payload: PreStepPayload,
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>;

interface HarnessPlugin {
  readonly created: ((payload: CreatedAgent) => Promise<unknown>)[];
  readonly selected: ((sessionId: string, preset: string) => void)[];
  readonly preStep: PreStepListener[];
  readonly logs: Logs;
  unload(): Promise<void>;
}

interface HarnessAgent {
  readonly agent: Agent;
  readonly personas: string[];
}

interface Harness {
  readonly presets: PresetSelector;
  plugin(game: string): HarnessPlugin;
  agent(sessionId: string, initialPreset: string, origin?: "subagent"): HarnessAgent;
  tools(preset: string): Set<string>;
  restrictions(preset: string): number;
  emitSelected(sessionId: string, preset: string): void;
  runSilent<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Two player plugin instances on one fake event bus. `agent.ctx.tools` resolves like dsh's
 * scoped service: the current preset's tool layer receives the registration.
 */
function makeHarness(): Harness {
  resetPresetMounts();
  const selectedListeners: ((sessionId: string, preset: string) => void)[] = [];
  const agents = new Map<string, Agent>();
  const current = new Map<string, string>();
  const contextIds = new WeakMap<object, string>();
  const toolSets = new Map<string, FakeTools>();
  let silent = false;

  const toolsFor = (preset: string): FakeTools => {
    const existing = toolSets.get(preset);
    if (existing !== undefined) return existing;
    const names = new Set<string>();
    const service: FakeTools = {
      names,
      restrictions: 0,
      register: (definition) => {
        names.add(definition.name);
        return () => {
          names.delete(definition.name);
        };
      },
      restrict: () => {
        service.restrictions += 1;
        return () => undefined;
      },
      guard: () => () => undefined,
      schemas: () => [...names].map((name) => ({ name })),
    };
    toolSets.set(preset, service);
    return service;
  };

  const emitSelected = (sessionId: string, preset: string): void => {
    if (silent) return;
    for (const listener of [...selectedListeners]) listener(sessionId, preset);
  };

  const runSilent = async <T>(operation: () => Promise<T>): Promise<T> => {
    silent = true;
    try {
      return await operation();
    } finally {
      silent = false;
    }
  };

  const presets: PresetSelector = {
    select: (agent, preset) => {
      current.set(agent.id, preset);
      emitSelected(agent.id, preset);
      return Promise.resolve(preset);
    },
    composedPreset: (agentContext) => {
      const sessionId = contextIds.get(agentContext);
      return sessionId === undefined ? undefined : current.get(sessionId);
    },
  };

  return {
    presets,
    plugin: (game) => {
      const created: ((payload: CreatedAgent) => Promise<unknown>)[] = [];
      const selected: ((sessionId: string, preset: string) => void)[] = [];
      const preStep: PreStepListener[] = [];
      const effects: (() => void | Promise<void>)[] = [];
      const logs = fakeLog();
      const context = {
        get: (name: string) => (name === "agentPresets" ? presets : undefined),
        on: (name: string, listener: (...args: never[]) => unknown) => {
          if (name === "agent/created") {
            created.push(listener as (payload: CreatedAgent) => Promise<unknown>);
          }
          if (name === "agent-preset/selected") {
            const handler = listener as (sessionId: string, preset: string) => void;
            selected.push(handler);
            selectedListeners.push(handler);
          }
          if (name === "agent/pre-step") preStep.push(listener as PreStepListener);
          return () => undefined;
        },
        effect: (start: () => (() => void) | (() => Promise<void>)) => {
          const dispose = start();
          effects.push(dispose);
          return dispose;
        },
        systemPrompt: { context: () => () => undefined },
        subagents: {},
        agents: { get: (sessionId: string) => agents.get(sessionId) },
      } as unknown as Context;
      installPlayer(context, fakeSlot(game), Config({ game, autoPresetWaitMs: 20 }), logs.log, () =>
        Promise.resolve({ ok: true, running: ["ff5"] }),
      );
      return {
        created,
        selected,
        preStep,
        logs,
        unload: async () => {
          for (const dispose of effects.reverse()) await dispose();
        },
      };
    },
    agent: (sessionId, initialPreset, origin) => {
      const personas: string[] = [];
      const agentContext = {} as Record<string, unknown>;
      const agent = {
        id: sessionId,
        session: {
          id: sessionId,
          header: origin === undefined ? {} : { origin },
        },
        ctx: agentContext,
      } as unknown as Agent;
      contextIds.set(agentContext, sessionId);
      current.set(sessionId, initialPreset);
      agents.set(sessionId, agent);
      agentContext.effect = (start: () => (() => void) | (() => Promise<void>)) => {
        const undo = start();
        return () => Promise.resolve(undo());
      };
      Object.defineProperty(agentContext, "tools", {
        get: () => toolsFor(current.get(sessionId) ?? ""),
      });
      agentContext.systemPrompt = {
        section: (section: { readonly text: string }) => {
          personas.push(section.text);
          return () => {
            const index = personas.indexOf(section.text);
            if (index >= 0) personas.splice(index, 1);
          };
        },
        getSectionOrder: () => 0,
        suppressRuntimeContext: () => () => undefined,
      };
      return { agent, personas };
    },
    tools: (preset) => toolsFor(preset).names,
    restrictions: (preset) => toolsFor(preset).restrictions,
    emitSelected,
    runSilent,
  };
}

async function runCreated(
  plugin: HarnessPlugin,
  agent: Agent,
  switchFirst: boolean,
): Promise<void> {
  // installPlayer registers the registration listener first and the switch listener second.
  const registration = plugin.created[0];
  const switching = plugin.created[1];
  assert.ok(registration, "installPlayer 应该注册挂工具的 agent/created 监听");
  assert.ok(switching, "installPlayer 应该注册换预设的 agent/created 监听");
  const order = switchFirst ? [switching, registration] : [registration, switching];
  for (const listener of order) await listener({ agent, source: "startup" });
}

async function checkCreatedUnderFF3(switchFirst: boolean): Promise<void> {
  const harness = makeHarness();
  const ff3 = harness.plugin("ff3");
  harness.plugin("ff5");
  const { agent, personas } = harness.agent("session-1", "ffpr-ff3");
  await runCreated(ff3, agent, switchFirst);
  assert.deepEqual(personas, [buildSystemPrompt("ff5", 20, true, true)]);
  assert.equal(harness.tools("ffpr-ff3").size, 0);
  assert.ok(harness.tools("ffpr").size > 0);
}

void test("switch-first: a new FF3 session with FF5 open keeps only FF5 tools and persona", async () => {
  await checkCreatedUnderFF3(true);
});

void test("registration-first: a new FF3 session with FF5 open keeps only FF5 tools and persona", async () => {
  await checkCreatedUnderFF3(false);
});

void test("switching to an unrelated preset removes the old player's tools and persona", async () => {
  const harness = makeHarness();
  const ff3 = harness.plugin("ff3");
  harness.plugin("ff5");
  const { agent, personas } = harness.agent("session-2", "ffpr-ff3");
  const registration = ff3.created[0];
  assert.ok(registration);
  await registration({ agent, source: "startup" });
  assert.equal(personas.length, 1);

  await harness.presets.select(agent, "ffpr-tactician");
  assert.deepEqual(personas, []);
  assert.equal(harness.tools("ffpr-ff3").size, 0);
  assert.equal(harness.tools("ffpr").size, 0);
});

void test("agent/created does not mount a preset the session no longer runs", async () => {
  const harness = makeHarness();
  const ff3 = harness.plugin("ff3");
  const { agent, personas } = harness.agent("session-3", "ffpr");
  const registration = ff3.created[0];
  assert.ok(registration);
  await registration({ agent, source: "startup" });
  assert.deepEqual(personas, []);
  assert.equal(harness.tools("ffpr-ff3").size, 0);
});

void test("a preset change with no live Agent warns instead of throwing", () => {
  const harness = makeHarness();
  const ff3 = harness.plugin("ff3");
  const ff5 = harness.plugin("ff5");
  harness.emitSelected("missing-session", "ffpr");
  assert.match(ff5.logs.warnings.join("\n"), /找不到它的 Agent/);
  assert.equal(ff3.logs.warnings.length, 0);
});

async function runPreStep(plugin: HarnessPlugin, agent: Agent, step: number): Promise<void> {
  const listener = plugin.preStep[0];
  assert.ok(listener, "installPlayer 应该注册 agent/pre-step");
  await listener({ agent, step, signal: new AbortController().signal }, () =>
    Promise.resolve({ kind: "enter", messages: [] }),
  );
}

void test("agent/created switches to FF5 and mounts FF5 before any pre-step", async () => {
  const harness = makeHarness();
  const ff3 = harness.plugin("ff3");
  harness.plugin("ff5");
  const { agent, personas } = harness.agent("session-4", "ffpr-ff3");
  const registration = ff3.created[0];
  const switching = ff3.created[1];
  assert.ok(registration);
  assert.ok(switching);
  await registration({ agent, source: "startup" });
  assert.ok(harness.tools("ffpr-ff3").size > 0);

  // Real machine 11-02: select commits, but the new preset's plugin never hears the event.
  await harness.runSilent(() => switching({ agent, source: "startup" }));
  assert.equal(harness.tools("ffpr-ff3").size, 0);
  assert.deepEqual(personas, [buildSystemPrompt("ff5", 20, true, true)]);
  assert.ok(harness.tools("ffpr").size > 0);
  assert.ok(harness.restrictions("ffpr") > 0);
});

void test("a switch with no registered target warns but the session continues", async () => {
  const harness = makeHarness();
  const ff3 = harness.plugin("ff3");
  const { agent, personas } = harness.agent("session-7", "ffpr-ff3");
  const registration = ff3.created[0];
  const switching = ff3.created[1];
  assert.ok(registration);
  assert.ok(switching);
  await registration({ agent, source: "startup" });
  assert.ok(harness.tools("ffpr-ff3").size > 0);

  await harness.runSilent(() => switching({ agent, source: "startup" }));
  assert.equal(harness.tools("ffpr-ff3").size, 0);
  assert.equal(harness.tools("ffpr").size, 0);
  assert.deepEqual(personas, []);
  assert.match(ff3.logs.warnings.join("\n"), /没有登记挂载/);
});

void test("unloading an old plugin leaves a newer instance of the same game registered", async () => {
  const harness = makeHarness();
  const older = harness.plugin("ff6");
  const newer = harness.plugin("ff6");
  const { agent } = harness.agent("session-8", "ffpr-ff6");
  await older.unload();
  const mounts = presetMountFor("ff6");
  assert.ok(mounts, "同一作品新加载的那一份应该还在");
  mounts.mount(agent);
  assert.ok(harness.tools("ffpr-ff6").size > 0);
  await newer.unload();
  assert.equal(presetMountFor("ff6"), undefined);
});

void test("a session already mounted is not mounted again by pre-step", async () => {
  const harness = makeHarness();
  const ff5 = harness.plugin("ff5");
  const { agent } = harness.agent("session-5", "ffpr");
  await runPreStep(ff5, agent, 1);
  const toolCount = harness.tools("ffpr").size;
  const restrictionCount = harness.restrictions("ffpr");
  assert.ok(toolCount > 0);

  await runPreStep(ff5, agent, 2);
  assert.equal(harness.tools("ffpr").size, toolCount);
  assert.equal(harness.restrictions("ffpr"), restrictionCount);
});

void test("a subagent's pre-step does not mount player tools", async () => {
  const harness = makeHarness();
  const ff5 = harness.plugin("ff5");
  const { agent, personas } = harness.agent("session-6", "ffpr", "subagent");
  await runPreStep(ff5, agent, 1);
  assert.equal(harness.tools("ffpr").size, 0);
  assert.deepEqual(personas, []);
  assert.equal(harness.restrictions("ffpr"), 0);
});
