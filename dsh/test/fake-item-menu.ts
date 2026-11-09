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
  /** Rows visible at once. When set, listCursor counts within the window, as in the game. */
  readonly pageSize?: number;
  /** Keep the list cursor where it is, to test the failure diagnostic. */
  readonly stuck?: boolean;
}

type Stage = "closed" | "top" | "command" | "list" | "target" | "done";

export class FakeItemMenu {
  readonly items: FakeItem[];
  readonly members: FakeMember[];
  readonly target: string;
  readonly targetStatus: string | undefined;
  readonly targetMode: string;
  readonly area: string;
  readonly icon: string;
  readonly pageSize: number | undefined;
  readonly stuck: boolean;
  stage: Stage = "closed";
  topCursor = 0;
  commandCursor = 0;
  listCursor = 0;
  visibleOffset = 0;
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
    this.pageSize = options.pageSize;
    this.stuck = options.stuck === true;
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
    const page = this.pageSize;
    if (page === undefined) {
      if (key === "Down") this.listCursor = Math.min(this.items.length - 1, this.listCursor + 1);
      if (key === "Up") this.listCursor = Math.max(0, this.listCursor - 1);
      return;
    }
    const visible = this.visibleOffset + this.listCursor;
    if (key === "Down" && visible < this.items.length - 1) {
      // At the bottom of a page the cursor stays there and the list scrolls underneath it.
      if (this.listCursor < page - 1) this.listCursor += 1;
      else this.visibleOffset += 1;
    }
    if (key === "Up" && visible > 0) {
      if (this.listCursor > 0) this.listCursor -= 1;
      else this.visibleOffset -= 1;
    }
  }

  private visibleIndex(): number {
    return this.pageSize === undefined ? this.listCursor : this.visibleOffset + this.listCursor;
  }

  private selectedName(): string {
    return this.items[this.visibleIndex()]?.name ?? "";
  }

  private consume(): void {
    const item = this.items[this.visibleIndex()];
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
