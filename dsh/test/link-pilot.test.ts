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
  host: "192.168.1.20",
  user: "ffpr",
  key: "/home/dev/.ssh/ffpr_laptop_ed25519",
  root: "C:/ffpr",
  desktopUser: "DOMAIN\\user",
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

void test("hold and stop go over the LAN command socket", async () => {
  const link = new FakeLink({ ok: true });
  const pilot = createPilot(laptop(), link, SIGNAL, {
    timingFile: "/dev/null",
    game: "ff5",
  });
  assert.deepEqual(await pilot.send("hold", { key: "PadL1", down: true, ms: 2500 }), {
    ok: true,
  });
  assert.deepEqual(await pilot.send("stop"), { ok: true });
  assert.deepEqual(
    link.calls.map((call) => ({ method: call.method, op: call.op, fields: call.fields })),
    [
      { method: "command", op: "hold", fields: { key: "PadL1", down: true, ms: 2500 } },
      { method: "command", op: "stop", fields: {} },
    ],
  );
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

void test("cancelling a command leaves an abort marker over a fresh SSH call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const log = await useFakeSsh(directory, [
      { delayMs: 5000, stdout: '{"ok":true}' }, // the command is still running on the laptop
      { stdout: "" }, // the separate abort write
    ]);
    const controller = new AbortController();
    const pilot = createPilot(laptop(), undefined, controller.signal, {
      timingFile: "/dev/null",
      game: "ff5",
    });
    const pending = pilot.send("story", { timeout: 600000 }, 620_000);
    await waitForSshCalls(log, 1);
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      return true;
    });
    const calls = await readSshLog(log);
    assert.equal(calls.length, 2);
    const command = calls[0];
    const abort = calls[1];
    assert.ok(command);
    assert.ok(abort);
    const cid = /(\d+)\.cmd\.json/.exec(scriptOf(command))?.[1];
    assert.ok(cid);
    assert.match(scriptOf(abort), new RegExp(`${cid}\\.abort`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a failed abort write is logged and the original cancellation still wins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    await useFakeSsh(directory, [
      { delayMs: 5000, stdout: '{"ok":true}' },
      { stderr: "写不进去", code: 1 },
    ]);
    const controller = new AbortController();
    const messages: string[] = [];
    const pilot = createPilot(laptop(), undefined, controller.signal, {
      timingFile: "/dev/null",
      game: "ff5",
      log: (message) => messages.push(message),
    });
    const pending = pilot.send("story", { timeout: 600000 }, 620_000);
    await waitForSshCalls(join(directory, "ssh.log"), 1);
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      return true;
    });
    assert.ok(messages.some((message) => message.includes("写取消标记")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("agentRunning sees a live agent.json and its status answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const log = await useFakeSsh(directory, [{ stdout: "alive" }, { stdout: "{}" }]);
    assert.equal(await agentRunning(LAPTOP, "ff5"), true);
    const calls = await readSshLog(log);
    assert.equal(calls.length, 2);
    const probe = calls[0];
    assert.ok(probe);
    assert.match(scriptOf(probe), /Get-Process -Id \$agentPid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("agentRunning treats a missing agent.json and a stale pid as not running", async () => {
  for (const answer of ["absent", "stale"]) {
    const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
    try {
      await useFakeSsh(directory, [{ stdout: answer }]);
      assert.equal(await agentRunning(LAPTOP, "ff5"), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    const log = await useFakeSsh(directory, [{ stdout: "alive" }, { stdout: "{}" }]);
    assert.equal(await ensureAgent(LAPTOP, "ff5"), false);
    assert.equal((await readSshLog(log)).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("ensureAgent starts an agent when agent.json is missing or its pid is gone", async () => {
  for (const answer of ["absent", "stale"]) {
    const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
    try {
      const log = await useFakeSsh(directory, [
        { stdout: answer }, // agentProcess
        { stdout: "" }, // startAgent clears agent.json
        { stdout: "" }, // runInSession fires the task
        { stdout: '{"state":"started"}' }, // runInSession polls the task status
        { stdout: '{"ok":true,"focused":true}' }, // startAgent's status check
      ]);
      assert.equal(await ensureAgent(LAPTOP, "ff5"), true);
      assert.equal(countStarts(await readSshLog(log)), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

void test("a busy agent with a live pid is aborted and waited for, never replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const log = await useFakeSsh(directory, [
      { stdout: "alive" }, // agentProcess
      { stderr: "等待试玩助手超时", code: 1 }, // status timed out: busy
      { stdout: "" }, // abort queued commands
      { stdout: "{}" }, // the queued status finally answers
    ]);
    assert.equal(await ensureAgent(LAPTOP, "ff5"), false);
    const calls = await readSshLog(log);
    assert.equal(calls.length, 4);
    const abort = calls[2];
    assert.ok(abort);
    assert.match(scriptOf(abort), /\.abort/);
    assert.equal(countStarts(calls), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a busy agent that still does not answer is reported without a second start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const log = await useFakeSsh(directory, [
      { stdout: "alive" },
      { stderr: "等待试玩助手超时", code: 1 },
      { stdout: "" },
      { stderr: "等待试玩助手超时", code: 1 },
    ]);
    await assert.rejects(ensureAgent(LAPTOP, "ff5"), /试玩助手正忙、没有回应/);
    assert.equal(countStarts(await readSshLog(log)), 0);
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
      { stdout: "absent" }, // agentProcess: no agent.json
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
    const calls = await readSshLog(log);
    assert.equal(countStarts(calls), 1);
    // 11-09 (task 78): agent.json may exist with a dead pid; the same SSH session must see it
    // and throw the same not-running error, so this restart path catches it.
    const send = calls[0];
    assert.ok(send);
    assert.match(scriptOf(send), /\$agentPid = \[int\]\(Get-Content \$agent/);
    assert.match(scriptOf(send), /Get-Process -Id \$agentPid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a send waits no longer when the pilot agent process exits mid-command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    // The fake replays what the script would raise after its periodic pid check; it cannot
    // run PowerShell, so the script itself is checked for that check below.
    const exited = {
      stderr:
        "试玩助手进程已经退出,命令没有完成:先等它重开或重新运行 ffpr-pilot start,不要直接重发",
      code: 1,
    };
    const log = await useFakeSsh(directory, [exited]);
    const messages: string[] = [];
    const pilot = createPilot(laptop(), undefined, SIGNAL, {
      timingFile: "/dev/null",
      game: "ff2",
      log: (message) => messages.push(message),
    });
    await assert.rejects(pilot.send("story", { timeout: 600000 }, 620_000), /试玩助手进程已经退出/);
    // A command that may have pressed half its keys must never be sent twice by itself.
    const calls = await readSshLog(log);
    assert.equal(calls.length, 1);
    assert.equal(countStarts(calls), 0);
    assert.deepEqual(messages, []);
    const send = calls[0];
    assert.ok(send);
    assert.match(scriptOf(send), /\$nextCheck = \(Get-Date\)\.AddSeconds\(5\)/);
    assert.equal(
      scriptOf(send).match(/Get-Process -Id \$agentPid/gu)?.length,
      2,
      "once before the command file is dropped, once every five seconds while waiting",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("two calls that find the agent gone share one restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  const controller = new AbortController();
  // A fresh timeout, so a slow earlier test in this file cannot leave this one already aborted.
  const timer = setTimeout(() => {
    controller.abort();
  }, 15_000);
  const signal = controller.signal;
  const pending: Promise<unknown>[] = [];
  let first: FakeSsh | undefined;
  let second: FakeSsh | undefined;
  try {
    // The first caller's status check stays in flight (delayMs) long enough for the second
    // caller to fail and join its restart.
    first = await fakeSsh(directory, "first", [
      AGENT_GONE,
      { stdout: "absent", delayMs: 1000 }, // agentProcess stays in flight for the second caller
      { stdout: "" },
      { stdout: "" },
      { stdout: '{"state":"started"}' },
      { stdout: '{"ok":true,"focused":true}' },
      { stdout: '{"ok":true,"pos":{"map":1}}' },
    ]);
    second = await fakeSsh(directory, "second", [
      AGENT_GONE,
      { stdout: '{"ok":true,"pos":{"map":2}}' },
    ]);
    const messages: string[] = [];
    const record = (message: string): number => messages.push(message);
    const one = createPilot(first.laptop, undefined, signal, {
      timingFile: "/dev/null",
      game: "ff2",
      log: record,
    });
    const two = createPilot(second.laptop, undefined, signal, {
      timingFile: "/dev/null",
      game: "ff2",
      log: record,
    });
    const firstCall = one.send("pos");
    pending.push(firstCall);
    await waitForSshCalls(first.log, 2);
    const other = two.send("pos");
    pending.push(other);
    assert.deepEqual(await firstCall, { ok: true, pos: { map: 1 } });
    assert.deepEqual(await other, { ok: true, pos: { map: 2 } });
    assert.deepEqual(messages, ["试玩助手不在，已重新启动"]);
    assert.equal(countStarts(await readSshLog(first.log)), 1);
    // The waiting caller never ran ensureAgent or startAgent of its own.
    assert.equal(countStarts(await readSshLog(second.log)), 0);
    assert.equal((await readSshLog(second.log)).length, 2);
  } finally {
    // Abort anything still in flight (including a failing wait above), wait for those promises
    // and every fake-ssh child to land, then delete the directory they run from.
    clearTimeout(timer);
    controller.abort();
    await Promise.allSettled(pending);
    await waitForFakeSshSettled([first, second]);
    await rm(directory, { recursive: true, force: true });
  }
});

void test("an ssh log line still being written is ignored until it is complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-pilot-"));
  try {
    const log = join(directory, "ssh.log");
    await writeFile(log, '{"args":["-o"],"stdin":""}\n{"args":');
    assert.deepEqual(await readSshLog(log), [{ args: ["-o"], stdin: "" }]);
    await writeFile(log, '{"args":["-o"],"stdin":""}\n{"args":["-p"],"stdin":""}\n');
    assert.equal((await readSshLog(log)).length, 2);
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
      { stdout: "absent" }, // agentProcess
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

void test("walkpath is a command whose wait outlasts the bridge's own timeout", async () => {
  const link = new FakeLink({
    ok: true,
    reason: "arrived",
    index: 2,
    steps: 2,
    pos: { map: 1, cell: [2, 0] },
    next: null,
    turns: [],
  });
  const result = await throughLink(
    link,
    "walkpath",
    {
      path: [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      timeoutMs: 60_000,
      blockedMs: 800,
      turnLead: 0.6,
    },
    65_000,
    SIGNAL,
    "FF5 玩家",
  );
  assert.deepEqual(result, {
    ok: true,
    reason: "arrived",
    index: 2,
    steps: 2,
    pos: { map: 1, cell: [2, 0] },
    next: null,
    turns: [],
  });
  assert.deepEqual(link.calls, [
    {
      method: "command",
      op: "walkpath",
      timeoutMs: 65_000,
      fields: {
        path: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        timeoutMs: 60_000,
        blockedMs: 800,
        turnLead: 0.6,
      },
    },
  ]);
});

void test("an old bridge says unknown op once; the same link is not asked again", async () => {
  const link = new FakeLink({ ok: false, error: "未知的 op:walkpath" });
  const fields = {
    path: [
      [0, 0],
      [1, 0],
    ],
    timeoutMs: 10_000,
  };
  const first = createPilot(laptop(), link, SIGNAL, { timingFile: "/dev/null", game: "ff5" });
  assert.deepEqual(await first.send("walkpath", fields), {
    ok: false,
    error: "walkpath_unsupported",
  });
  const second = createPilot(laptop(), link, SIGNAL, { timingFile: "/dev/null", game: "ff5" });
  assert.deepEqual(await second.send("walkpath", fields), {
    ok: false,
    error: "walkpath_unsupported",
  });
  assert.equal(link.calls.length, 1, "the remembered answer must not cost another round trip");
});

void test("walkpath without a LAN fails locally instead of falling back to SSH", async () => {
  const pilot = createPilot(laptop(), undefined, SIGNAL, {
    timingFile: "/dev/null",
    game: "ff5",
  });
  assert.deepEqual(
    await pilot.send("walkpath", {
      path: [
        [0, 0],
        [1, 0],
      ],
      timeoutMs: 10_000,
    }),
    { ok: false, error: "walkpath_unsupported" },
  );
});

void test("a cancelled walkpath rejects and does not report unsupported", async () => {
  class HangingLink implements PilotLink {
    command(_op: string, _fields: Fields, signal: AbortSignal): Promise<unknown> {
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(new DOMException("操作已取消", "AbortError"));
          },
          { once: true },
        );
      });
    }

    query(): Promise<unknown> {
      return Promise.resolve({});
    }
  }
  const controller = new AbortController();
  const pilot = createPilot(laptop(), new HangingLink(), controller.signal, {
    timingFile: "/dev/null",
    game: "ff5",
  });
  const pending = pilot.send(
    "walkpath",
    {
      path: [
        [0, 0],
        [1, 0],
      ],
      timeoutMs: 60_000,
    },
    65_000,
  );
  setTimeout(() => {
    controller.abort();
  }, 10);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
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
  /** start/done lines, so a test can wait for every child it launched to exit. */
  readonly track: string;
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
  const track = join(directory, `${name}.track`);
  const wrapper = join(directory, `ssh-${name}.sh`);
  await writeFile(config, JSON.stringify({ responses }), "utf8");
  await writeFile(log, "", "utf8");
  await writeFile(track, "", "utf8");
  await writeFile(
    wrapper,
    "#!/bin/sh\n" +
      `FAKE_SSH_CONFIG=${shellQuote(config)} FAKE_SSH_LOG=${shellQuote(log)} ` +
      `FAKE_SSH_TRACK=${shellQuote(track)} ` +
      `exec ${shellQuote(process.execPath)} ${shellQuote(FAKE_SSH)} "$@"\n`,
    "utf8",
  );
  await chmod(config, 0o600);
  await chmod(wrapper, 0o755);
  return { laptop: { ...LAPTOP, sshCommand: wrapper }, log, track };
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

/**
 * Wait until every fake-ssh child launched by these laptops has exited. The track file gets a
 * start line before the child does any work and a done line on the way out; a partial last line
 * is ignored until it is complete.
 */
async function waitForFakeSshSettled(laptops: readonly (FakeSsh | undefined)[]): Promise<void> {
  const deadline = Date.now() + 5000;
  const all = laptops.filter((laptop): laptop is FakeSsh => laptop !== undefined);
  while (!(await allFakeSshSettled(all))) {
    if (Date.now() > deadline) throw new Error("假 ssh 子进程没有退出");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function allFakeSshSettled(laptops: readonly FakeSsh[]): Promise<boolean> {
  for (const laptop of laptops) {
    const markers = completeLines(await readOptional(laptop.track));
    const starts = markers.filter((line) => line === "start").length;
    const dones = markers.filter((line) => line === "done").length;
    if (dones < starts) return false;
  }
  return true;
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function readSshLog(path: string): Promise<{ args: string[]; stdin: string }[]> {
  const text = await readFile(path, "utf8");
  return completeLines(text).map((line) => JSON.parse(line) as { args: string[]; stdin: string });
}

/** Ignore the last line while a writer is still appending it; the next poll sees it whole. */
function completeLines(text: string): string[] {
  const lines = text.split("\n");
  lines.pop();
  return lines.filter(Boolean);
}

async function readTiming(path: string): Promise<{ op: string; via: string; ms: number }[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { op: string; via: string; ms: number });
}
