import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Laptop } from "../src/engine/laptop.ts";
import { detectRunning, resetDetection, type DetectionResult } from "../src/plugin/detect.ts";

const FAKE_SSH = join(import.meta.dirname, "fake-ssh.mjs");

const LAPTOP: Laptop = {
  host: "10.0.0.2",
  user: "ffpr",
  key: "/home/dev/.ssh/ffpr_laptop_ed25519",
  root: "C:/ffpr",
  sshCommand: FAKE_SSH,
};

interface SshResponse {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly delayMs?: number;
}

async function fakeSsh(
  directory: string,
  responses: readonly SshResponse[],
): Promise<{ config: string; log: string }> {
  const config = join(directory, "fake-ssh.json");
  const log = join(directory, "ssh.log");
  await writeFile(config, JSON.stringify({ responses }), "utf8");
  await writeFile(log, "", "utf8");
  await chmod(config, 0o600);
  process.env.FAKE_SSH_CONFIG = config;
  process.env.FAKE_SSH_LOG = log;
  return { config, log };
}

async function sshCalls(path: string): Promise<number> {
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).length;
}

async function withDetection(
  responses: readonly SshResponse[],
  run: (detectionPath: string, log: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-detect-"));
  resetDetection();
  try {
    const { log } = await fakeSsh(directory, responses);
    await run(join(directory, "laptop.env"), log);
  } finally {
    resetDetection();
    await rm(directory, { recursive: true, force: true });
  }
}

function loader(): Promise<Laptop> {
  return Promise.resolve(LAPTOP);
}

void test("two concurrent detections share one SSH call", async () => {
  await withDetection([{ stdout: '["ff5"]\n', delayMs: 80 }], async (path, log) => {
    const config = { laptopEnv: path, detectCacheMs: 10_000 };
    const [first, second] = await Promise.all([
      detectRunning(config, undefined, loader),
      detectRunning(config, undefined, loader),
    ]);
    assert.deepEqual(first, { ok: true, running: ["ff5"] });
    assert.deepEqual(second, first);
    assert.equal(await sshCalls(log), 1);
  });
});

void test("a cancelled caller does not cancel the shared query or the other waiter", async () => {
  await withDetection([{ stdout: '["ff5"]\n', delayMs: 120 }], async (path, log) => {
    const config = { laptopEnv: path, detectCacheMs: 10_000 };
    const controller = new AbortController();
    const first = detectRunning(config, controller.signal, loader);
    const second = detectRunning(config, undefined, loader);
    setTimeout(() => {
      controller.abort(new DOMException("页面关了", "AbortError"));
    }, 20);
    await assert.rejects(first, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      return true;
    });
    assert.deepEqual(await second, { ok: true, running: ["ff5"] });
    // The shared query still finished and cached its answer for the next caller.
    assert.deepEqual(await detectRunning(config, undefined, loader), {
      ok: true,
      running: ["ff5"],
    });
    assert.equal(await sshCalls(log), 1);
  });
});

void test("the answer is cached for detectCacheMs", async () => {
  await withDetection([{ stdout: '["ff3","ff5"]\n' }], async (path, log) => {
    const config = { laptopEnv: path, detectCacheMs: 10_000 };
    assert.deepEqual(await detectRunning(config, undefined, loader), {
      ok: true,
      running: ["ff3", "ff5"],
    });
    assert.deepEqual(await detectRunning(config, undefined, loader), {
      ok: true,
      running: ["ff3", "ff5"],
    });
    assert.equal(await sshCalls(log), 1);
  });
});

void test("a zero cache asks again, and a failure is returned instead of thrown", async () => {
  await withDetection([{ stdout: '["ff5"]\n' }, { stdout: "not json\n" }], async (path, log) => {
    const config = { laptopEnv: path, detectCacheMs: 0 };
    assert.deepEqual(await detectRunning(config, undefined, loader), {
      ok: true,
      running: ["ff5"],
    });
    const failed: DetectionResult = await detectRunning(config, undefined, loader);
    if (failed.ok) assert.fail("坏输出应该失败");
    assert.match(failed.error, /查不了笔记本上开着哪一作.*不是合法 JSON/);
    assert.equal(await sshCalls(log), 2);
  });
});
