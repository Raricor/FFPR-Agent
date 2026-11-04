import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runningGames, runningGamesScript } from "../src/engine/running.ts";
import type { Laptop } from "../src/engine/laptop.ts";

const FAKE_SSH = join(import.meta.dirname, "fake-ssh.mjs");

const LAPTOP: Laptop = {
  host: "10.0.0.2",
  user: "ffpr",
  key: "/home/dev/.ssh/ffpr_laptop_ed25519",
  root: "C:/ffpr",
  sshCommand: FAKE_SSH,
};

async function useFakeSsh(
  directory: string,
  responses: readonly { stdout?: string; stderr?: string; code?: number; delayMs?: number }[],
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

async function withFakeSsh(
  responses: readonly { stdout?: string; stderr?: string; code?: number; delayMs?: number }[],
  run: (laptop: Laptop, log: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-running-"));
  try {
    const log = await useFakeSsh(directory, responses);
    await run({ ...LAPTOP, sshCommand: FAKE_SSH }, log);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test("runningGames asks PowerShell for all six with one SSH call", async () => {
  await withFakeSsh([{ stdout: '["ff5"]\n' }], async (laptop, log) => {
    assert.deepEqual(await runningGames(laptop), ["ff5"]);
    const script = runningGamesScript(laptop);
    assert.match(script, /Import-Module 'C:\/ffpr\/deploy\/laptop\/FfprCommon\.psm1'/);
    assert.match(script, /Find-GameDir \$game/);
    assert.match(script, /Test-GameRunning \$dir/);
    assert.match(script, /Write-Output \$json/);
    assert.match(script, /ForEach-Object/);
    const calls = await readSshLog(log);
    assert.equal(calls.length, 1);
  });
});

void test("runningGames keeps ff1 … ff6 order and drops unknown keys", async () => {
  await withFakeSsh([{ stdout: '["ff5","ff9","FF3","ff1"]\n' }], async (laptop) => {
    assert.deepEqual(await runningGames(laptop), ["ff1", "ff3", "ff5"]);
  });
});

void test("an empty array means nothing is open", async () => {
  await withFakeSsh([{ stdout: "[]\n" }], async (laptop) => {
    assert.deepEqual(await runningGames(laptop), []);
  });
});

void test("bad output is a Chinese error, not an empty list", async () => {
  await withFakeSsh([{ stdout: "ff5 is running\n" }], async (laptop) => {
    await assert.rejects(runningGames(laptop), /读不了笔记本上开着的作品.*不是合法 JSON/);
  });
  await withFakeSsh([{ stdout: '{"ff5":true}\n' }], async (laptop) => {
    await assert.rejects(runningGames(laptop), /读不了笔记本上开着的作品.*不是数组/);
  });
  await withFakeSsh([{ stdout: "" }], async (laptop) => {
    await assert.rejects(runningGames(laptop), /笔记本没有输出/);
  });
});
