/**
 * One shared answer to "which game is open on the laptop" (task 31). Every player preset and
 * the root panel entry asks this question, and a browser reload must not become six SSH calls:
 * the cache and the in-flight promise live on globalThis, like registry.ts, because the presets
 * may hold different module instances (loader isolation, hot reload).
 *
 * The shared SSH call owns its signal. A caller's cancellation only stops that caller waiting;
 * the query keeps running for the others and still fills the cache (task 31 review). Callers
 * therefore never share an AbortError, and one cancelled browser request cannot break a turn.
 */

import { describeError } from "../engine/errors.ts";
import { load as loadLaptop, type Laptop } from "../engine/laptop.ts";
import { runningGames } from "../engine/running.ts";
import type { Config } from "./config.ts";

export type DetectionResult =
  | { readonly ok: true; readonly running: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** The pre-step and the overview route use this shape, so tests can answer without a laptop. */
export type RunningDetector = (signal?: AbortSignal) => Promise<DetectionResult>;

export type LaptopLoader = (path: string, signal?: AbortSignal) => Promise<Laptop>;

/** What the overview route may read without waiting for SSH. */
export interface DetectionPeek {
  readonly result: DetectionResult | undefined;
  readonly fresh: boolean;
  readonly pending: boolean;
}

/** The two halves the overview needs: the cache now, and a background refresh. */
export interface DetectionSource {
  peek(): DetectionPeek;
  detect(signal?: AbortSignal): Promise<DetectionResult>;
}

const DETECTION = Symbol.for("@local/ffpr-dsh/detection");
const holder = globalThis as unknown as Record<symbol, unknown>;
/** The shared query's own deadline: a caller's turn signal must not end it for everyone. */
const DETECT_TIMEOUT_MS = 30_000;

interface SharedDetection {
  readonly key: string;
  at: number;
  result: DetectionResult | undefined;
  pending: Promise<DetectionResult> | undefined;
}

type DetectionConfig = Pick<Config, "laptopEnv" | "detectCacheMs">;

export function detectionSource(
  config: DetectionConfig,
  load: LaptopLoader = loadLaptop,
): DetectionSource {
  return {
    peek: () => peekDetection(config),
    detect: (signal) => detectRunning(config, signal, load),
  };
}

/**
 * The cached answer, or a new one. `load` is a test seam only: production always uses
 * laptop.ts's loader, so tests can point the same code at fake-ssh without touching the laptop.
 */
export async function detectRunning(
  config: DetectionConfig,
  signal?: AbortSignal,
  load: LaptopLoader = loadLaptop,
): Promise<DetectionResult> {
  const shared = sharedDetection(config);
  const cached = shared.result;
  if (cached !== undefined && Date.now() - shared.at < config.detectCacheMs) return cached;
  let pending = shared.pending;
  if (pending === undefined) {
    pending = (async () => {
      try {
        const result = await query(config, load);
        shared.result = result;
        shared.at = Date.now();
        return result;
      } finally {
        shared.pending = undefined;
      }
    })();
    shared.pending = pending;
  }
  return waitFor(pending, signal);
}

/** No SSH, no waiting: the last answer (even stale) and whether it is still fresh. */
export function peekDetection(config: DetectionConfig): DetectionPeek {
  const shared = holder[DETECTION] as SharedDetection | undefined;
  if (shared?.key !== config.laptopEnv) {
    return { result: undefined, fresh: false, pending: false };
  }
  return {
    result: shared.result,
    fresh: shared.result !== undefined && Date.now() - shared.at < config.detectCacheMs,
    pending: shared.pending !== undefined,
  };
}

function sharedDetection(config: DetectionConfig): SharedDetection {
  const existing = holder[DETECTION] as SharedDetection | undefined;
  if (existing?.key === config.laptopEnv) return existing;
  const created: SharedDetection = {
    key: config.laptopEnv,
    at: 0,
    result: undefined,
    pending: undefined,
  };
  holder[DETECTION] = created;
  return created;
}

/**
 * The query does not take the caller's signal: it uses its own 30-second deadline, so a
 * cancelled turn or a closed overview request cannot abort the SSH call everyone waits on.
 */
async function query(config: DetectionConfig, load: LaptopLoader): Promise<DetectionResult> {
  const signal = AbortSignal.timeout(DETECT_TIMEOUT_MS);
  try {
    const laptop = await load(config.laptopEnv, signal);
    return { ok: true, running: await runningGames(laptop, signal) };
  } catch (error) {
    return {
      ok: false,
      error: `查不了笔记本上开着哪一作:${describeError(error)}`,
    };
  }
}

/** Wait for the shared answer, but let this caller's own cancellation end only its wait. */
function waitFor(
  pending: Promise<DetectionResult>,
  signal: AbortSignal | undefined,
): Promise<DetectionResult> {
  if (signal === undefined) return pending;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<DetectionResult>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
    if (signal.aborted) onAbort();
  });
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException("操作已取消", "AbortError");
}

/** Tests with different fake laptops must not inherit the previous test's cached answer. */
export function resetDetection(): void {
  holder[DETECTION] = undefined;
}
