import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import { ActivityLog } from "../src/engine/activity.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import { Config } from "../src/plugin/config.ts";
import { installPlayer, type PlayerEngine, type PlayerLog } from "../src/plugin/player.ts";
import type { EngineSlot } from "../src/plugin/registry.ts";
import type { DetectionResult } from "../src/plugin/detect.ts";

const FAKE_SSH = join(import.meta.dirname, "fake-ssh.mjs");
const LOG: PlayerLog = { info: () => undefined, warn: () => undefined };

interface PreStepPayload {
  readonly agent: Agent;
  readonly step: number;
  readonly signal: AbortSignal;
}

interface Server {
  readonly ctx: Context;
  readonly preStep: (
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ) => Promise<PreStepDecision>;
}

function fakeContext(): Server {
  const listeners: ((
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ) => Promise<PreStepDecision>)[] = [];
  const ctx = {
    effect: (start: () => (() => void) | (() => Promise<void>)) => {
      start();
      return () => undefined;
    },
    on: (
      name: string,
      listener: (
        payload: PreStepPayload,
        next: () => Promise<PreStepDecision>,
      ) => Promise<PreStepDecision>,
    ) => {
      if (name === "agent/pre-step") listeners.push(listener);
      return () => undefined;
    },
    systemPrompt: { context: () => () => undefined },
    subagents: {},
  } as unknown as Context;
  return {
    ctx,
    preStep: (payload, next) => {
      const listener = listeners[0];
      assert.ok(listener, "installPlayer 应该注册 agent/pre-step");
      return listener(payload, next);
    },
  };
}

function fakeAgent(): Agent {
  const ctx = {
    effect: (start: () => (() => void) | (() => Promise<void>)) => {
      start();
      return () => undefined;
    },
    tools: {
      register: () => () => undefined,
      restrict: () => () => undefined,
    },
    systemPrompt: {
      section: () => () => undefined,
      getSectionOrder: () => 0,
      suppressRuntimeContext: () => () => undefined,
    },
  };
  return { id: "agent-1", session: { header: {} }, ctx } as unknown as Agent;
}

function fakeLaptop(): Laptop {
  return {
    host: "10.0.0.2",
    user: "ffpr",
    key: "/home/dev/.ssh/ffpr_laptop_ed25519",
    root: "C:/ffpr",
    sshCommand: FAKE_SSH,
  };
}

function fakeEngine(game: string, connected?: boolean): PlayerEngine {
  return {
    laptop: fakeLaptop(),
    bridge: undefined,
    events: undefined,
    watcher:
      connected === undefined ? undefined : ({ connected } as unknown as PlayerEngine["watcher"]),
    activity: new ActivityLog({ game }),
    game: {
      game,
      saveSlot: 20,
      notes: [],
      tacticianInfo: () => null,
      setTactician: () => undefined,
      window: () => "",
      observe: () => Promise.resolve("地图 1 · 格子 1,1"),
    },
    waiter: { wait: () => Promise.resolve() },
    stop: new AbortController(),
  } as unknown as PlayerEngine;
}

interface FakeSlot extends EngineSlot {
  readonly starts: number;
}

function fakeSlot(game: string, engine: PlayerEngine, started = false): FakeSlot {
  let current = started ? engine : undefined;
  let starts = 0;
  return {
    game,
    get starts() {
      return starts;
    },
    current: () => current,
    ensure: () => {
      starts += 1;
      current = engine;
      return Promise.resolve(engine);
    },
    stop: () => undefined,
  };
}

async function step(
  game: string,
  detection: DetectionResult,
  slot?: EngineSlot,
): Promise<{ decision: PreStepDecision; slot: FakeSlot }> {
  const server = fakeContext();
  const engine = fakeEngine(game);
  const used = slot ?? fakeSlot(game, engine);
  installPlayer(server.ctx, used, Config({ game }), LOG, () => Promise.resolve(detection));
  const decision = await server.preStep(
    { agent: fakeAgent(), step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: "enter", messages: [] }),
  );
  if (!(used instanceof Object) || !("starts" in used)) assert.fail("测试槽没有 starts");
  return { decision, slot: used as FakeSlot };
}

function messageOf(decision: PreStepDecision): {
  readonly text: string;
  readonly kind: string;
} {
  if (decision.kind !== "enter") assert.fail("这一步应该进入");
  const [message] = decision.messages;
  assert.ok(message, "应该有一条消息");
  const [content] = message.content;
  if (content?.type !== "text") assert.fail("消息应该是文字");
  return { text: content.text, kind: message.source.kind };
}

async function withFakeSsh(run: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pre-step-"));
  try {
    const config = join(directory, "fake-ssh.json");
    await writeFile(
      config,
      JSON.stringify({ responses: [{ stdout: "alive" }], default: { stdout: '{"ok":true}\n' } }),
      "utf8",
    );
    await chmod(config, 0o600);
    process.env.FAKE_SSH_CONFIG = config;
    process.env.FAKE_SSH_LOG = join(directory, "ssh.log");
    await run();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test("the laptop runs this preset's game: start it and add the opening", async () => {
  await withFakeSsh(async () => {
    const { decision, slot } = await step("ff5", { ok: true, running: ["ff5"] });
    assert.equal(slot.starts, 1);
    const message = messageOf(decision);
    assert.equal(message.kind, "ffpr-opening");
    assert.match(message.text, /^开始。当前状态:\n地图 1 · 格子 1,1/);
  });
});

void test("no game is open: no engine, and say to start FF5 first", async () => {
  const { decision, slot } = await step("ff5", { ok: true, running: [] });
  assert.equal(slot.starts, 0);
  const message = messageOf(decision);
  assert.equal(message.kind, "ffpr-notice");
  assert.match(message.text, /笔记本上没有游戏在运行，这个会话玩的是 FF5。/);
  assert.match(message.text, /先在笔记本上启动 FF5/);
  assert.match(message.text, /这一轮不要调用游戏工具/);
  assert.equal(message.text.includes("开始。当前状态:"), false);
});

void test("another game is open: no engine, name it and suggest its session", async () => {
  const { decision, slot } = await step("ff5", { ok: true, running: ["ff3"] });
  assert.equal(slot.starts, 0);
  const message = messageOf(decision);
  assert.equal(message.kind, "ffpr-notice");
  assert.match(message.text, /笔记本上开着的是 FF3，这个会话玩的是 FF5。/);
  assert.match(message.text, /新建一个「FF3 玩家」会话/);
  assert.match(message.text, /关掉 FF3、开 FF5/);
});

void test("two games are open: no engine, explain one at a time", async () => {
  const { decision, slot } = await step("ff5", { ok: true, running: ["ff3", "ff5"] });
  assert.equal(slot.starts, 0);
  const message = messageOf(decision);
  assert.equal(message.kind, "ffpr-notice");
  assert.match(message.text, /笔记本上开着 FF3、FF5，这个会话玩的是 FF5。一次只开一作。/);
  assert.match(message.text, /只留 FF5/);
});

void test("detection failure: no engine, tell the user what to check", async () => {
  const { decision, slot } = await step("ff5", {
    ok: false,
    error: "查不了笔记本上开着哪一作:连不上",
  });
  assert.equal(slot.starts, 0);
  const message = messageOf(decision);
  assert.equal(message.kind, "ffpr-notice");
  assert.match(message.text, /查不到笔记本上开着哪一作（原因：/);
  assert.match(message.text, /连不上/);
  assert.match(message.text, /先确认笔记本开着、连得上/);
});

void test("a later step with no started engine neither starts one nor adds a message", async () => {
  const server = fakeContext();
  const used = fakeSlot("ff5", fakeEngine("ff5"));
  installPlayer(server.ctx, used, Config({ game: "ff5" }), LOG, () =>
    Promise.resolve({ ok: true, running: ["ff5"] }),
  );
  const decision = await server.preStep(
    { agent: fakeAgent(), step: 2, signal: new AbortController().signal },
    () => Promise.resolve({ kind: "enter", messages: [] }),
  );
  assert.deepEqual(decision, { kind: "enter", messages: [] });
  assert.equal(used.starts, 0);
});

void test("detection failed but the bridge is connected: warn and keep the opening", async () => {
  await withFakeSsh(async () => {
    const warnings: string[] = [];
    const server = fakeContext();
    const engine = fakeEngine("ff5", true);
    const used = fakeSlot("ff5", engine, true);
    installPlayer(
      server.ctx,
      used,
      Config({ game: "ff5" }),
      {
        info: () => undefined,
        warn: (message) => warnings.push(message),
      },
      () => Promise.resolve({ ok: false, error: "连不上笔记本" }),
    );
    const decision = await server.preStep(
      { agent: fakeAgent(), step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: "enter", messages: [] }),
    );
    const message = messageOf(decision);
    assert.equal(message.kind, "ffpr-opening");
    assert.match(message.text, /^开始。当前状态:/);
    assert.equal(used.starts, 1); // already started: ensure only returns it
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /检测笔记本上开着的作品失败.*连不上笔记本/);
  });
});

void test("detection failed and the bridge is down: still add the notice", async () => {
  const server = fakeContext();
  const engine = fakeEngine("ff5", false);
  const used = fakeSlot("ff5", engine, true);
  let warnings = 0;
  installPlayer(
    server.ctx,
    used,
    Config({ game: "ff5" }),
    {
      info: () => undefined,
      warn: () => (warnings += 1),
    },
    () => Promise.resolve({ ok: false, error: "连不上笔记本" }),
  );
  const decision = await server.preStep(
    { agent: fakeAgent(), step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: "enter", messages: [] }),
  );
  const message = messageOf(decision);
  assert.equal(message.kind, "ffpr-notice");
  assert.match(message.text, /查不到笔记本上开着哪一作/);
  assert.equal(used.starts, 0);
  assert.equal(warnings, 0);
});
