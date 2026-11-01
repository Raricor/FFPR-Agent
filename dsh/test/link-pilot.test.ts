import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LinkError } from "../src/engine/bridge.ts";
import { CalledProcessError } from "../src/engine/laptop.ts";
import {
  agentDir,
  agentRunning,
  createPilot,
  ensureAgent,
  startAgent,
  throughLink,
  type PilotLink,
} from "../src/engine/link-pilot.ts";
import type { Laptop } from "../src/engine/laptop.ts";
import type { Fields } from "../src/engine/pilot.ts";

interface LinkCase {
  readonly name: string;
  readonly op: string;
  readonly fields: Fields;
  readonly wait: number;
  readonly reply: unknown;
  readonly calls: readonly {
    readonly method: "command" | "query";
    readonly op: string;
    readonly timeout?: number;
    readonly fields: Fields;
  }[];
  readonly expected: Record<string, unknown>;
}

const cases = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "link-pilot.json"), "utf8"),
) as LinkCase[];

const SIGNAL = AbortSignal.timeout(15_000);
const FAKE_SSH = join(import.meta.dirname, "fake-ssh.mjs");
const LAPTOP: Laptop = {
  host: "192.168.8.230",
  user: "ffpr",
  key: "/home/dev/.ssh/ffpr_laptop_ed25519",
  root: "C:/ffpr",
  desktopUser: "MIFEITECH\\yangwt",
  sshCommand: FAKE_SSH,
};

/** Fresh identity per test, so the per-laptop link rest from one test cannot leak into another. */
function laptop(): Laptop {
  return { ...LAPTOP };
}

interface Call {
  readonly method: "command" | "query";
  readonly op: string;
  readonly fields: Fields;
  readonly timeoutMs?: number;
}

class FakeLink implements PilotLink {
  readonly calls: Call[] = [];
  reply: unknown;
  failures = 0;

  constructor(reply: unknown) {
    this.reply = reply;
  }

  command(op: string, fields: Fields, signal: AbortSignal, timeoutMs?: number): Promise<unknown> {
    signal.throwIfAborted();
    this.calls.push({ method: "command", op, fields, timeoutMs });
    this.throwIfFailing();
    return Promise.resolve(this.reply);
  }

  query(op: string, fields: Fields, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    this.calls.push({ method: "query", op, fields });
    this.throwIfFailing();
    return Promise.resolve(this.reply);
  }

  private throwIfFailing(): void {
    if (this.failures <= 0) return;
    this.failures -= 1;
    throw new LinkError("连不上 ws://192.0.2.1:47800/v1/query:测试");
  }
}

for (const item of cases) {
  void test(`throughLink matches Python: ${item.name}`, async () => {
    const link = new FakeLink(item.reply);
    const result = await throughLink(
      link,
      item.op,
      item.fields,
      item.wait * 1000,
      SIGNAL,
      "FF5 玩家",
    );
    assert.deepEqual(result, item.expected);
    assert.deepEqual(
      link.calls.map((call) => ({
        method: call.method,
        op: call.op,
        ...(call.timeoutMs === undefined ? {} : { timeout: call.timeoutMs / 1000 }),
        fields: call.fields,
      })),
      // 10-27: TS presses the bridge's virtual gamepad ("via": "game"); Python, frozen, does not.
      // 0.12.0 also names the sender in "from"; the old bridge ignores it.
      item.op === "keys"
        ? item.calls.map((call) => ({
            ...call,
            fields: { ...call.fields, via: "game", from: "FF5 玩家" },
          }))
        : item.calls,
    );
  });
}

void test("keys commands say who pressed the keys", async () => {
  const link = new FakeLink({ ok: true, sent: 1 });
  const pilot = createPilot(laptop(), link, SIGNAL, {
    timingFile: "/dev/null",
    game: "ff3",
  });
  assert.deepEqual(await pilot.send("keys", { keys: ["Enter"] }), { ok: true, sent: 1 });
  const call = link.calls[0];
  assert.ok(call);
  assert.equal(call.op, "keys");
  assert.equal(call.fields.from, "FF3 玩家");
});

void test("agentDir keeps FF5's path and gives each new game its own", () => {
  assert.equal(agentDir(LAPTOP, "ff5"), "C:/ffpr/session/pilot");
  assert.equal(agentDir(LAPTOP, "FF6"), "C:/ffpr/session/pilot-ff6");
  assert.equal(agentDir(LAPTOP, "ff1"), "C:/ffpr/session/pilot-ff1");
});

void test("createPilot asks the bridge over the LAN link and records the time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const link = new FakeLink({ ok: true, pos: { map: 238 } });
    const pilot = createPilot(laptop(), link, SIGNAL, {
      timingFile: join(directory, "timing.jsonl"),
      game: "ff5",
    });
    assert.deepEqual(await pilot.send("pos"), { ok: true, pos: { map: 238 } });
    assert.equal(link.calls[0]?.method, "query");
    const [line] = await readTiming(join(directory, "timing.jsonl"));
    assert.ok(line);
    assert.equal(line.op, "pos");
    assert.equal(line.via, "lan");
    assert.equal(typeof line.ms, "number");
    // An instant fake answer takes well under a second; ms is milliseconds, not microseconds.
    assert.ok(line.ms < 1000, `ms was ${String(line.ms)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("createPilot falls back to SSH and rests the link after a LinkError", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const timing = join(directory, "timing.jsonl");
    const link = new FakeLink({ ok: true, pos: { map: 1 } });
    link.failures = 1;
    const log = await useFakeSsh(directory, [
      { stdout: '{"ok":true,"pos":{"map":2}}' },
      { stdout: '{"ok":true,"pos":{"map":3}}' },
    ]);
    const machine = laptop();
    const first = createPilot(machine, link, SIGNAL, { timingFile: timing, game: "ff5" });
    assert.deepEqual(await first.send("pos"), { ok: true, pos: { map: 2 } });
    // Each tool call gets its own Pilot; the 30 second rest is shared per laptop.
    const second = createPilot(machine, link, SIGNAL, { timingFile: timing, game: "ff5" });
    assert.deepEqual(await second.send("pos"), { ok: true, pos: { map: 3 } });
    assert.equal(link.calls.length, 1, "the second call must skip the resting link");
    assert.equal((await readSshLog(log)).length, 2);
    const lines = await readTiming(timing);
    assert.deepEqual(
      lines.map((line) => line.via),
      ["ssh", "ssh"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("FFPR_LINK=off sends everything over SSH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const link = new FakeLink({ ok: true, pos: { map: 1 } });
    await useFakeSsh(directory, [{ stdout: '{"ok":true,"pos":{"map":2}}' }]);
    const pilot = createPilot(laptop(), link, SIGNAL, {
      timingFile: join(directory, "timing.jsonl"),
      env: { FFPR_LINK: "off" },
      game: "ff5",
    });
    assert.deepEqual(await pilot.send("pos"), { ok: true, pos: { map: 2 } });
    assert.equal(link.calls.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("pilot.query passes the bridge reply through and defaults to {}", async () => {
  const link = new FakeLink({ ok: true, pos: { map: 238 } });
  const pilot = createPilot(laptop(), link, SIGNAL, { timingFile: "/dev/null", game: "ff5" });
  assert.deepEqual(await pilot.query("pos"), { ok: true, pos: { map: 238 } });
  link.reply = {};
  assert.deepEqual(await pilot.query("pos"), {});
  assert.deepEqual(link.calls[0]?.fields, {});
});

void test("pilot.sleep ends when the tool call's signal aborts", async () => {
  const controller = new AbortController();
  const pilot = createPilot(laptop(), undefined, controller.signal, {
    timingFile: "/dev/null",
    game: "ff5",
  });
  const pending = pilot.sleep(10_000);
  setTimeout(() => {
    controller.abort();
  }, 20);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
});

void test("agentRunning is true when SSH answers and false on a nonzero exit", async () => {
  const first = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    await useFakeSsh(first, [{ stdout: "{}" }]);
    assert.equal(await agentRunning(LAPTOP, "ff5"), true);
  } finally {
    await rm(first, { recursive: true, force: true });
  }
  const second = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    await useFakeSsh(second, [{ stdout: "", stderr: "", code: 1 }]);
    assert.equal(await agentRunning(LAPTOP, "ff5"), false);
  } finally {
    await rm(second, { recursive: true, force: true });
  }
});

void test("startAgent waits until the agent answers status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const log = await useFakeSsh(directory, [
      { stdout: "" },
      { stdout: "" },
      { stdout: '{"state":"started"}' },
      { stdout: '{"ok":true,"focused":true}' },
    ]);
    const status = await startAgent(LAPTOP, "ff5");
    assert.equal(status.focused, true);
    assert.equal((await readSshLog(log)).length, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("ensureAgent leaves a running agent alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const log = await useFakeSsh(directory, [{ stdout: "{}" }]);
    assert.equal(await ensureAgent(LAPTOP, "ff5"), false);
    assert.equal((await readSshLog(log)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const AGENT_GONE = { stderr: "试玩助手没有运行:先运行 ffpr-pilot start", code: 1 };

void test("a send that finds the agent gone restarts it once and retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const log = await useFakeSsh(directory, [
      AGENT_GONE, // the send itself
      AGENT_GONE, // ensureAgent's status check
      { stdout: "" }, // startAgent clears agent.json
      { stdout: "" }, // runInSession fires the task
      { stdout: '{"state":"started"}' }, // runInSession polls the task status
      { stdout: '{"ok":true,"focused":true}' }, // startAgent's status check
      { stdout: '{"ok":true,"pos":{"map":2}}' }, // the one retry
    ]);
    const messages: string[] = [];
    const pilot = createPilot(laptop(), undefined, SIGNAL, {
      timingFile: join(directory, "timing.jsonl"),
      game: "ff1",
      log: (message) => messages.push(message),
    });
    assert.deepEqual(await pilot.send("pos"), { ok: true, pos: { map: 2 } });
    assert.deepEqual(messages, ["试玩助手不在，已重新启动"]);
    assert.equal(countStarts(await readSshLog(log)), 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("two calls that find the agent gone share one restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    // The first caller's status check stays in flight (delayMs) long enough for the second
    // caller to fail and join its restart.
    const first = await fakeSsh(directory, "first", [
      AGENT_GONE,
      { ...AGENT_GONE, delayMs: 1000 },
      { stdout: "" },
      { stdout: "" },
      { stdout: '{"state":"started"}' },
      { stdout: '{"ok":true,"focused":true}' },
      { stdout: '{"ok":true,"pos":{"map":1}}' },
    ]);
    const second = await fakeSsh(directory, "second", [
      AGENT_GONE,
      { stdout: '{"ok":true,"pos":{"map":2}}' },
    ]);
    const messages: string[] = [];
    const record = (message: string): number => messages.push(message);
    const one = createPilot(first.laptop, undefined, SIGNAL, {
      timingFile: "/dev/null",
      game: "ff2",
      log: record,
    });
    const two = createPilot(second.laptop, undefined, SIGNAL, {
      timingFile: "/dev/null",
      game: "ff2",
      log: record,
    });
    const pending = one.send("pos");
    await waitForSshCalls(first.log, 2);
    const other = two.send("pos");
    assert.deepEqual(await pending, { ok: true, pos: { map: 1 } });
    assert.deepEqual(await other, { ok: true, pos: { map: 2 } });
    assert.deepEqual(messages, ["试玩助手不在，已重新启动"]);
    assert.equal(countStarts(await readSshLog(first.log)), 1);
    // The waiting caller never ran ensureAgent or startAgent of its own.
    assert.equal(countStarts(await readSshLog(second.log)), 0);
    assert.equal((await readSshLog(second.log)).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a timeout is reported without restarting the agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const log = await useFakeSsh(directory, [{ stderr: "等待试玩助手超时", code: 1 }]);
    const messages: string[] = [];
    const pilot = createPilot(laptop(), undefined, SIGNAL, {
      timingFile: "/dev/null",
      game: "ff3",
      log: (message) => messages.push(message),
    });
    await assert.rejects(pilot.send("pos"), (error: unknown) => {
      assert.ok(error instanceof CalledProcessError);
      assert.match(error.message, /等待试玩助手超时/);
      return true;
    });
    assert.deepEqual(messages, []);
    assert.equal((await readSshLog(log)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a retry that fails again is reported without another restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const log = await useFakeSsh(directory, [
      AGENT_GONE,
      AGENT_GONE,
      { stdout: "" },
      { stdout: "" },
      { stdout: '{"state":"started"}' },
      { stdout: '{"ok":true,"focused":true}' },
      AGENT_GONE,
    ]);
    const pilot = createPilot(laptop(), undefined, SIGNAL, {
      timingFile: "/dev/null",
      game: "ff4",
    });
    await assert.rejects(pilot.send("pos"), /试玩助手没有运行/);
    const calls = await readSshLog(log);
    assert.equal(calls.length, 7);
    assert.equal(countStarts(calls), 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function useFakeSsh(directory: string, responses: readonly SshResponse[]): Promise<string> {
  const config = join(directory, "fake-ssh.json");
  const log = join(directory, "ssh.log");
  await writeFile(config, JSON.stringify({ responses }), "utf8");
  await writeFile(log, "", "utf8");
  await chmod(config, 0o600);
  process.env.FAKE_SSH_CONFIG = config;
  process.env.FAKE_SSH_LOG = log;
  return log;
}

interface SshResponse {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly delayMs?: number;
}

interface FakeSsh {
  readonly laptop: Laptop;
  readonly log: string;
}

/**
 * A laptop whose ssh is fake-ssh with its own config. Two of them run side by side without
 * sharing the process-wide FAKE_SSH_* variables, which a concurrency test needs.
 */
async function fakeSsh(
  directory: string,
  name: string,
  responses: readonly SshResponse[],
): Promise<FakeSsh> {
  const config = join(directory, `${name}.json`);
  const log = join(directory, `${name}.log`);
  const wrapper = join(directory, `ssh-${name}.sh`);
  await writeFile(config, JSON.stringify({ responses }), "utf8");
  await writeFile(log, "", "utf8");
  await writeFile(
    wrapper,
    "#!/bin/sh\n" +
      `FAKE_SSH_CONFIG=${shellQuote(config)} FAKE_SSH_LOG=${shellQuote(log)} ` +
      `exec ${shellQuote(process.execPath)} ${shellQuote(FAKE_SSH)} "$@"\n`,
    "utf8",
  );
  await chmod(config, 0o600);
  await chmod(wrapper, 0o755);
  return { laptop: { ...LAPTOP, sshCommand: wrapper }, log };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitForSshCalls(path: string, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while ((await readSshLog(path)).length < count) {
    if (Date.now() > deadline) throw new Error(`${path} 没有出现 ${count} 次 SSH 调用`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** How many times the scheduled-task request was fired: one restart, or none. */
function countStarts(calls: readonly { args: string[] }[]): number {
  return calls.filter((call) => scriptOf(call).includes("schtasks.exe /run /tn")).length;
}

function scriptOf(call: { args: string[] }): string {
  const index = call.args.indexOf("-EncodedCommand");
  const encoded = index < 0 ? undefined : call.args[index + 1];
  return encoded === undefined ? "" : Buffer.from(encoded, "base64").toString("utf16le");
}

async function readSshLog(path: string): Promise<{ args: string[]; stdin: string }[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; stdin: string });
}

async function readTiming(path: string): Promise<{ op: string; via: string; ms: number }[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { op: string; via: string; ms: number });
}
