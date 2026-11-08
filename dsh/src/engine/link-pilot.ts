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
import { byKey } from "./games.ts";
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
  "hold",
  "stop",
  "status",
  "walkpath",
]);
export const WALKPATH_UNSUPPORTED = "walkpath_unsupported";
/** What an old bridge calls an op it does not know (task 55: `未知的 op:walkpath`). */
const UNKNOWN_OP = /未知的\s*op|unknown\s+op/iu;
export const LINK_REST_SECONDS = 30;
const DEFAULT_WAIT_MS = 30_000;
/** A status probe that takes longer than this means the agent is busy, not absent. */
const STATUS_WAIT_MS = 10_000;
/**
 * After telling a busy agent to stop, how long to wait for the queued status. The agent checks
 * its .abort marker every 200 ms (story/wait/walk loops); 30 s leaves room for the current
 * button press and a slow bridge reply, yet ends inside a tool call's 60 s wait.
 */
const BUSY_WAIT_MS = 30_000;
/** The abort marker must be written even though the command's own SSH session is gone. */
const ABORT_WRITE_TIMEOUT_MS = 5_000;

/** Rest state is per laptop, not per tool call: Python keeps it in a module-level dict. */
const LINK_REST_UNTIL = new WeakMap<object, number>();

/**
 * Whether this bridge connection has answered walkpath with an unknown op (task 56). An old
 * plugin says so once and the caller falls back to SSH `walk`; keeping the mark on the link
 * stops every later plan from paying for the same failed round trip. A dropped link clears it,
 * so the bridge that comes back is asked once more (0.14.0 may have replaced 0.13.x).
 */
const WALKPATH_SUPPORT = new WeakMap<PilotLink, { unsupported: boolean }>();

function supportOf(link: PilotLink): { unsupported: boolean } {
  let support = WALKPATH_SUPPORT.get(link);
  if (support === undefined) {
    support = { unsupported: false };
    WALKPATH_SUPPORT.set(link, support);
  }
  return support;
}

/** A failed connection says nothing about the bridge version; ask the next one again. */
function forgetUnsupported(link: PilotLink | undefined): void {
  if (link !== undefined) supportOf(link).unsupported = false;
}

/**
 * In-flight restarts, keyed by game: the pilot agent quits after 30 idle minutes, and several
 * tool calls can find it gone together. The state is per game so one title's restart never
 * holds up another's (10-29: six players ran at once).
 */
const RESTARTS = new Map<string, Promise<void>>();

/** sendSsh throws exactly this when agent.json is missing (the guard is in its script). */
const AGENT_GONE = "试玩助手没有运行";

export interface PilotLink {
  command(op: string, fields: Fields, signal: AbortSignal, timeoutMs?: number): Promise<unknown>;
  query(op: string, fields: Fields, signal: AbortSignal): Promise<unknown>;
}

export interface PilotOptions {
  /** The game this pilot plays: FF5 keeps the Python agent's directory, the others get their own. */
  readonly game: string;
  /** Test seams; production uses TIMING under .deps and the process environment. */
  timingFile?: string;
  env?: NodeJS.ProcessEnv;
  /** One line when the pilot agent had to be restarted; omitted means it is not recorded. */
  log?: (message: string) => void;
}

/** FF5's pilot agent keeps the Python path; the five new games each get their own directory. */
export function agentDir(laptop: Laptop, game: string): string {
  const key = byKey(game).key;
  return key === "ff5" ? `${laptop.root}/session/pilot` : `${laptop.root}/session/pilot-${key}`;
}

/**
 * Bind the laptop and LAN link to one tool call. A link failure puts the link to rest for 30
 * seconds; later sends go straight to SSH without paying the connection timeout again.
 */
export function createPilot(
  laptop: Laptop,
  link: PilotLink | undefined,
  signal: AbortSignal,
  options: PilotOptions,
): Pilot {
  const timingFile = options.timingFile ?? TIMING;
  const env = options.env ?? process.env;
  const game = byKey(options.game).key;

  const send = async (
    op: string,
    fields: Fields = {},
    waitMs = DEFAULT_WAIT_MS,
  ): Promise<Reply> => {
    const started = performance.now();
    if (op === "walkpath") {
      // There is no SSH version of walkpath: the pilot agent's walk is one corner at a time.
      // An old bridge, or no LAN at all, answers walkpath_unsupported so the caller can fall
      // back to that walk instead of waiting on a command the agent does not know.
      const support = link === undefined ? undefined : supportOf(link);
      const canUseLink =
        link !== undefined &&
        env.FFPR_LINK !== "off" &&
        performance.now() >= (LINK_REST_UNTIL.get(laptop) ?? 0) &&
        support?.unsupported !== true;
      let result: Reply = { ok: false, error: WALKPATH_UNSUPPORTED };
      let via = "none";
      if (link !== undefined && canUseLink) {
        via = "lan";
        try {
          result = await throughLink(link, op, fields, waitMs, signal, `${byKey(game).label} 玩家`);
        } catch (error) {
          if (!(error instanceof LinkError)) throw error;
          // The connection is gone; a bridge that reconnects may be 0.14.0 after all.
          signal.throwIfAborted();
          forgetUnsupported(link);
          LINK_REST_UNTIL.set(laptop, performance.now() + LINK_REST_SECONDS * 1000);
          result = { ok: false, error: WALKPATH_UNSUPPORTED };
        }
      }
      await recordTime(timingFile, op, via, started);
      return result;
    }
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
        result = await throughLink(link, op, fields, waitMs, signal, `${byKey(game).label} 玩家`);
        via = "lan";
      } catch (error) {
        if (!(error instanceof LinkError)) throw error;
        forgetUnsupported(link);
        LINK_REST_UNTIL.set(laptop, performance.now() + LINK_REST_SECONDS * 1000);
      }
    }
    result ??= await sendSshOrRestart(laptop, op, game, waitMs, fields, signal, options.log);
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
  sender: string,
): Promise<Reply> {
  if (op === "hold") {
    // 11-05: escape (and later other held keys) uses the bridge's virtual gamepad hold. The
    // pilot agent has no hold op, so this one must go over the LAN link; without a link the
    // caller gets the agent's unknown_op and reports that the keys could not be held.
    const reply = await link.command(
      "hold",
      {
        key: fields.key,
        down: fields.down === true,
        ms: fields.ms ?? 2500,
      },
      signal,
      waitMs,
    );
    return pick(asReply(reply), ["ok", "error"]);
  }
  if (op === "stop") {
    const reply = await link.command("stop", {}, signal, waitMs);
    return pick(asReply(reply), ["ok", "error"]);
  }
  if (op === "keys") {
    // via "game": the bridge presses a virtual gamepad inside the game, so the window can stay
    // in the background (bridge 0.9.0; older bridges ignore the field and use SendInput).
    // "from" is the bridge 0.12.0 keys record; older bridges ignore the unknown field.
    const reply = await link.command(
      "keys",
      { keys: fields.keys, gap: "gap" in fields ? fields.gap : 120, via: "game", from: sender },
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
  if (op === "walkpath") {
    // 0.14.0: the bridge walks the whole route itself. Its command waits for the walk, so the
    // link must outlast the walk's own timeout by a margin (task 55 holds the command thread).
    const support = supportOf(link);
    if (support.unsupported) return { ok: false, error: WALKPATH_UNSUPPORTED };
    const timeoutMs =
      typeof fields.timeoutMs === "number" && Number.isFinite(fields.timeoutMs)
        ? fields.timeoutMs
        : waitMs;
    const payload: Fields = { path: fields.path };
    for (const key of ["timeoutMs", "blockedMs", "turnLead"]) {
      if (fields[key] !== undefined) payload[key] = fields[key];
    }
    const reply = asReply(await link.command("walkpath", payload, signal, timeoutMs + 5_000));
    if (!truthy(reply.ok) && UNKNOWN_OP.test(pythonText(reply.error))) {
      support.unsupported = true;
      return { ok: false, error: WALKPATH_UNSUPPORTED };
    }
    return pick(reply, ["ok", "reason", "index", "steps", "pos", "next", "turns", "error"]);
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
  game: string,
  waitMs = DEFAULT_WAIT_MS,
  fields: Fields = {},
  signal?: AbortSignal,
  log?: (message: string) => void,
): Promise<Reply> {
  const cid = process.hrtime.bigint().toString();
  const body = JSON.stringify({ op, ...fields });
  const script =
    `$dir = ${psQuote(agentDir(laptop, game))}\n` +
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
  let out: string;
  try {
    out = (await runPs(laptop, script, { capture: true, signal })).stdout.trim();
  } catch (error) {
    // The SSH session is killed on cancel; tell the agent to stop the command it may still be
    // running, over a fresh short-lived session (11-02: a cancelled story kept the laptop busy
    // for minutes and every later command queued behind it).
    if (signal?.aborted) await writeAbort(laptop, game, cid, log);
    throw error;
  }
  const parsed: unknown = JSON.parse(out);
  if (!isRecord(parsed)) throw new Error("试玩助手的回复不是 JSON 对象");
  return parsed;
}

/** Leave <id>.abort for the pilot agent to see; a failure is only logged, never a new error. */
async function writeAbort(
  laptop: Laptop,
  game: string,
  cid: string,
  log: ((message: string) => void) | undefined,
): Promise<void> {
  const script =
    `$dir = ${psQuote(agentDir(laptop, game))}\n` +
    "if (Test-Path $dir) {\n" +
    `  New-Item -ItemType File -Force (Join-Path $dir '${cid}.abort') | Out-Null\n` +
    "}";
  await runAbortScript(laptop, script, log, `写取消标记 ${cid}.abort 失败`);
}

/** Mark every command still queued on the laptop, so a busy agent stops instead of draining. */
async function abortPending(
  laptop: Laptop,
  game: string,
  log?: (message: string) => void,
): Promise<void> {
  const script =
    `$dir = ${psQuote(agentDir(laptop, game))}\n` +
    "if (Test-Path $dir) {\n" +
    "  Get-ChildItem -Path $dir -Filter '*.cmd.json' | ForEach-Object {\n" +
    "    $id = $_.Name -replace '\\.cmd\\.json$', ''\n" +
    '    New-Item -ItemType File -Force (Join-Path $dir "$id.abort") | Out-Null\n' +
    "  }\n" +
    "}";
  await runAbortScript(laptop, script, log, "写取消标记失败");
}

async function runAbortScript(
  laptop: Laptop,
  script: string,
  log: ((message: string) => void) | undefined,
  failure: string,
): Promise<void> {
  try {
    // Not the tool call's signal: that one is already aborted, and this write must still run.
    await runPs(laptop, script, { signal: AbortSignal.timeout(ABORT_WRITE_TIMEOUT_MS) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const write = log ?? ((line: string) => process.stderr.write(`${line}\n`));
    write(`${failure}:${message}`);
  }
}

/**
 * The SSH half of a send: when the agent is gone, start it again and resend once. Only that
 * explicit failure restarts anything; a timeout or a broken SSH command is reported as before
 * (10-29: FF1 reported the not-running error five times in a minute).
 */
async function sendSshOrRestart(
  laptop: Laptop,
  op: string,
  game: string,
  waitMs: number,
  fields: Fields,
  signal: AbortSignal,
  log: ((message: string) => void) | undefined,
): Promise<Reply> {
  try {
    return await sendSsh(laptop, op, game, waitMs, fields, signal, log);
  } catch (error) {
    if (!agentGone(error)) throw error;
    await restartAgent(laptop, game, log, signal);
    // Once only: a second not-running means the restart did not take, so the caller sees it.
    return await sendSsh(laptop, op, game, waitMs, fields, signal, log);
  }
}

/** True only for the pilot agent being absent, never for another SSH failure. */
function agentGone(error: unknown): boolean {
  return error instanceof CalledProcessError && error.stderr.includes(AGENT_GONE);
}

/**
 * Start the agent once per game while concurrent callers wait for that start. The caller that
 * actually started it records the line; the others only resend.
 */
async function restartAgent(
  laptop: Laptop,
  game: string,
  log: ((message: string) => void) | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const key = byKey(game).key;
  const pending = RESTARTS.get(key);
  if (pending !== undefined) {
    await pending;
    return;
  }
  const starting = (async () => {
    if (await ensureAgent(laptop, game, signal)) {
      log?.("试玩助手不在，已重新启动");
    }
  })();
  RESTARTS.set(key, starting);
  try {
    await starting;
  } finally {
    if (RESTARTS.get(key) === starting) RESTARTS.delete(key);
  }
}

/** Copy a screenshot the agent left on the laptop to .deps/pilot/shots. */
export async function fetchShot(
  laptop: Laptop,
  result: Reply,
  game: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!truthy(result.shot)) return null;
  await mkdir(SHOTS, { recursive: true });
  const id = text(result.id) ?? String(result.id);
  const local = join(SHOTS, `${id}.png`);
  const remote = `${laptop.user}@${laptop.host}:${agentDir(laptop, game)}/${id}.png`;
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
    `$dir = ${psQuote(agentDir(laptop, game))}\n` +
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
  // 10-29: FF5's first answer arrived just after 30 seconds and the start had worked; the agent
  // loads the bridge before it can answer, so give a slow start a full minute.
  const deadline = performance.now() + 60_000;
  for (;;) {
    try {
      // Ask the agent itself: `send` answers status from the bridge over the LAN link, which is
      // up without the agent (10-21: restart returned with no agent running).
      return await sendSsh(laptop, "status", game, 10_000, {}, signal);
    } catch (error) {
      if (!(error instanceof CalledProcessError)) throw error;
      if (performance.now() > deadline) throw error;
      await sleep(1000, signal);
    }
  }
}

type AgentProcess = "absent" | "stale" | "alive";

/**
 * Whether agent.json names a live process. One runPs: an SSH login sees the desktop session's
 * processes (11-02: checked on the laptop, so a leftover agent.json no longer looks running).
 */
async function agentProcess(
  laptop: Laptop,
  game: string,
  signal?: AbortSignal,
): Promise<AgentProcess> {
  const script =
    `$dir = ${psQuote(agentDir(laptop, game))}\n` +
    "$agent = Join-Path $dir 'agent.json'\n" +
    "if (-not (Test-Path $agent)) { 'absent' }\n" +
    "else {\n" +
    "  try {\n" +
    "    $agentPid = [int](Get-Content $agent -Raw -Encoding UTF8 | ConvertFrom-Json).pid\n" +
    "    if (Get-Process -Id $agentPid -ErrorAction SilentlyContinue) { 'alive' } else { 'stale' }\n" +
    "  } catch { 'stale' }\n" +
    "}";
  // An SSH failure propagates: treating it as "stale" would make startAgent delete agent.json
  // while a live agent keeps the mutex, and every later command would say it is not running.
  const out = (await runPs(laptop, script, { capture: true, signal })).stdout.trim();
  if (out === "alive") return "alive";
  return out === "absent" ? "absent" : "stale";
}

/**
 * A live agent.json means an agent is running, maybe busy. Only the two not-running states
 * (no file, or a stale pid) return false; a busy agent is never replaced by a second one.
 */
export async function agentRunning(
  laptop: Laptop,
  game: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if ((await agentProcess(laptop, game, signal)) !== "alive") return false;
  try {
    await sendSsh(laptop, "status", game, STATUS_WAIT_MS, {}, signal);
    return true;
  } catch (error) {
    if (!(error instanceof CalledProcessError)) throw error;
    if (agentGone(error)) return false;
    // The process is there but status did not come back: it is busy with a long command.
    // Leave abort markers (the same ones a cancelled tool call uses), then wait for the
    // queued status instead of starting a second agent over the same command directory.
    await abortPending(laptop, game);
    try {
      await sendSsh(laptop, "status", game, BUSY_WAIT_MS, {}, signal);
      return true;
    } catch (retry) {
      if (retry instanceof CalledProcessError && agentGone(retry)) return false;
      if (retry instanceof CalledProcessError) {
        throw new Error("试玩助手正忙、没有回应:先等它跑完或重启试玩助手,没有启动第二个", {
          cause: retry,
        });
      }
      throw retry;
    }
  }
}

/** Start the pilot agent unless it is running; true when it had to be started. */
export async function ensureAgent(
  laptop: Laptop,
  game: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (await agentRunning(laptop, game, signal)) return false;
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
