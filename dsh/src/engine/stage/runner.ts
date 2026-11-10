/**
 * The engine's narrow view of the stage officer (task 97, 11-10). `plugin/stage-officer.ts`
 * owns the dsh subagent; Game only hands it the fact sheet and accepts the checked plan, so
 * the engine never imports a dsh package.
 */

import type { StageFacts, StagePlan } from "./types.ts";

export interface StageOfficerAnswer {
  readonly plan: StagePlan;
  readonly problems: readonly string[];
  readonly text: string;
}

export type StageOfficerRunner = (
  facts: StageFacts,
  factsText: string,
  signal: AbortSignal,
) => Promise<StageOfficerAnswer>;
