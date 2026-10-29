import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LinkError } from "../src/engine/bridge.ts";
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
    const result = await throughLink(link, item.op, item.fields, item.wait * 1000, SIGNAL);
    assert.deepEqual(result, item.expected);
    assert.deepEqual(
      link.calls.map((call) => ({
        method: call.method,
        op: call.op,
        ...(call.timeoutMs === undefined ? {} : { timeout: call.timeoutMs / 1000 }),
        fields: call.fields,
      })),
      // 10-27: TS presses the bridge's virtual gamepad ("via": "game"); Python, frozen, does not.
      item.op === "keys"
        ? item.calls.map((call) => ({ ...call, fields: { ...call.fields, via: "game" } }))
        : item.calls,
    );
  });
}

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

async function useFakeSsh(
  directory: string,
  responses: readonly { stdout?: string; stderr?: string; code?: number }[],
): Promise<string> {
  const config = join(directory, "fake-ssh.json");
  const log = join(directory, "ssh.log");
  await writeFile(config, JSON.stringify({ responses }), "utf8");
  await writeFile(log, "", "utf8");
  await chmod(config, 0o600);
  process.env.FAKE_SSH_CONFIG = config;
  process.env.FAKE_SSH_LOG = log;
  return log;
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
