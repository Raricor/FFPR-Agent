/**
 * A scripted field item menu for skill tests, shaped like the bridge's `menu.item`
 * (GameState.Menus.cs ItemMenu): command → item list → target. `FakePilot` answers the pilot's
 * keys and queries from this little state machine, so a test presses through the real flow.
 */

import type { Fields, Reply } from "../src/engine/pilot.ts";
import type { FakePilot } from "./fake-pilot.ts";

export interface FakeItem {
  readonly name: string;
  count: number;
}

export interface FakeMember {
  readonly name: string;
  hp: number;
  readonly maxHp: number;
  readonly mp?: number;
  status?: string[];
  readonly jobName?: string;
}

export interface FakeItemMenuOptions {
  readonly items: readonly FakeItem[];
  readonly members: readonly FakeMember[];
  readonly target: string;
  readonly targetStatus?: string;
  readonly targetMode?: string;
  readonly area?: string;
  readonly icon?: string;
  /** Cells per row (11-10: the field item list is two columns). */
  readonly columns?: number;
  /** Where the cursor starts; the end, to test steering back and wrapping. */
  readonly cursor?: number;
  /** Keep the list cursor where it is, to test the failure diagnostic. */
  readonly stuck?: boolean;
}

type Stage = "closed" | "top" | "command" | "list" | "target" | "done";

/**
 * 11-10's real-machine rules: Down/Up move a whole row (+/- columns) and wrap at the bottom,
 * Right/Left move one cell and change row when they cross an edge. The last row may be short,
 * so a vertical move skips past rows that have no cell in that column.
 */
export function moveGridCursor(index: number, key: string, count: number, columns: number): number {
  if (count === 0) return index;
  if (key === "Right") return (index + 1) % count;
  if (key === "Left") return (index - 1 + count) % count;
  if (key !== "Down" && key !== "Up") return index;
  const rows = Math.ceil(count / columns);
  const col = index % columns;
  const step = key === "Down" ? 1 : -1;
  let row = Math.floor(index / columns) + step;
  if (row < 0) row = rows - 1;
  if (row >= rows) row = 0;
  for (let guard = 0; guard < rows; guard++) {
    const width = Math.min(columns, count - row * columns);
    if (col < width) return row * columns + col;
    row += step;
    if (row < 0) row = rows - 1;
    if (row >= rows) row = 0;
  }
  return index;
}

export class FakeItemMenu {
  readonly items: FakeItem[];
  readonly members: FakeMember[];
  readonly target: string;
  readonly targetStatus: string | undefined;
  readonly targetMode: string;
  readonly area: string;
  readonly icon: string;
  readonly columns: number;
  readonly stuck: boolean;
  stage: Stage = "closed";
  topCursor = 0;
  commandCursor = 0;
  listCursor: number;
  targetCursor = 0;

  constructor(options: FakeItemMenuOptions) {
    this.items = options.items.map((item) => ({ ...item }));
    this.members = options.members.map((member) => ({
      ...member,
      status: [...(member.status ?? [])],
    }));
    this.target = options.target;
    this.targetStatus = options.targetStatus;
    this.targetMode = options.targetMode ?? "Single";
    this.area = options.area ?? "卡文镇";
    this.icon = options.icon ?? "<IC_ITEM>";
    this.columns = options.columns ?? 2;
    this.stuck = options.stuck === true;
    this.listCursor = options.cursor ?? 0;
  }

  install(pilot: FakePilot): void {
    pilot.on("pos", { pos: { state: "Player" } });
    pilot.on("wait", { ok: true });
    pilot.on("leave", { ok: true, presses: 1 });
    pilot.on("keys", (fields) => this.press(fields));
    pilot.onQuery("menu", () => ({ menu: this.menu() }));
    pilot.onQuery("sample", () => ({
      sample: { party: this.members, user: { areaText: this.area } },
    }));
    pilot.onQuery("items", () => ({
      items: {
        normal: this.items.map((item) => ({ name: `${this.icon}${item.name}`, count: item.count })),
        important: [],
      },
    }));
  }

  private press(fields: Fields): Reply {
    const raw = fields.keys;
    const keys = Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === "string")
      : [];
    for (const spec of keys) {
      const [key = "", count] = spec.split("*");
      const times = count === undefined ? 1 : Number(count);
      for (let i = 0; i < times; i++) this.step(key);
    }
    return { ok: true };
  }

  private step(key: string): void {
    if (key === "Tab") {
      this.stage = "top";
      return;
    }
    if (key === "Backspace") {
      this.stage =
        this.stage === "target"
          ? "list"
          : this.stage === "list"
            ? "command"
            : this.stage === "command"
              ? "top"
              : "closed";
      return;
    }
    if (this.stage === "top") {
      if (key === "Down") this.topCursor = Math.min(1, this.topCursor + 1);
      if (key === "Up") this.topCursor = Math.max(0, this.topCursor - 1);
      if (key === "Enter" && this.topCursor === 1) this.stage = "command";
    } else if (this.stage === "command") {
      if (key === "Down") this.commandCursor = Math.min(2, this.commandCursor + 1);
      if (key === "Up") this.commandCursor = Math.max(0, this.commandCursor - 1);
      if (key === "Enter" && this.commandCursor === 0) this.stage = "list";
    } else if (this.stage === "list") {
      if (!this.stuck) this.moveList(key);
      if (key === "Enter") this.stage = "target";
    } else if (this.stage === "target") {
      if (key === "Down")
        this.targetCursor = Math.min(this.members.length - 1, this.targetCursor + 1);
      if (key === "Up") this.targetCursor = Math.max(0, this.targetCursor - 1);
      if (key === "Enter") this.consume();
    }
  }

  private moveList(key: string): void {
    this.listCursor = moveGridCursor(this.listCursor, key, this.items.length, this.columns);
  }

  private selectedName(): string {
    return this.items[this.listCursor]?.name ?? "";
  }

  private consume(): void {
    const item = this.items[this.listCursor];
    if (item !== undefined && item.count > 0) item.count -= 1;
    const member = this.members.find((entry) => entry.name === this.target);
    if (member !== undefined && this.targetStatus !== undefined) {
      member.status = (member.status ?? []).filter((status) => status !== this.targetStatus);
    }
    this.stage = "done";
  }

  private menu(): Reply {
    const screens: Record<Stage, () => Reply> = {
      closed: () => ({ open: false }),
      top: () => ({
        open: true,
        state: "Command",
        commands: [
          { id: "Magic", name: "魔法" },
          { id: "Item", name: "道具" },
        ],
        cursor: this.topCursor,
      }),
      command: () => ({
        open: true,
        state: "Command",
        commands: [
          { id: "Magic", name: "魔法" },
          { id: "Item", name: "道具" },
        ],
        cursor: this.topCursor,
        item: { state: "CommandSelect", commandCursor: this.commandCursor, rows: [] },
      }),
      list: () => ({
        open: true,
        state: "Item",
        item: {
          state: "UseSelect",
          commandCursor: this.commandCursor,
          rows: this.itemRows(),
          listCursor: this.listCursor,
          selected: this.selectedName(),
        },
      }),
      target: () => ({
        open: true,
        state: "Item",
        item: {
          state: "TargetSelect",
          commandCursor: this.commandCursor,
          rows: this.itemRows(),
          listCursor: this.listCursor,
          selected: this.selectedName(),
          targets: this.members.map((member) => ({
            name: member.name,
            hp: member.hp,
            maxHp: member.maxHp,
            mp: member.mp ?? 0,
          })),
          targetCursor: this.targetCursor,
          targetMode: this.targetMode,
        },
      }),
      done: () => this.menuOfTarget(),
    };
    return screens[this.stage]();
  }

  private menuOfTarget(): Reply {
    return {
      open: true,
      state: "Item",
      item: {
        state: "TargetSelect",
        rows: this.itemRows(),
        listCursor: this.listCursor,
        selected: this.selectedName(),
        targets: this.members.map((member) => ({
          name: member.name,
          hp: member.hp,
          maxHp: member.maxHp,
          mp: member.mp ?? 0,
        })),
        targetCursor: this.targetCursor,
        targetMode: this.targetMode,
      },
    };
  }

  private itemRows(): Reply[] {
    return this.items.map((item) => ({
      name: `${this.icon}${item.name}`,
      count: item.count,
    }));
  }
}
