/**
 * A battle the tests can fight with keys: a small state machine shaped like the bridge's
 * `battlemenu` (command list → magic/item list → target cursor), with party HP, MP, statuses,
 * the bag and the battle's item list. Each confirmed command becomes one recorded action and
 * hands the turn to the next living member.
 *
 * The menu keeps `menuState` at CommandSelecting while a magic/item list is open, exactly as
 * the bridge does; `commandReady` in skills/battle.ts is what notices the open list.
 */

import type { Fields, Reply } from "../src/engine/pilot.ts";
import { battleUnits } from "../src/engine/battle-record.ts";
import { FakePilot } from "./fake-pilot.ts";

export interface BattleMember {
  readonly name: string;
  hp: number;
  readonly maxHp: number;
  mp: number;
  status: string[];
  readonly spells?: readonly string[];
}

export interface BattleEnemy {
  readonly name: string;
  readonly id: number;
  hp: number;
  readonly maxHp: number;
  readonly boss?: boolean;
}

export interface BattleAction {
  readonly actor: string;
  readonly command: string;
  readonly ability: string;
  readonly target: string;
  readonly item: string;
}

export interface FakeBattleOptions {
  readonly party: readonly BattleMember[];
  readonly enemies: readonly BattleEnemy[];
  readonly items?: readonly { readonly name: string; readonly count: number }[];
  readonly maxTurns?: number;
  /** The first N item commands lose their Enter, as the game's list inputWait can (task 41). */
  readonly itemOpenFailures?: number;
  /** Keep the target down after a phoenix down, to model a command still queued in the ATB. */
  readonly reviveOnUse?: boolean;
}

type Phase = "command" | "items" | "ability" | "enemy" | "ally";

export class FakeBattle {
  readonly pilot = new FakePilot();
  readonly party: BattleMember[];
  readonly enemies: BattleEnemy[];
  readonly actions: BattleAction[] = [];
  readonly bag: { name: string; count: number }[];
  itemOpens = 0;
  private readonly maxTurns: number;
  private itemOpenFailures: number;
  private readonly reviveOnUse: boolean;
  private phase: Phase = "command";
  private actorIndex = 0;
  private cursor = 0;
  private itemCursor = 0;
  private abilityCursor = 0;
  private targetCursor = 0;
  private waiting = false;
  private ended = false;
  private defence = false;
  private pending: "item" | "spell" | null = null;

  constructor(options: FakeBattleOptions) {
    this.party = options.party.map((member) => ({
      ...member,
      status: [...member.status],
      spells: [...(member.spells ?? [])],
    }));
    this.enemies = options.enemies.map((enemy) => ({ ...enemy }));
    this.bag = (options.items ?? []).map((item) => ({ ...item }));
    this.maxTurns = options.maxTurns ?? 6;
    this.itemOpenFailures = options.itemOpenFailures ?? 0;
    this.reviveOnUse = options.reviveOnUse ?? true;
    this.pilot.onQuery("battlemenu", () => ({ battlemenu: this.menu() }));
    this.pilot.onQuery("items", () => ({
      items: {
        normal: this.bag.map((item) => ({ name: item.name, count: item.count })),
        important: [],
      },
    }));
    this.pilot.on("keys", (fields) => {
      for (const key of keysOf(fields)) this.press(key);
      return { ok: true };
    });
  }

  /** The member whose turn it is now (the first living one initially). */
  get actor(): string {
    return this.party[this.actorIndex]?.name ?? "";
  }

  itemCount(name: string): number {
    return this.bag.find((item) => item.name === name)?.count ?? 0;
  }

  private endedNow(): boolean {
    return this.ended || this.actions.length >= this.maxTurns;
  }

  private nextActor(): void {
    for (let step = 1; step <= this.party.length; step++) {
      const index = (this.actorIndex + step) % this.party.length;
      const member = this.party[index];
      if (member !== undefined && member.hp > 0) {
        this.actorIndex = index;
        return;
      }
    }
  }

  private menu(): Reply {
    if (this.endedNow()) return { battle: false };
    const common: Record<string, unknown> = {
      battle: true,
      menuState: "CommandSelecting",
      actor: this.actor,
      commands: this.commands(),
      commandState: this.defence ? "Defence" : "CommandSelecting",
      cursor: this.cursor,
      players: this.party.map((member) => ({
        name: member.name,
        hp: member.hp,
        maxHp: member.maxHp,
        mp: member.mp,
        status: member.status,
      })),
      enemies: this.enemies.map((enemy) => ({
        name: enemy.name,
        id: enemy.id,
        hp: enemy.hp,
        maxHp: enemy.maxHp,
        boss: enemy.boss === true,
      })),
    };
    if (this.waiting) {
      // One reading without the command list: the game is between turns / animating.
      this.waiting = false;
      return {
        battle: true,
        menuState: "Waiting",
        actor: null,
        players: common.players,
        enemies: common.enemies,
      };
    }
    if (this.phase === "items") {
      common.itemState = "UseSelect";
      common.items = this.bag.map((item) => ({ name: item.name, count: item.count }));
      common.itemCursor = this.itemCursor;
    }
    if (this.phase === "ability") {
      const spells = this.party[this.actorIndex]?.spells ?? [];
      common.abilityState = "AbilitySelecting";
      common.abilities = spells.map((name, index) => ({ id: index + 1, name, mp: 2 }));
      common.shown = common.abilities;
      common.abilityCursor = this.abilityCursor;
    }
    if (this.phase === "enemy") common.target = { state: "Enemys", cursor: this.targetCursor };
    if (this.phase === "ally") common.target = { state: "Players", cursor: this.targetCursor };
    return common;
  }

  private commands(): Reply[] {
    if (this.defence) return [{ name: "防御", enabled: true }];
    const spells = this.party[this.actorIndex]?.spells ?? [];
    const list: Reply[] = [
      { name: "攻击", enabled: true },
      { name: "道具", enabled: true },
    ];
    if (spells.length > 0) list.push({ name: "白魔法", enabled: true });
    return list;
  }

  private press(key: string): void {
    if (this.endedNow()) return;
    if (this.phase === "command") {
      this.pressCommand(key);
      return;
    }
    if (key === "Backspace") {
      this.phase = "command";
      this.targetCursor = 0;
      this.pending = null;
      return;
    }
    if (this.phase === "items") {
      this.pressItems(key);
      return;
    }
    if (this.phase === "ability") {
      this.pressAbility(key);
      return;
    }
    this.pressTarget(key);
  }

  private pressCommand(key: string): void {
    const commands = this.commands();
    // 防御 sits behind Right on the command list (bridge commandState Defence), 10-20.
    if (key === "Right" && !this.defence) {
      this.defence = true;
      this.cursor = 0;
      return;
    }
    if (key === "Down" || key === "Right") {
      this.cursor = Math.min(commands.length - 1, this.cursor + 1);
      return;
    }
    if (key === "Up" || key === "Left") {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (key !== "Enter") return;
    const command = commands[this.cursor]?.name;
    if (command === "攻击") {
      this.phase = "enemy";
      this.targetCursor = 0;
    } else if (command === "道具") {
      this.itemOpens += 1;
      if (this.itemOpenFailures > 0) {
        this.itemOpenFailures -= 1;
        return;
      }
      this.phase = "items";
      this.itemCursor = 0;
    } else if (command === "白魔法") {
      this.phase = "ability";
      this.abilityCursor = 0;
    } else if (command === "防御") {
      this.finish("防御", "", this.actor);
    }
  }

  private pressItems(key: string): void {
    if (key === "Down" || key === "Right") {
      this.itemCursor = Math.min(this.bag.length - 1, this.itemCursor + 1);
      return;
    }
    if (key === "Up" || key === "Left") {
      this.itemCursor = Math.max(0, this.itemCursor - 1);
      return;
    }
    if (key !== "Enter") return;
    const item = this.bag[this.itemCursor];
    if (item === undefined || item.count <= 0) return;
    this.phase = "ally";
    this.pending = "item";
    this.targetCursor = this.actorIndex;
  }

  private pressAbility(key: string): void {
    const spells = this.party[this.actorIndex]?.spells ?? [];
    if (key === "Down" || key === "Right") {
      this.abilityCursor = Math.min(spells.length - 1, this.abilityCursor + 1);
      return;
    }
    if (key === "Up" || key === "Left") {
      this.abilityCursor = Math.max(0, this.abilityCursor - 1);
      return;
    }
    if (key !== "Enter") return;
    this.phase = "ally";
    this.pending = "spell";
    this.targetCursor = this.actorIndex;
  }

  private pressTarget(key: string): void {
    const count = this.phase === "enemy" ? this.enemies.length : this.party.length;
    if (key === "Down" || key === "Right") {
      this.targetCursor = Math.min(count - 1, this.targetCursor + 1);
      return;
    }
    if (key === "Up" || key === "Left") {
      this.targetCursor = Math.max(0, this.targetCursor - 1);
      return;
    }
    if (key !== "Enter") return;
    if (this.phase === "enemy") {
      const enemy = this.enemies[this.targetCursor];
      if (enemy !== undefined) {
        enemy.hp = Math.max(0, enemy.hp - 10);
        this.finish("攻击", "", enemy.name);
      }
      return;
    }
    if (this.pending === "item") {
      this.useItem();
      return;
    }
    this.castSpell();
  }

  private useItem(): void {
    const item = this.bag[this.itemCursor];
    const target = this.party[this.targetCursor];
    if (item === undefined || target === undefined || item.count <= 0) return;
    item.count -= 1;
    if (item.name.includes("不死鸟") || item.name.includes("凤凰")) {
      if (target.hp <= 0 && this.reviveOnUse) {
        target.hp = Math.max(1, Math.floor(target.maxHp / 4));
        target.status = target.status.filter((status) => !status.includes("战斗不能"));
      }
    } else if (item.name.includes("恢复药")) {
      target.hp = Math.min(target.maxHp, target.hp + 50);
    } else {
      for (const [ailment, [, cure]] of Object.entries(CURES)) {
        if (cure !== "" && (item.name.includes(cure) || cure.includes(item.name))) {
          target.status = target.status.filter((status) => !status.includes(ailment));
        }
      }
    }
    this.finish("道具", item.name, target.name);
  }

  private castSpell(): void {
    const spells = this.party[this.actorIndex]?.spells ?? [];
    const spell = spells[this.abilityCursor] ?? "";
    const target = this.party[this.targetCursor];
    if (target === undefined) return;
    if (spell === "治疗" || spell === "救疗") {
      target.hp = Math.min(target.maxHp, target.hp + 30);
    } else if (spell === "复活") {
      target.hp = Math.max(1, Math.floor(target.maxHp / 4));
    } else if (spell === "魔法护盾") {
      if (!target.status.includes("魔法护盾")) target.status.push("魔法护盾");
    }
    this.finish("白魔法", spell, target.name);
  }

  private finish(command: string, ability: string, target: string): void {
    this.actions.push({
      actor: this.actor,
      command,
      ability,
      target,
      item: command === "道具" ? ability : "",
    });
    this.phase = "command";
    this.cursor = 0;
    this.targetCursor = 0;
    this.pending = null;
    this.defence = false;
    this.waiting = true;
    this.nextActor();
  }
}

function keysOf(fields: Fields): string[] {
  const raw = fields.keys;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const spec of raw) {
    if (typeof spec !== "string") continue;
    const [key = "", count] = spec.split("*");
    for (let i = 0; i < (count === undefined ? 1 : Number(count)); i++) out.push(key);
  }
  return out;
}

const CURES: Readonly<Record<string, readonly [string | null, string]>> = {
  毒: ["解毒", "解毒药"],
  黑暗: [null, "眼药"],
  石化: [null, "金针"],
  青蛙: [null, "少女之吻"],
  迷你: [null, "木槌"],
  沉默: [null, "回音草"],
};

/** The rows battle-record expects, for building a session around a FakeBattle. */
export function battleRows(battle: FakeBattle): {
  readonly players: readonly Record<string, unknown>[];
  readonly enemies: readonly Record<string, unknown>[];
} {
  return {
    players: battle.party.map((member) => ({
      name: member.name,
      hp: member.hp,
      maxHp: member.maxHp,
      mp: member.mp,
      status: member.status,
    })),
    enemies: battle.enemies.map((enemy) => ({
      name: enemy.name,
      id: enemy.id,
      hp: enemy.hp,
      maxHp: enemy.maxHp,
      boss: enemy.boss === true,
    })),
  };
}

/** The same rows as BattleUnits, for BattleLog.start. */
export function startRows(battle: FakeBattle): {
  readonly party: ReturnType<typeof battleUnits>;
  readonly enemies: ReturnType<typeof battleUnits>;
} {
  const rows = battleRows(battle);
  return { party: battleUnits(rows.players), enemies: battleUnits(rows.enemies) };
}
