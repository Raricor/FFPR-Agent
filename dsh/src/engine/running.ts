/**
 * Which of the six games is running on the laptop (task 31). The web starts one engine only for
 * the game that is actually open, so a browser reload no longer reaches the laptop six times.
 *
 * `Get-RunningGames` is not deployed yet; the script calls the existing `Find-GameDir` and
 * `Test-GameRunning` per title instead. A game that is not installed makes `Find-GameDir` throw
 * and counts as not running. The laptop prints one JSON array; the dev box validates every key
 * and drops anything it does not know.
 */

import { describeError } from "./errors.ts";
import { GAMES } from "./games.ts";
import { deployedScript, psQuote, runPs, type Laptop } from "./laptop.ts";

/** One PowerShell line per title would need six SSH connections; one `runPs` asks all six. */
export function runningGamesScript(laptop: Laptop): string {
  const keys = GAMES.map((game) => psQuote(game.key)).join(", ");
  return (
    `Import-Module ${deployedScript(laptop, "FfprCommon.psm1")} -Force\n` +
    "$running = @()\n" +
    `foreach ($game in @(${keys})) {\n` +
    "  try {\n" +
    "    $dir = Find-GameDir $game\n" +
    "    if (Test-GameRunning $dir) { $running += $game }\n" +
    "  } catch { }\n" +
    "}\n" +
    // Build the array by hand: ConvertTo-Json unwraps a one-element array and can print nothing
    // for an empty one, while the dev box needs exactly one JSON array either way.
    "$json = '[' + (($running | ForEach-Object { '\"' + $_ + '\"' }) -join ',') + ']'\n" +
    "Write-Output $json\n"
  );
}

/**
 * The running game keys in ff1 … ff6 order. One SSH call; unknown keys in the answer are
 * dropped, and malformed output is a Chinese error rather than an empty list.
 */
export async function runningGames(laptop: Laptop, signal?: AbortSignal): Promise<string[]> {
  const result = await runPs(laptop, runningGamesScript(laptop), {
    capture: true,
    signal,
  });
  return parseRunningGames(result.stdout);
}

/** Separate from the SSH call so the JSON contract is testable without a laptop. */
export function parseRunningGames(stdout: string): string[] {
  const text = stdout.trim();
  if (text === "") throw new Error("读不了笔记本上开着的作品:笔记本没有输出");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `读不了笔记本上开着的作品:输出不是合法 JSON(${describeError(error)}):${oneLine(text)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`读不了笔记本上开着的作品:输出不是数组:${oneLine(text)}`);
  }
  const known = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const key = item.trim().toLowerCase();
    if (GAMES.some((game) => game.key === key)) known.add(key);
  }
  return GAMES.filter((game) => known.has(game.key)).map((game) => game.key);
}

function oneLine(text: string): string {
  return (text.split(/\r\n|\r|\n/, 1)[0] ?? "").slice(0, 200);
}
