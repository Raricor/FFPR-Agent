/**
 * The real `ExecutePorts` (task 138): the segment executor talks only to this adapter, and the
 * adapter talks only to Game's public plan ports. Keeping it here means the executor has no
 * dependency on the bridge, the laptop or dsh and can be tested with doubles.
 *
 * `begin` suspends the tactician and the stage officer for the whole run, so a plan that takes
 * an hour makes zero model calls. `end` puts them back even when the executor throws.
 */

import type { Cell } from "../nav.ts";
import type { Game } from "../game.ts";
import type { Pilot } from "../pilot.ts";
import type { RoutePlan, Waypoint } from "../route/types.ts";
import * as gambit from "../skills/gambit.ts";
import { isStoryTriggerEvent } from "../skills/move.ts";
import { checkStrategy } from "../strategy/strategy.ts";
import { isRecord, record, records, text, truthy, type Json } from "../values.ts";
import type {
  ExecutePorts,
  PlanActionResult,
  PlanBossResult,
  PlanBuyResult,
  PlanExitTarget,
  PlanProgressStatus,
  PlanRestorePoint,
  PlanScene,
  PlanStationResult,
  PlanStoryTrigger,
} from "./execute.ts";
import type { PlanBattle, PlanBoss } from "./types.ts";

/** `set_tactics`'s rule: a version 2 strategy is stored as written, an old table normalized. */
function normalizeTable(game: Game, raw: Json): Json {
  if (raw.version === 2) {
    const problems = checkStrategy(raw);
    if (problems.length > 0) throw new Error(`策略 v2 没通过检查:${problems.join(";")}`);
    return raw;
  }
  const normalized = gambit.normalize(raw);
  const problems = gambit.check(normalized, game.game);
  if (problems.length > 0) throw new Error(`战斗表没通过检查:${problems.join(";")}`);
  return normalized;
}

function normalizeBattle(game: Game, battle: PlanBattle): PlanBattle {
  return {
    maps: [...battle.maps],
    tables: battle.tables.map((table) => normalizeTable(game, table)),
  };
}

function normalizeBoss(game: Game, boss: PlanBoss): PlanBoss {
  return {
    ...boss,
    tables: boss.tables.map((table) => normalizeTable(game, table)),
  };
}

function entityCell(entity: Json): Cell | null {
  if (!isRecord(entity)) return null;
  const cell = entity.cell;
  if (!Array.isArray(cell) || cell.length < 2) return null;
  const x: unknown = cell[0];
  const y: unknown = cell[1];
  return typeof x === "number" && typeof y === "number" ? [x, y] : null;
}

function sameCell(left: Cell | null, right: Cell): boolean {
  return left !== null && left[0] === right[0] && left[1] === right[1];
}

/** Build the real ports for one `executeSegmentPlan` run. */
export function gamePlanPorts(game: Game, pilot: Pilot): ExecutePorts {
  let restore: (() => void) | null = null;
  return {
    begin(): void {
      restore = game.suspendModelLayers();
    },
    end(): void {
      restore?.();
      restore = null;
    },

    position: async () => await game.planPosition(pilot),
    observe: async (refresh = false) => await game.planObservation(pilot, refresh),

    changeJob: async (member, job, abilities): Promise<PlanActionResult> =>
      await game.planChangeJob(pilot, member, job, abilities),
    optimizeEquipment: async (): Promise<PlanActionResult> => {
      const [ok, text] = await game.optimizeEquipment(pilot);
      return { ok, text };
    },
    shops: async () => await game.planShops(),
    openShop: async (cell): Promise<PlanActionResult> => await game.planOpenShop(pilot, cell),
    leaveShop: async (): Promise<PlanActionResult> => await game.planLeaveShop(pilot),
    buy: async (item, count): Promise<PlanBuyResult> => await game.planBuy(pilot, item, count),
    setRow: (member, row): Promise<PlanActionResult> =>
      Promise.resolve(game.planSetRow(member, row)),

    bossTarget: async (cell, bossName): Promise<"trigger" | "object"> => {
      // The bridge's Event list is the same one `go` uses. An event that names the boss is
      // the boss itself and is faced from a side; a bare `sc_e_`/`ev_e_` scene is stepped on
      // (11-11, Wind Shrine 205).
      const reply = record((await pilot.send("entities", { kind: "Event", max: 200 })).entities);
      const names = records(reply.entities)
        .filter((entity) => sameCell(entityCell(entity), cell))
        .map((entity) => text(entity.name) ?? "");
      if (names.some((name) => bossName !== "" && name.includes(bossName))) return "object";
      return names.some((name) => isStoryTriggerEvent(name)) ? "trigger" : "object";
    },
    battleActive: async (): Promise<boolean> => {
      const sample = record((await pilot.query("sample")).sample);
      const fight = record(sample.battle);
      return truthy(fight.active) || truthy(fight.boss) || records(fight.enemies).length > 0;
    },
    scene: async (): Promise<PlanScene> => await game.planScene(pilot),
    restorePoints: async (): Promise<readonly PlanRestorePoint[]> => await game.planRestorePoints(),
    exitTarget: async (map, cell): Promise<PlanExitTarget | null> =>
      await game.planExitTarget(map, cell),
    mapKnown: async (map): Promise<boolean> => await game.planMapKnown(map),
    eventAt: async (map, cell): Promise<boolean> => await game.planEventAt(pilot, map, cell),
    storyTrigger: async (map, hint): Promise<PlanStoryTrigger> =>
      await game.planStoryTrigger(pilot, map, hint),
    exploreStoryStep: async (map, direction) => await game.planExploreStoryStep(pilot, map, direction),
    choiceOptions: async (): Promise<readonly string[]> => await game.planChoiceOptions(pilot),
    vehicleStatus: async (): Promise<string> => await game.planVehicleStatus(pilot),
    pointAt: async (map, cell): Promise<"restore" | "save" | null> =>
      await game.planPointAt(map, cell),
    savePoints: async (map): Promise<readonly Cell[]> => await game.planSavePoints(map),
    usePoint: async (cell, kind): Promise<PlanStationResult> =>
      await game.planUsePoint(pilot, cell, kind),
    chestAlreadyOpen: async (map, cell): Promise<boolean> =>
      await game.planChestAlreadyOpen(pilot, map, cell),
    bossAliases: async (name): Promise<readonly string[]> => await game.planBossAliases(name),
    bossTriggerCandidates: async (map, boss, hint): Promise<readonly Cell[]> =>
      await game.planBossTriggerCandidates(pilot, map, boss, hint),

    routePorts: () => game.planRoutePorts(pilot),
    planRoute: (
      from: { readonly map: number; readonly cell: readonly [number, number] },
      waypoints: readonly Waypoint[],
      end: Waypoint | null,
    ): Promise<RoutePlan> => Promise.resolve(game.planRoute(from, waypoints, end)),
    interact: async (cell): Promise<PlanStationResult> => await game.planInteract(pilot, cell),
    story: async () => await game.planStory(pilot),
    choose: async (option, cell): Promise<PlanActionResult> =>
      await game.planChoose(pilot, option, cell),
    save: async (): Promise<PlanActionResult> => await game.planSave(pilot),
    heal: async (belowPct?: number): Promise<PlanActionResult> =>
      await game.planHeal(pilot, belowPct),
    restAt: async (point): Promise<PlanActionResult> => await game.planRestAt(pilot, point),
    grind: async (stop): Promise<PlanStationResult> => await game.planGrind(pilot, stop),

    beginBattles: (battles): Promise<void> => {
      game.planBeginBattles(battles.map((battle) => normalizeBattle(game, battle)));
      return Promise.resolve();
    },
    endBattles: (): Promise<void> => {
      game.planEndBattles();
      return Promise.resolve();
    },
    fightBoss: async (boss): Promise<PlanBossResult> =>
      await game.planFightBoss(pilot, normalizeBoss(game, boss)),
    fightNormal: async (tables): Promise<PlanBossResult> =>
      await game.planFightNormal(pilot, tables),
    recoverGameover: async (): Promise<PlanActionResult> => await game.planRecoverGameover(pilot),
    battleCount: () => game.planBattlesFought(),
    leaveNotes: (): Promise<readonly string[]> => Promise.resolve(game.planTakeLeaveNotes()),
    modelCalls: () => game.planModelCalls(),

    startProgress: async (section, goal, labels): Promise<void> => {
      await game.planProgressStart(section, goal, labels);
    },
    markProgress: async (index, status: PlanProgressStatus, note): Promise<void> => {
      await game.planProgressMark(index, status, note);
    },
    finishProgress: async (status): Promise<void> => {
      await game.planProgressFinish(status);
    },
  };
}
