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
