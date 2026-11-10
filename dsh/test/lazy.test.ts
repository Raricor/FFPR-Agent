import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { ActivityLog } from "../src/engine/activity.ts";
import type { PlayerEngine } from "../src/plugin/player.ts";
import { apply } from "../src/index.ts";
import { Config } from "../src/plugin/config.ts";
import { createEngineSlot, gameToolHost } from "../src/plugin/player.ts";
import { gameToolDefinitions } from "../src/plugin/tools.ts";
import { FakeBridge } from "./fake-bridge.ts";

const FAKE_SSH = join(import.meta.dirname, "fake-ssh.mjs");

interface FakeApply {
  readonly ctx: Context;
  readonly listeners: Map<string, ((payload: never) => unknown)[]>;
  readonly disposers: (() => void | Promise<void>)[];
  readonly commands: unknown[];
}

function fakeApplyContext(): FakeApply {
  const listeners = new Map<string, ((payload: never) => unknown)[]>();
  const disposers: (() => void | Promise<void>)[] = [];
  const commands: unknown[] = [];
  const ctx = {
    logger: () => ({ info: () => undefined, warn: () => undefined }),
    effect: (start: () => () => void | Promise<void>) => {
      const dispose = start();
      disposers.push(dispose);
      return dispose;
    },
    on: (name: string, listener: (payload: never) => unknown) => {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => undefined;
    },
    systemPrompt: { context: () => () => undefined },
    commands: {
      register: (definition: unknown) => {
        commands.push(definition);
        return () => undefined;
      },
    },
    subagents: {},
  } as unknown as Context;
  return { ctx, listeners, disposers, commands };
}

function fakeAgent(): Agent {
  const ctx = {
    effect: (start: () => () => void) => {
      start();
      return () => Promise.resolve();
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
  return { id: "agent-1", ctx } as unknown as Agent;
}

async function shadowSsh(directory: string): Promise<{ log: string; restore: () => void }> {
  const config = join(directory, "fake-ssh.json");
  const log = join(directory, "ssh.log");
  await writeFile(config, JSON.stringify({ responses: [] }), "utf8");
  await writeFile(log, "", "utf8");
  await chmod(config, 0o600);
  process.env.FAKE_SSH_CONFIG = config;
  process.env.FAKE_SSH_LOG = log;
  const ssh = join(directory, "ssh");
  const scp = join(directory, "scp");
  await writeFile(ssh, `#!/bin/sh\nexec ${process.execPath} ${FAKE_SSH} "$@"\n`, "utf8");
  await writeFile(scp, "#!/bin/sh\nexit 1\n", "utf8");
  await chmod(ssh, 0o755);
  await chmod(scp, 0o755);
  const oldPath = process.env.PATH ?? "";
  process.env.PATH = `${directory}:${oldPath}`;
  return {
    log,
    restore: () => {
      process.env.PATH = oldPath;
    },
  };
}

async function sshCalls(path: string): Promise<number> {
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).length;
}

void test("applying the player preset and creating an agent touches no laptop or bridge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-lazy-"));
  const bridge = new FakeBridge("test-token");
  await bridge.start();
  const shadow = await shadowSsh(directory);
  const server = fakeApplyContext();
  try {
    const laptopEnv = join(directory, "laptop.env");
    const secretsFile = join(directory, "secrets.env");
    await writeFile(laptopEnv, "LAPTOP_HOST=10.0.0.2\nLAPTOP_USER=ffpr\n", "utf8");
    await writeFile(secretsFile, "BRIDGE_TOKEN=test-token\n", "utf8");
    const config = Config({
      game: "ff2",
      laptopEnv,
      secretsFile,
      bridgeUrl: bridge.url,
    });

    await apply(server.ctx, config);
    assert.equal(await sshCalls(shadow.log), 0);
    assert.equal(bridge.healthCalls, 0);
    assert.equal(bridge.streamConnections, 0);
    assert.equal(bridge.queries.length, 0);

    const created = server.listeners.get("agent/created")?.[0];
    assert.ok(created);
    await created({ agent: fakeAgent() } as never);
    assert.equal(await sshCalls(shadow.log), 0);
    assert.equal(bridge.healthCalls, 0);
    assert.equal(bridge.streamConnections, 0);
  } finally {
    for (const dispose of [...server.disposers].reverse()) await dispose();
    shadow.restore();
    await bridge.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

function fakeEngine(game: string): PlayerEngine {
  const activity = new ActivityLog({ game });
  const stop = new AbortController();
  return {
    laptop: { host: "10.0.0.2", user: "ffpr", key: "", root: "C:/ffpr" },
    bridge: undefined,
    events: undefined,
    watcher: undefined,
    activity,
    game: {
      game,
      saveSlot: 20,
      notes: [],
      tacticianInfo: () => null,
      setTactician: () => undefined,
      setStageOfficer: () => undefined,
      window: () => "",
      observe: () => Promise.resolve("地图 1"),
    },
    waiter: { wait: () => Promise.resolve() },
    stop,
  } as unknown as PlayerEngine;
}

const LOG = { info: () => undefined, warn: () => undefined };

void test("the slot starts once for concurrent callers and stops the engine on unload", async () => {
  const config = Config({ game: "ff3" });
  const engine = fakeEngine("ff3");
  let starts = 0;
  const slot = createEngineSlot(config, LOG, () => {
    starts += 1;
    return Promise.resolve(engine);
  });
  assert.equal(starts, 0);
  assert.equal(slot.current(), undefined);
  const [first, second] = await Promise.all([slot.ensure(), slot.ensure()]);
  assert.equal(starts, 1);
  assert.equal(first, engine);
  assert.equal(second, engine);
  assert.equal(slot.current(), engine);
  slot.stop();
  assert.equal(engine.stop.signal.aborted, true);
  assert.equal(slot.current(), undefined);
});

void test("a failed start is retried by the next caller", async () => {
  const config = Config({ game: "ff4" });
  const engine = fakeEngine("ff4");
  let starts = 0;
  const slot = createEngineSlot(config, LOG, () => {
    starts += 1;
    if (starts === 1) return Promise.reject(new Error("第一次没启动起来"));
    return Promise.resolve(engine);
  });
  await assert.rejects(slot.ensure(), /第一次没启动起来/);
  assert.equal(slot.current(), undefined);
  assert.equal(await slot.ensure(), engine);
  assert.equal(starts, 2);
});

void test("a game tool without a started engine answers a Chinese tool error", async () => {
  const config = Config({ game: "ff5" });
  const slot = createEngineSlot(config, LOG, () => Promise.reject(new Error("不应该启动")));
  const tool = gameToolDefinitions(gameToolHost(slot), "ff5", 20).find(
    (item) => item.name === "remember",
  );
  assert.ok(tool);
  const result = await tool.execute({ note: "x" }, {
    signal: new AbortController().signal,
  } as unknown as ToolRunContext);
  assert.equal(result, "工具出错:FF5 没在运行");
});
