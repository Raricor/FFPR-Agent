/**
 * API keys come from secrets.env (KEY=VALUE lines) or the process environment, ported from
 * ffpr_common/secrets.py. Values never appear in error messages; callers register them with a
 * Redactor before logging.
 *
 * Loading is asynchronous because the plugin shares dsh's event loop; a missing file is normal
 * (the environment may supply every value).
 */

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readEnvFile } from "./env.ts";
import { describeError, isMissingFile } from "./errors.ts";
import { secretsPath } from "./paths.ts";

const PRIVATE_MODE = 0o600;
const OTHER_ACCESS = 0o077;

export class MissingSecret extends Error {
  readonly secretName: string;
  readonly path: string;

  constructor(name: string, path: string) {
    super(`缺少 ${name}:请写进 ${path},或者设置同名环境变量`);
    this.name = "MissingSecret";
    this.secretName = name;
    this.path = path;
  }
}

export interface SecretsLoadOptions {
  signal?: AbortSignal;
  /** Receives the world-readable warning; tests capture it instead of writing to stderr. */
  warn?: (message: string) => void;
}

export class Secrets {
  readonly path: string;
  private readonly file: Record<string, string>;
  private readonly environ: NodeJS.ProcessEnv;

  constructor(fileValues: Record<string, string>, path: string, environ: NodeJS.ProcessEnv) {
    this.file = { ...fileValues };
    this.path = path;
    this.environ = environ;
  }

  static async load(
    path: string = secretsPath(),
    environ: NodeJS.ProcessEnv = process.env,
    options: SecretsLoadOptions = {},
  ): Promise<Secrets> {
    await warnIfReadableByOthers(path, options);
    const fileValues = await readEnvFile(path, options.signal);
    return new Secrets(fileValues, path, environ);
  }

  get(name: string): string {
    // The environment wins, so a one-off override needs no file edit.
    const value = this.environ[name] || this.file[name] || "";
    if (!value) throw new MissingSecret(name, this.path);
    return value;
  }

  has(name: string): boolean {
    return Boolean(this.environ[name] || this.file[name]);
  }
}

/** Set NAME=value in a secrets file (replacing an existing line), readable only by us. */
export async function store(
  path: string,
  name: string,
  value: string,
  signal?: AbortSignal,
): Promise<void> {
  const lines = await readLines(path, signal);
  const kept = lines.filter((line) => {
    const separator = line.indexOf("=");
    return (separator < 0 ? line : line.slice(0, separator)).trim() !== name;
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [...kept, `${name}=${value}`].join("\n") + "\n", {
    encoding: "utf8",
    signal,
  });
  if (process.platform !== "win32") await chmod(path, PRIVATE_MODE);
}

async function readLines(path: string, signal?: AbortSignal): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (isMissingFile(error)) return [];
    signal?.throwIfAborted();
    throw new Error(`读不了 ${path}:${describeError(error)}`, { cause: error });
  }
  // Python reads utf-8-sig; a BOM would otherwise become part of the first name.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  // str.splitlines() does not return an extra empty line for a trailing newline.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function warnIfReadableByOthers(path: string, options: SecretsLoadOptions): Promise<void> {
  if (process.platform === "win32") return;
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch (error) {
    if (isMissingFile(error)) return;
    options.signal?.throwIfAborted();
    throw new Error(`读不了 ${path}:${describeError(error)}`, { cause: error });
  }
  if ((mode & OTHER_ACCESS) === 0) return;
  const message = `${path} 对其他用户可读,建议执行 chmod 600 ${path}`;
  if (options.warn) options.warn(message);
  else console.warn(message);
}
