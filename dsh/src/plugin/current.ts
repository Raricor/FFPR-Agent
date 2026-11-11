/**
 * Which game the sidebar is about (task 40): one title is open, so the page must not ask the
 * user to pick FF1–FF6. The answer, in order:
 *
 *   1. the shared detection cache, when exactly one game is open;
 *   2. the engine that started most recently;
 *   3. the game whose activity log has the newest entry;
 *   4. ff5, so a brand-new install still has a page.
 *
 * Detection is `peekDetection`: this route never starts an SSH call of its own. Only when the
 * first three rules cannot decide does it read the six activity files, and only their tails.
 */

import { open } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionFetchRoute } from "@deepseek-ai/dsh-client-connection";
import { activityFile } from "../engine/activity.ts";
import { describeError } from "../engine/errors.ts";
import { GAMES, byKey, gameHeading, titleOf } from "../engine/games.ts";
import type { DetectionPeek, DetectionResult, DetectionSource } from "./detect.ts";

export const CURRENT_ROUTE = "/api/ffpr/current";

export interface CurrentEngine {
  readonly game: string;
  /** ISO time the engine started; engineFor only exposes started engines. */
  readonly startedAt: string;
}

export interface CurrentActivity {
  readonly game: string;
  readonly at: string;
}

export type CurrentReason = "detection" | "engine" | "activity" | "fallback";

export interface CurrentChoice {
  readonly game: string;
  readonly running: boolean;
  readonly reason: CurrentReason;
  /** The time of the evidence that decided it, when there is one. */
  readonly since: string | null;
}

export interface CurrentInput {
  readonly detected?: DetectionResult;
  readonly engines?: readonly CurrentEngine[];
  readonly activities?: readonly CurrentActivity[];
  readonly fallback?: string;
}

function newest<T extends { readonly at: string }>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    const time = Date.parse(row.at);
    if (Number.isNaN(time)) continue;
    if (best === null || time > Date.parse(best.at)) best = row;
  }
  return best;
}

/** The three rules, pure so the tests can vary each source without a laptop or files. */
export function decideCurrent(input: CurrentInput = {}): CurrentChoice {
  const detection = input.detected;
  if (detection?.ok === true && detection.running.length === 1) {
    const game = detection.running[0] ?? "";
    if (GAMES.some((item) => item.key === game)) {
      return { game, running: true, reason: "detection", since: null };
    }
  }
  const engines = [...(input.engines ?? [])]
    .filter(
      (engine) =>
        GAMES.some((item) => item.key === engine.game) &&
        !Number.isNaN(Date.parse(engine.startedAt)),
    )
    .map((engine) => ({ ...engine, at: engine.startedAt }));
  const started = newest(engines);
  if (started !== null) {
    const engine = started;
    // A cached detection that says the game is not open is stronger than "an engine exists":
    // it may have outlived the game process. With no detection, trust the started engine.
    const running = detection?.ok === true ? detection.running.includes(engine.game) : true;
    return {
      game: engine.game,
      running,
      reason: "engine",
      since: engine.startedAt,
    };
  }
  const activities = [...(input.activities ?? [])].filter((row) =>
    GAMES.some((item) => item.key === row.game),
  );
  const latest = newest(activities);
  if (latest !== null) {
    const activity = latest;
    return {
      game: activity.game,
      running: detection?.ok === true ? detection.running.includes(activity.game) : false,
      reason: "activity",
      since: activity.at,
    };
  }
  const fallback = input.fallback ?? "ff5";
  return {
    game: GAMES.some((item) => item.key === fallback) ? fallback : "ff5",
    running: false,
    reason: "fallback",
    since: null,
  };
}

/** Read the last complete line of one activity file; missing or broken files count as none. */
async function activityTail(file: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    const length = Math.min(info.size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const lines = buffer
      .toString("utf8")
      .split(/\r\n|\r|\n/u)
      .filter((line) => line.trim() !== "");
    return lines.at(-1) ?? null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** The newest activity across the six logs; only the fallback path needs to touch disk. */
export async function latestActivities(): Promise<CurrentActivity[]> {
  const rows: CurrentActivity[] = [];
  for (const game of GAMES) {
    const line = await activityTail(activityFile(game.key));
    if (line === null) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.at === "string" && typeof record.game === "string") {
        rows.push({ game: record.game, at: record.at });
      }
    } catch {
      // One half-written line is not a reason to hide the other five logs.
    }
  }
  return rows;
}

export interface CurrentReply {
  readonly ok: true;
  readonly at: string;
  readonly game: string;
  readonly label: string;
  readonly name: string;
  readonly title: string;
  readonly running: boolean;
  readonly reason: CurrentReason;
  readonly since: string | null;
}

export function currentReply(choice: CurrentChoice, at = new Date().toISOString()): CurrentReply {
  const game = byKey(choice.game);
  return {
    ok: true,
    at,
    game: game.key,
    label: game.label,
    name: titleOf(game.key),
    title: gameHeading(game.key),
    running: choice.running,
    reason: choice.reason,
    since: choice.since,
  };
}

export interface CurrentSource {
  readonly detection: Pick<DetectionSource, "peek">;
  readonly engines: () => readonly CurrentEngine[];
  readonly activities?: () => Promise<readonly CurrentActivity[]>;
  readonly fallback?: string;
}

export async function readCurrent(source: CurrentSource): Promise<CurrentReply> {
  const peek: DetectionPeek = source.detection.peek();
  const base = decideCurrent({
    detected: peek.result,
    engines: source.engines(),
    ...(source.fallback === undefined ? {} : { fallback: source.fallback }),
  });
  if (base.reason === "detection" || base.reason === "engine") return currentReply(base);
  const activities = source.activities === undefined ? [] : await source.activities();
  return currentReply(
    decideCurrent({
      detected: peek.result,
      engines: source.engines(),
      activities,
      ...(source.fallback === undefined ? {} : { fallback: source.fallback }),
    }),
  );
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function currentRoute(
  source: CurrentSource,
  log?: { warn(message: string): void },
): ConnectionFetchRoute {
  return {
    path: CURRENT_ROUTE,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async () => {
      try {
        return json(await readCurrent(source));
      } catch (error) {
        // The page still needs a game key; a failed activity read falls back to ff5.
        log?.warn(`读当前作品失败:${describeError(error)}`);
        return json(currentReply(decideCurrent({ fallback: source.fallback })));
      }
    },
  };
}

export function installCurrent(
  ctx: Context,
  source: CurrentSource,
  log?: { warn(message: string): void },
): void {
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register(currentRoute(source, log)));
  });
}
