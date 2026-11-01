/**
 * The link to the Windows laptop, ported from ffpr_agent/laptop.py: SSH with one dedicated key,
 * PowerShell over -EncodedCommand, programs started on the desktop through the logon-only
 * scheduled task, and the operations other code builds on (deploy the scripts, launch a game,
 * fetch probe logs).
 *
 * Every process is spawned asynchronously: the plugin lives in dsh's event loop, so a blocking
 * SSH call would freeze the whole harness. All waiting functions take the caller's signal and
 * kill the child when it aborts.
 */

import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readEnvFile } from "./env.ts";
import { describeError, isMissingFile } from "./errors.ts";
import { DEPS, REPO } from "./paths.ts";
import type { Game } from "./games.ts";

export const CONFIG = join(REPO, "agent", "laptop.env");

export const SESSION_TASK = "FFPR-Agent-Session";

/**
 * Without this, PowerShell writes to the SSH pipe in the OEM code page and Chinese is garbled.
 */
export const PS_PRELUDE =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; " +
  "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'\n";

/** With stderr on a pipe, powershell.exe serialises its error and warning streams as CLIXML. */
const CLIXML_BLOCK = /(<Objs\b.*?<\/Objs>)/s;
const CLIXML_STRING = /<S S="(\w+)">(.*?)<\/S>/gs;
const CLIXML_ESCAPE = /_x([0-9A-Fa-f]{4})_/g;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class CalledProcessError extends Error {
  readonly returnCode: number;
  readonly cmd: readonly string[];
  readonly stdout: string;
  readonly stderr: string;

  /**
   * The message carries the reason (the program's own error text, for PowerShell the decoded
   * CLIXML), not the command line: the model reads it in 工具出错, and the command with its
   * base64 script told it nothing (10-27: "命令退出码 1:ssh … -EncodedCommand WwBD…" while
   * the pilot agent was not running). Unlike Python, whose message is the command; `cmd` keeps it.
   */
  constructor(returnCode: number, cmd: readonly string[], stdout: string, stderr: string) {
    super(`命令退出码 ${returnCode}:${reasonOf(stderr) || cmd[0] || "?"}`);
    this.name = "CalledProcessError";
    this.returnCode = returnCode;
    this.cmd = cmd;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** PowerShell's location and category lines around an error message. */
const ERROR_NOISE = /^(所在位置|At line|At char|\+ |\s+\+ |CategoryInfo|FullyQualifiedErrorId)/;
const REASON_CHARS = 300;

/** The meaningful lines of a failed program's stderr, e.g. "试玩助手没有运行:先运行 ffpr-pilot start". */
export function reasonOf(stderr: string): string {
  const lines = stderr
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "" && !ERROR_NOISE.test(line));
  return lines.join(" / ").slice(0, REASON_CHARS);
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export interface Laptop {
  readonly host: string;
  readonly user: string;
  /** Path to the dedicated private key; Python's Path, kept as a string here. */
  readonly key: string;
  readonly root: string;
  /** The account logged on to the desktop, which the session task runs as (MIFEITECH\yangwt). */
  readonly desktopUser?: string;
  /**
   * The LAN link to the bridge (control plan §5): its URL, and the address the laptop sees the
   * dev box connect from (the dev box runs in a container, so it is the host's address).
   */
  readonly bridgeUrl?: string;
  readonly devboxAddress?: string;
  /** Tests point this at a fake ssh script; production uses the one on PATH. */
  readonly sshCommand?: string;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly returnCode: number;
}

interface RunOptions {
  capture?: boolean;
  check?: boolean;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface PsOptions {
  check?: boolean;
  capture?: boolean;
  signal?: AbortSignal;
}

export interface SessionRequest {
  readonly id: string;
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly wait: boolean;
}

export async function load(path: string = CONFIG, signal?: AbortSignal): Promise<Laptop> {
  try {
    await stat(path);
  } catch (error) {
    signal?.throwIfAborted();
    if (isMissingFile(error)) {
      throw new ConfigError(`缺少 ${path}:请复制 agent/laptop.env.example 并填写`);
    }
    throw new ConfigError(`读不了 ${path}:${describeError(error)}`);
  }
  const values = await readEnvFile(path, signal);
  const missing = ["LAPTOP_HOST", "LAPTOP_USER"].filter((name) => !values[name]);
  if (missing.length > 0) {
    throw new ConfigError(`${path} 里缺少 ${missing.join(", ")}`);
  }
  const key = values.LAPTOP_KEY || "~/.ssh/ffpr_laptop_ed25519";
  // Missing means absent above; noUncheckedIndexedAccess still needs a check for the compiler.
  const host = values.LAPTOP_HOST;
  const user = values.LAPTOP_USER;
  if (!host || !user) throw new ConfigError(`${path} 里缺少 LAPTOP_HOST, LAPTOP_USER`);
  return {
    host,
    user,
    key: expandHome(key),
    root: values.LAPTOP_ROOT || "C:/ffpr",
    desktopUser: values.LAPTOP_DESKTOP_USER || undefined,
    bridgeUrl: values.BRIDGE_URL || undefined,
    devboxAddress: values.DEVBOX_ADDRESS || undefined,
    sshCommand: "ssh",
  };
}

export function target(laptop: Laptop): string {
  return `${laptop.user}@${laptop.host}`;
}

export function ssh(laptop: Laptop): string[] {
  return [laptop.sshCommand || "ssh", ...options(laptop), target(laptop)];
}

export function scp(laptop: Laptop): string[] {
  return ["scp", ...options(laptop), "-r"];
}

export function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Base64 of UTF-16LE, the format powershell -EncodedCommand expects. Avoids all quoting. */
export function encodePs(script: string): string {
  return Buffer.from(PS_PRELUDE + script, "utf16le").toString("base64");
}

/** Turn PowerShell's CLIXML stderr back into the text it would have printed. */
export function decodeClixml(text: string): string {
  if (!text.startsWith("#< CLIXML")) return text;
  const out: string[] = [];
  for (const part of text
    .slice("#< CLIXML".length)
    .replace(/^[\r\n]+/, "")
    .split(CLIXML_BLOCK)) {
    if (!part.startsWith("<Objs")) {
      out.push(part);
      continue;
    }
    for (const match of part.matchAll(CLIXML_STRING)) {
      const stream = match[1] ?? "";
      const raw = match[2] ?? "";
      const value = decodeHtmlEntities(raw).replace(CLIXML_ESCAPE, (_, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      );
      out.push((stream.toLowerCase() === "warning" ? "警告:" : "") + value);
    }
  }
  return out.join("").replaceAll("\r\n", "\n");
}

export function deployedScript(laptop: Laptop, name: string): string {
  return psQuote(`${laptop.root}/deploy/laptop/${name}`);
}

export function sessionRequest(
  file: string,
  args: readonly string[],
  cwd: string | null,
  wait: boolean,
): SessionRequest {
  return { id: randomUUID().replaceAll("-", "").slice(0, 12), file, args, cwd, wait };
}

/** Run a PowerShell script on the laptop; the SSH child is killed when the signal aborts. */
export async function runPs(
  laptop: Laptop,
  script: string,
  options: PsOptions = {},
): Promise<ProcessResult> {
  // The laptop's machine policy is AllSigned; Bypass for this process lets our unsigned scripts
  // run without changing the policy itself.
  const command = [
    ...ssh(laptop),
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePs(script),
  ];
  const result = await runProcess(command, {
    capture: options.capture === true,
    signal: options.signal,
  });
  const stderr = decodeClixml(result.stderr);
  if (stderr) process.stderr.write(stderr);
  if (options.check !== false && result.returnCode !== 0) {
    throw new CalledProcessError(result.returnCode, command, result.stdout, stderr);
  }
  return { ...result, stderr };
}

/** Run scp with the dedicated key; shared by deploy and fetchProbeLogs. */
export async function runScp(
  laptop: Laptop,
  sources: string | readonly string[],
  destination: string,
  options: Pick<RunOptions, "check" | "signal"> = {},
): Promise<ProcessResult> {
  const list = typeof sources === "string" ? [sources] : [...sources];
  const command = [...scp(laptop), ...list, destination];
  return runProcess(command, {
    capture: true,
    check: options.check !== false,
    signal: options.signal,
  });
}

/** Run a program on the laptop's desktop through the logon-only scheduled task. */
export async function runInSession(
  laptop: Laptop,
  request: SessionRequest,
  timeout: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const session = `${laptop.root}/session`;
  const body = JSON.stringify(request);
  await runPs(
    laptop,
    `New-Item -ItemType Directory -Force ${psQuote(session)} | Out-Null\n` +
      `[IO.File]::WriteAllText(${psQuote(session + "/request.json")}, ${psQuote(body)}, ` +
      "(New-Object Text.UTF8Encoding $false))\n" +
      // schtasks.exe, not Start-ScheduledTask: CIM is denied to ffpr's network logon.
      `schtasks.exe /run /tn ${psQuote(SESSION_TASK)} | Out-Null\n` +
      "if ($LASTEXITCODE) { throw '触发计划任务失败:还没注册,或者没有授权给这个账号' }",
    { signal },
  );
  const statusPath = psQuote(`${session}/${request.id}.status.json`);
  const deadline = performance.now() + timeout * 1000;
  const final = request.wait ? ["done", "error"] : ["started", "done", "error"];
  while (performance.now() < deadline) {
    const out = (
      await runPs(
        laptop,
        `if (Test-Path ${statusPath}) { Get-Content ${statusPath} -Raw -Encoding UTF8 }`,
        { capture: true, signal },
      )
    ).stdout.trim();
    if (out) {
      const status = parseStatus(out);
      const state = status.state;
      if (typeof state === "string" && final.includes(state)) return status;
    }
    await sleep(2000, signal);
  }
  throw new TimeoutError("等待超时:笔记本上可能没有登录桌面,或者还没注册计划任务");
}

/** Create the root and limit it to SYSTEM, Administrators, us and the desktop user. */
export function secureRootScript(laptop: Laptop): string {
  // The session task runs request.json as the desktop user, so nobody else may write here; the
  // default C:\ inheritance would let every local account (Codex sandboxes included) do so.
  if (!laptop.desktopUser) {
    throw new ConfigError(
      "laptop.env 里缺少 LAPTOP_DESKTOP_USER(你登录桌面的账号,如 MIFEITECH\\yangwt)",
    );
  }
  return (
    `$root = ${psQuote(laptop.root)}\n` +
    "New-Item -ItemType Directory -Force $root | Out-Null\n" +
    "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value\n" +
    `$desktop = ([Security.Principal.NTAccount]${psQuote(laptop.desktopUser)})` +
    ".Translate([Security.Principal.SecurityIdentifier]).Value\n" +
    "& icacls.exe $root /inheritance:r /grant:r " +
    "'*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' " +
    '"*${me}:(OI)(CI)F" "*${desktop}:(OI)(CI)M" | Out-Null\n' +
    'if ($LASTEXITCODE) { throw "icacls 失败,退出码 $LASTEXITCODE" }'
  );
}

/** Copy deploy/laptop to the laptop's root, which only we and the desktop user may write. */
export async function deploy(laptop: Laptop, signal?: AbortSignal): Promise<void> {
  await runPs(
    laptop,
    secureRootScript(laptop) +
      "\n" +
      `New-Item -ItemType Directory -Force ${psQuote(laptop.root + "/deploy")} | Out-Null`,
    { signal },
  );
  await runScp(laptop, join(REPO, "deploy", "laptop"), `${target(laptop)}:${laptop.root}/deploy/`, {
    signal,
  });
}

/**
 * Ask Steam on the desktop to start the game; returns the session task's state.
 * 10-29 (task 23): run-in-session.ps1 now waits up to 120 seconds for the game window and only
 * then writes `started`, so the default wait has to allow that plus the round trips.
 */
export async function launch(
  laptop: Laptop,
  game: Game,
  timeout = 150,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const request = sessionRequest(`steam://rungameid/${game.appId}`, [], null, false);
  const status = await runInSession(laptop, request, timeout, signal);
  return typeof status.state === "string" ? status.state : undefined;
}

/** Copy the newest `last` probe files to .deps/<game>/probe; returns their names and sizes. */
export async function fetchProbeLogs(
  laptop: Laptop,
  game: Game,
  last = 3,
  signal?: AbortSignal,
): Promise<string> {
  const staged = `${laptop.root}/staging/probe-${game.key}`;
  // The game keeps the newest file open for writing; File.Copy would hit a sharing violation,
  // so read with ReadWrite sharing.
  const result = await runPs(
    laptop,
    `Import-Module ${deployedScript(laptop, "FfprCommon.psm1")} -Force\n` +
      `$src = Join-Path (Find-GameDir ${game.key}) 'BepInEx\\ffpr'\n` +
      `$dst = ${psQuote(staged)}\n` +
      "if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }\n" +
      "New-Item -ItemType Directory -Force $dst | Out-Null\n" +
      "$files = Get-ChildItem $src -Filter 'probe-*.jsonl' |" +
      " Sort-Object LastWriteTime -Descending\n" +
      `foreach ($f in @($files | Select-Object -First ${Math.trunc(last)})) {\n` +
      "  $in = [IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite')\n" +
      "  $out = [IO.File]::Create((Join-Path $dst $f.Name))\n" +
      "  try { $in.CopyTo($out) } finally { $out.Close(); $in.Close() }\n" +
      "  '{0}  {1:N0} KB' -f $f.Name, ($f.Length / 1KB)\n" +
      "}",
    { capture: true, signal },
  );
  const destination = join(DEPS, game.key, "probe");
  await mkdir(destination, { recursive: true });
  await runScp(laptop, `${target(laptop)}:${staged}/*`, destination, { signal });
  return result.stdout.trim();
}

/** IdentitiesOnly: never fall back to keys in a forwarded ssh-agent, only the dedicated key.
 * WarnWeakCrypto=no: Windows OpenSSH 9.5 offers no post-quantum key exchange, and the warning
 * about it would otherwise precede every command. ControlMaster: reuse one connection for a few
 * minutes; the pilot sends many commands. */
function options(laptop: Laptop): string[] {
  return [
    "-i",
    laptop.key,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "WarnWeakCrypto=no",
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=300",
    "-o",
    `ControlPath=${join(homedir(), ".ssh", "ffpr-cm-%C")}`,
  ];
}

function runProcess(command: readonly string[], options: RunOptions = {}): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const [executable, ...args] = command;
    if (!executable) {
      reject(new Error("命令是空的"));
      return;
    }
    const child = spawn(executable, args, {
      stdio: ["ignore", options.capture === true ? "pipe" : "inherit", "pipe"],
      env: options.env,
      signal: options.signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (options.signal?.aborted) reject(abortReason(options.signal));
      else reject(new Error(`启动 ${executable} 失败:${describeError(error)}`, { cause: error }));
    });
    child.on("close", (code) => {
      const result: ProcessResult = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        returnCode: code ?? -1,
      };
      if (options.check === true && result.returnCode !== 0) {
        reject(new CalledProcessError(result.returnCode, command, result.stdout, result.stderr));
        return;
      }
      resolve(result);
    });
  });
}

function parseStatus(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("计划任务的 status.json 不是对象");
  }
  return parsed as Record<string, unknown>;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(abortReason(signal));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException("操作已取消", "AbortError");
}

/** The handful of HTML entities CLIXML uses; Python's html.unescape handles the full table. */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: "\u00a0",
    };
    return named[body] ?? match;
  });
}
