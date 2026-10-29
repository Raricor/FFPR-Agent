/**
 * Read the game state over SSH when the LAN link is not available: PowerShell that prints the
 * newest probe file's name and its tail, and the parser that turns that into the newest sample
 * and the events since the last call. Ported from state_script and parse_state in
 * ffpr_agent/view.py; the rest of the view belongs to view.ts.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { byKey } from "./games.ts";
import { deployedScript } from "./laptop.ts";
import type { Laptop } from "./laptop.ts";
import { DEPS } from "./paths.ts";
import { describeError } from "./errors.ts";
import { isRecord, records as recordsOf, type Json } from "./values.ts";
import { parseTail, TAIL_BYTES } from "./view.ts";

const PILOT = join(DEPS, "pilot");
/** FF5's cursor keeps the Python path; each of the other games reads its own file. */
export const CURSOR = join(PILOT, "state-cursor.json");

export function cursorPath(game: string): string {
  const key = byKey(game).key;
  return key === "ff5" ? CURSOR : join(PILOT, `state-cursor-${key}.json`);
}

/** PowerShell that prints the newest probe file's name, then its last TAIL_BYTES. */
export function stateScript(laptop: Laptop, game: string): string {
  const key = byKey(game).key;
  return (
    `Import-Module ${deployedScript(laptop, "FfprCommon.psm1")} -Force\n` +
    `$src = Join-Path (Find-GameDir ${key}) 'BepInEx\\ffpr'\n` +
    "$f = Get-ChildItem $src -Filter 'probe-*.jsonl' | Sort-Object LastWriteTime -Descending |" +
    " Select-Object -First 1\n" +
    "$fs = [IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite')\n" +
    `$start = [Math]::Max(0, $fs.Length - ${TAIL_BYTES})\n` +
    "[void]$fs.Seek($start, 'Begin')\n" +
    "$buf = New-Object byte[] ($fs.Length - $start)\n" +
    "[void]$fs.Read($buf, 0, $buf.Length)\n" +
    "$fs.Close()\n" +
    "$f.Name\n" +
    "[Text.Encoding]::UTF8.GetString($buf)"
  );
}

/** The newest sample and the events since the last call (the cursor lives in CURSOR). */
export async function parseState(
  text: string,
  cursorPath: string = CURSOR,
  signal?: AbortSignal,
): Promise<readonly [Json | null, Json[]]> {
  const newline = text.indexOf("\n");
  const name = (newline < 0 ? text : text.slice(0, newline)).trim();
  const tail = newline < 0 ? "" : text.slice(newline + 1);
  const records = recordsOf(parseTail(tail));
  const cursor = await readCursor(cursorPath, signal);
  const lastSeq = cursor.file === name ? cursorSequence(cursor) : 0;
  const samples = records.filter((record) => record.type === "sample");
  const events = records.filter((record) => sequence(record) > lastSeq && record.type !== "sample");
  if (records.length > 0) {
    const last = records[records.length - 1];
    if (last) {
      await mkdir(dirname(cursorPath), { recursive: true });
      await writeFile(cursorPath, JSON.stringify({ file: name, seq: sequence(last) }), {
        encoding: "utf8",
        signal,
      });
    }
  }
  return [samples[samples.length - 1] ?? null, events];
}

async function readCursor(path: string, signal?: AbortSignal): Promise<Json> {
  let text: string;
  try {
    text = await readFile(path, { encoding: "utf8", signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw new Error(`读不了状态游标 ${path}:${describeError(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`读不懂状态游标 ${path}:${describeError(error)}`, { cause: error });
  }
  return isRecord(parsed) ? parsed : {};
}

function sequence(record: Json): number {
  const value = record.seq;
  if (typeof value !== "number") throw new Error("探针记录缺少 seq");
  return value;
}

function cursorSequence(cursor: Json): number {
  return typeof cursor.seq === "number" ? cursor.seq : 0;
}
