/**
 * Talk to the pilot agent on the laptop (deploy/laptop/pilot-agent.ps1), ported from
 * ffpr_agent/pilot.py: one command file in, one result file out, one SSH round trip each. The
 * agent presses keys only while the game window is in front.
 *
 * When the LAN link to the bridge is available, `send` answers state reads and plain key presses
 * over it in milliseconds rather than about a second; the pilot agent keeps the rest (walk,
 * battle, story, screenshots, focus). If the link fails, the call falls back to SSH and the link
 * rests for a while. Every call's time goes to TIMING.
 *
 * A Pilot is bound to one tool call's signal: its sends, sleeps and SSH children stop together.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LinkError } from "./bridge.ts";
import {
  CalledProcessError,
  psQuote,
  runInSession,
  runPs,
  runScp,
  sessionRequest,
} from "./laptop.ts";
import type { Laptop } from "./laptop.ts";
import { DEPS } from "./paths.ts";
import type { Fields, Pilot, Reply } from "./pilot.ts";
import { isRecord, pyRound, record, text, truthy } from "./values.ts";

export const PILOT = join(DEPS, "pilot");
export const SHOTS = join(PILOT, "shots");
export const TIMING = join(PILOT, "timing.jsonl");

/** Pilot ops that are plain bridge queries (and plain key presses), so the link can answer them. */
export const LINK_OPS = new Set([
  "pos",
  "cells",
  "entities",
  "collision",
  "route",
  "bridge",
  "keys",
  "status",
]);
export const LINK_REST_SECONDS = 30;
const DEFAULT_WAIT_MS = 30_000;

/** Rest state is per laptop, not per tool call: Python keeps it in a module-level dict. */
const LINK_REST_UNTIL = new WeakMap<object, number>();

export interface PilotLink {
  command(op: string, fields: Fields, signal: AbortSignal, timeoutMs?: number): Promise<unknown>;
  query(op: string, fields: Fields, signal: AbortSignal): Promise<unknown>;
}

export interface PilotOptions {
  /** Test seams; production uses TIMING under .deps and the process environment. */
  timingFile?: string;
  env?: NodeJS.ProcessEnv;
}

export function agentDir(laptop: Laptop): string {
  return `${laptop.root}/session/pilot`;
}

/**
 * Bind the laptop and LAN link to one tool call. A link failure puts the link to rest for 30
 * seconds; later sends go straight to SSH without paying the connection timeout again.
 */
export function createPilot(
  laptop: Laptop,
  link: PilotLink | undefined,
  signal: AbortSignal,
  options: PilotOptions = {},
): Pilot {
  const timingFile = options.timingFile ?? TIMING;
  const env = options.env ?? process.env;

  const send = async (
    op: string,
    fields: Fields = {},
    waitMs = DEFAULT_WAIT_MS,
  ): Promise<Reply> => {
    const started = performance.now();
    let result: Reply | undefined;
    let via = "ssh";
    const canUseLink =
      link !== undefined &&
      env.FFPR_LINK !== "off" &&
      performance.now() >= (LINK_REST_UNTIL.get(laptop) ?? 0) &&
      LINK_OPS.has(op) &&
      !truthy(fields.shot);
    if (canUseLink) {
      try {
        result = await throughLink(link, op, fields, waitMs, signal);
        via = "lan";
      } catch (error) {
        if (!(error instanceof LinkError)) throw error;
        LINK_REST_UNTIL.set(laptop, performance.now() + LINK_REST_SECONDS * 1000);
      }
    }
    result ??= await sendSsh(laptop, op, waitMs, fields, signal);
    await recordTime(timingFile, op, via, started);
    return result;
  };

  return {
    send,
    query: async (q, fields = {}) => record((await send("bridge", { q, ...fields })).reply),
    runPs: async (script) => (await runPs(laptop, script, { capture: true, signal })).stdout,
    sleep: (ms) => sleep(ms, signal),
    now: () => performance.now(),
  };
}

/** A pilot op answered by the bridge, in the shape the pilot agent would return. */
export async function throughLink(
  link: PilotLink,
  op: string,
  fields: Fields,
  waitMs: number,
  signal: AbortSignal,
): Promise<Reply> {
  if (op === "keys") {
    // via "game": the bridge presses a virtual gamepad inside the game, so the window can stay
    // in the background (bridge 0.9.0; older bridges ignore the field and use SendInput).
    const reply = await link.command(
      "keys",
      { keys: fields.keys, gap: "gap" in fields ? fields.gap : 120, via: "game" },
      signal,
      waitMs,
    );
    return pick(asReply(reply), ["ok", "sent", "error"]);
  }
  if (op === "status") {
    // The bridge's key thread checks the foreground the same way; it answering at all means the
    // game is running.
    const reply = await link.command("status", {}, signal, waitMs);
    const kept = pick(asReply(reply), [
      "ok",
      "focused",
      "locked",
      "foreground",
      "gameButtons",
      "error",
    ]);
    return { running: true, ...kept };
  }
  if (op === "bridge") {
    const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "q"));
    const q = fields.q;
    if (typeof q !== "string") throw new Error("bridge 查询缺少 q");
    const reply = asReply(await link.query(q, rest, signal));
    if (!truthy(reply.ok)) {
      return { ok: false, error: `bridge_error:${pythonText(reply.error)}` };
    }
    return { ok: true, reply };
  }
  const defaults: Record<string, Fields> = { cells: { r: 8 }, entities: { max: 200 } };
  const merged = { ...defaults[op], ...fields };
  const reply = asReply(await link.query(op, merged, signal));
  if (!truthy(reply.ok)) {
    return { ok: false, error: `bridge_error:${pythonText(reply.error)}` };
  }
  return { ok: true, [op]: reply[op] === undefined ? null : reply[op] };
}

/** Drop a command file for the agent and wait for its result, in one SSH round trip. */
export async function sendSsh(
  laptop: Laptop,
  op: string,
  waitMs = DEFAULT_WAIT_MS,
  fields: Fields = {},
  signal?: AbortSignal,
): Promise<Reply> {
  const cid = process.hrtime.bigint().toString();
  const body = JSON.stringify({ op, ...fields });
  const script =
    `$dir = ${psQuote(agentDir(laptop))}\n` +
    "if (-not (Test-Path (Join-Path $dir 'agent.json'))) {" +
    " throw '试玩助手没有运行:先运行 ffpr-pilot start' }\n" +
    `$tmp = Join-Path $dir '${cid}.tmp'\n` +
    "$utf8 = New-Object Text.UTF8Encoding $false\n" +
    `[IO.File]::WriteAllText($tmp, ${psQuote(body)}, $utf8)\n` +
    `Move-Item $tmp (Join-Path $dir '${cid}.cmd.json')\n` +
    `$res = Join-Path $dir '${cid}.result.json'\n` +
    `$deadline = (Get-Date).AddSeconds(${waitMs / 1000})\n` +
    "while (-not (Test-Path $res)) {\n" +
    "  if ((Get-Date) -gt $deadline) { throw '等待试玩助手超时' }\n" +
    "  Start-Sleep -Milliseconds 25\n" +
    "}\n" +
    "Get-Content $res -Raw -Encoding UTF8\n" +
    "Remove-Item $res -Force";
  const out = (await runPs(laptop, script, { capture: true, signal })).stdout.trim();
  const parsed: unknown = JSON.parse(out);
  if (!isRecord(parsed)) throw new Error("试玩助手的回复不是 JSON 对象");
  return parsed;
}

/** Copy a screenshot the agent left on the laptop to .deps/pilot/shots. */
export async function fetchShot(
  laptop: Laptop,
  result: Reply,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!truthy(result.shot)) return null;
  await mkdir(SHOTS, { recursive: true });
  const id = text(result.id) ?? String(result.id);
  const local = join(SHOTS, `${id}.png`);
  const remote = `${laptop.user}@${laptop.host}:${agentDir(laptop)}/${id}.png`;
  await runScp(laptop, remote, local, { signal });
  return local;
}

/**
 * Start pilot-agent.ps1 on the desktop (hidden) and wait until it answers; returns its status.
 * `keepAwake` asks Windows to keep the display on while it runs (opt-in).
 */
export async function startAgent(
  laptop: Laptop,
  game: string,
  idle = 30,
  keepAwake = false,
  signal?: AbortSignal,
): Promise<Reply> {
  await runPs(
    laptop,
    `$dir = ${psQuote(agentDir(laptop))}\n` +
      "New-Item -ItemType Directory -Force $dir | Out-Null\n" +
      // Not -ErrorAction SilentlyContinue: a failed last statement makes powershell exit 1.
      "$agent = Join-Path $dir 'agent.json'\n" +
      "if (Test-Path $agent) { Remove-Item $agent -Force }",
    { signal },
  );
  const script = `${laptop.root}/deploy/laptop/pilot-agent.ps1`;
  const command = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden"];
  command.push("-File", script, "-Game", game, "-IdleMinutes", String(idle));
  if (keepAwake) command.push("-KeepAwake");
  const request = sessionRequest("powershell.exe", command, null, false);
  await runInSession(laptop, request, 60, signal);
  const deadline = performance.now() + 30_000;
  for (;;) {
    try {
      // Ask the agent itself: `send` answers status from the bridge over the LAN link, which is
      // up without the agent (10-21: restart returned with no agent running).
      return await sendSsh(laptop, "status", 10_000, {}, signal);
    } catch (error) {
      if (!(error instanceof CalledProcessError)) throw error;
      if (performance.now() > deadline) throw error;
      await sleep(1000, signal);
    }
  }
}

export async function agentRunning(laptop: Laptop, signal?: AbortSignal): Promise<boolean> {
  try {
    await sendSsh(laptop, "status", 10_000, {}, signal);
    return true;
  } catch (error) {
    if (error instanceof CalledProcessError) return false;
    throw error;
  }
}

/** Start the pilot agent unless it is running; true when it had to be started. */
export async function ensureAgent(
  laptop: Laptop,
  game: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (await agentRunning(laptop, signal)) return false;
  await startAgent(laptop, game, 30, false, signal);
  return true;
}

async function recordTime(file: string, op: string, via: string, started: number): Promise<void> {
  // Python's time.perf_counter counts seconds, hence its * 1000; performance.now() already
  // counts milliseconds (10-27: the port kept the * 1000 and logged every call 1000x too long).
  const ms = pyRound(performance.now() - started, 1);
  const stamp = new Date().toISOString().replace("Z", "+00:00");
  const line =
    `{"t": ${JSON.stringify(stamp)}, "op": ${JSON.stringify(op)}, ` +
    `"via": ${JSON.stringify(via)}, "ms": ${pythonNumber(ms)}}\n`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, line, "utf8");
  } catch {
    // Timing is a diagnostic; never fail a game action over it.
  }
}

function asReply(reply: unknown): Reply {
  if (!isRecord(reply)) throw new Error("桥插件的回复不是 JSON 对象");
  return reply;
}

/** Python's dict comprehension over a key tuple keeps that order and drops missing keys. */
function pick(reply: Reply, keys: readonly string[]): Reply {
  const out: Reply = {};
  for (const key of keys) {
    if (key in reply) out[key] = reply[key];
  }
  return out;
}

/** Python's str() of the values that can appear here (None becomes "None"). */
function pythonText(value: unknown): string {
  if (value === undefined || value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

/** Python writes whole floats with a trailing .0; the timing file is only read by people. */
function pythonNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      const reason: unknown = signal?.reason;
      reject(reason instanceof Error ? reason : new DOMException("操作已取消", "AbortError"));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
