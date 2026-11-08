/**
 * Strategy language 2.0 (battle strategy plan §6): the snapshot the expressions read and the
 * shaped JSON the parser returns. Pure data only; no I/O and no battle execution.
 *
 *     const snapshot: BattleSnapshot = { allies, enemies, actor: "蕾娜", turn: 3, ... };
 *     const target = resolveTarget("ally.lowest(hp_pct)", snapshot);
 */

export type Side = "ally" | "enemy";

/** One battle unit; `hp <= 0` means fallen. Names and statuses are the game's Chinese words. */
export interface SnapshotUnit {
  readonly name: string;
  /** The battle form's number (`enemy(282)`), when the bridge knows it. */
  readonly id?: number;
  readonly hp: number;
  readonly maxHp?: number;
  readonly mp?: number;
  readonly maxMp?: number;
  /** Ailments and buffs the unit has, in Chinese; `has()` reads both. */
  readonly status?: readonly string[];
  /** Positive buffs kept apart from ailments by the bridge; `has()` reads both. */
  readonly buffs?: readonly string[];
  readonly weak?: readonly string[];
  readonly absorbs?: readonly string[];
  /** Elements and statuses the unit is immune to. */
  readonly immune?: readonly string[];
  readonly boss?: boolean;
}

/**
 * What a unit did, oldest first. `used()` reads the unit's latest action (all events sharing
 * its timestamp, so a spell and its counter count as one action); with a seconds window it
 * reads any matching event in that window instead.
 */
export interface BattleEvent {
  /** Battle seconds; events without a time still count as the latest action. */
  readonly at?: number;
  readonly actor: string;
  readonly target?: string;
  readonly ability: string;
  readonly magic?: boolean;
  readonly countered?: boolean;
}

/** One reading of the battle. The next task fills this from the battle menu and bridge events. */
export interface BattleSnapshot {
  readonly allies: readonly SnapshotUnit[];
  readonly enemies: readonly SnapshotUnit[];
  readonly items?: Readonly<Record<string, number>>;
  /** The ally whose turn it is; `self` resolves to this unit. */
  readonly actor?: string;
  /** How many times the actor has acted, from 1. */
  readonly turn?: number;
  /** Seconds since the battle started. */
  readonly seconds?: number;
  /** Whether this is a boss battle; `battle.boss` falls back to an enemy's boss flag. */
  readonly boss?: boolean;
  /** The game's MonsterParty.NotEscape: the party cannot run from this encounter. */
  readonly notEscape?: boolean;
  readonly events?: readonly BattleEvent[];
}

export interface StrategyRule {
  readonly who: string;
  readonly if?: string;
  readonly do: string;
  readonly to?: string;
  readonly once?: boolean;
  readonly note?: string;
}

/** A reaction is a rule plus `on`; `on` is checked before the phase's `if`. */
export interface StrategyReaction extends StrategyRule {
  readonly on: string;
}

export interface StrategyPhase {
  readonly name: string;
  /** Absent means always. */
  readonly when?: string;
  readonly note?: string;
  readonly rules: readonly StrategyRule[];
}

export interface Strategy {
  readonly version: 2;
  readonly summary?: string;
  /** Character → free-text role. Rules may use a role's text as `who`. */
  readonly roles: Readonly<Record<string, string>>;
  readonly reactions: readonly StrategyReaction[];
  /** `phases` and `rules` are exclusive; whichever is unused stays empty. */
  readonly phases: readonly StrategyPhase[];
  readonly rules: readonly StrategyRule[];
}

/** A malformed strategy or an expression that cannot be evaluated. The message is Chinese. */
export class StrategyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyError";
  }
}
