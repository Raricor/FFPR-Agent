/** The pure turn helpers in ask.mjs, typed for the test that imports them. */
export interface AskPromptTurn {
  readonly turn: number;
  readonly seq: number;
}

export function promptTurn(
  events: readonly unknown[],
  requestId: string,
  afterSeq: number,
  promptText: string,
): AskPromptTurn | null;

export function turnEnded(events: readonly unknown[], prompt: AskPromptTurn): boolean;

export function stillRunningLine(sessionId: string, turn: number | null): string;

export interface WaitForTurnEndOptions {
  readonly timeoutMs?: number;
  readonly events?: (sessionId: string) => readonly unknown[];
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface WaitForTurnEndOutcome {
  readonly ended: boolean;
  readonly turn: number | null;
}

export function waitForTurnEnd(
  sessionId: string,
  requestId: string,
  promptText: string,
  afterSeq: number,
  options?: WaitForTurnEndOptions,
): Promise<WaitForTurnEndOutcome>;
