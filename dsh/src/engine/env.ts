/**
 * Parsing KEY=VALUE files (secrets.env, laptop.env) for the bridge link (control plan §5).
 * Ported from ffpr_common/secrets.py so the Python agent and this plugin read the same files.
 */

import { readFile } from "node:fs/promises";
import { describeError, isMissingFile } from "./errors.ts";

const LEADING_BOM = 0xfeff;

/**
 * The rules match Python's parse_env_file: blank and # lines are skipped, the first "=" splits
 * name from value, and one pair of matching quotes is removed. Lines are split on CR/LF only
 * because these files are ASCII configuration, not arbitrary text.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const entries = new Map<string, string>();
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    const quote = value.charAt(0);
    if (
      value.length >= 2 &&
      quote === value.charAt(value.length - 1) &&
      (quote === '"' || quote === "'")
    ) {
      value = value.slice(1, -1);
    }
    entries.set(name, value);
  }
  // Object.fromEntries keeps a "__proto__" key as data instead of touching the prototype.
  return Object.fromEntries(entries);
}

/** Read one KEY=VALUE file; a missing file is an empty map (secrets are optional). */
export async function readEnvFile(
  path: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    if (isMissingFile(error)) return {};
    signal?.throwIfAborted();
    throw new Error(`读不了 ${path}:${describeError(error)}`, { cause: error });
  }
  // Secrets.load reads with utf-8-sig; strip the BOM so it is not part of a key.
  return parseEnvFile(text.charCodeAt(0) === LEADING_BOM ? text.slice(1) : text);
}
