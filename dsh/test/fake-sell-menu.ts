/**
 * A scripted shop sell list for tests, shaped like the bridge's shop reply
 * (GameState.Menus.cs ShopMenu): Sell command → the bag's item grid → quantity. It reuses the
 * 11-10 item-grid movement, because the sell list is inferred to be the same two-column grid.
 */

import type { Fields, Reply } from "../src/engine/pilot.ts";
import type { FakePilot } from "./fake-pilot.ts";
import { moveGridCursor } from "./fake-item-menu.ts";

export interface FakeSellItem {
  readonly name: string;
  count: number;
  readonly price: number;
}

export interface FakeSellMenuOptions {
  readonly items: readonly FakeSellItem[];
  readonly gil?: number;
  readonly columns?: number;
}

type Stage = "command" | "list" | "trade";

export class FakeSellMenu {
  readonly items: FakeSellItem[];
  readonly columns: number;
  gil: number;
  stage: Stage = "command";
  commandCursor = 0;
  listCursor = 0;
  tradeCount = 1;

  constructor(options: FakeSellMenuOptions) {
    this.items = options.items.map((item) => ({ ...item }));
    this.columns = options.columns ?? 2;
    this.gil = options.gil ?? 1000;
  }

  install(pilot: FakePilot): void {
    pilot.on("pos", { pos: { state: "Player" } });
    pilot.on("wait", { ok: true });
    pilot.on("leave", { ok: true, presses: 1 });
    pilot.on("keys", (fields) => this.press(fields));
    pilot.onQuery("shop", () => ({ shop: this.shop() }));
    pilot.onQuery("sample", () => ({ sample: { user: { gil: this.gil } } }));
  }

  private press(fields: Fields): Reply {
    const raw = fields.keys;
    const keys = Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === "string")
      : [];
    for (const spec of keys) {
      const [key = "", count] = spec.split("*");
      for (let i = 0; i < (count === undefined ? 1 : Number(count)); i++) this.step(key);
    }
    return { ok: true };
  }

  private step(key: string): void {
    if (key === "Backspace") {
      this.stage = "command";
      return;
    }
    if (this.stage === "command") {
      if (key === "Down") this.commandCursor = Math.min(1, this.commandCursor + 1);
      if (key === "Up") this.commandCursor = Math.max(0, this.commandCursor - 1);
      if (key === "Enter" && this.commandCursor === 1) this.stage = "list";
    } else if (this.stage === "list") {
      this.listCursor = moveGridCursor(this.listCursor, key, this.items.length, this.columns);
      if (key === "Enter") {
        this.tradeCount = 1;
        this.stage = "trade";
      }
    } else {
      const item = this.items[this.listCursor];
      const most = item?.count ?? 1;
      if (key === "Right") this.tradeCount = Math.min(most, this.tradeCount + 1);
      if (key === "Left") this.tradeCount = Math.max(1, this.tradeCount - 1);
      if (key === "Enter" && item !== undefined) {
        const sold = Math.min(this.tradeCount, item.count);
        item.count -= sold;
        this.gil += sold * item.price;
        this.stage = "command";
      }
    }
  }

  private shop(): Reply {
    const list = this.stage === "command" ? null : this.rows();
    return {
      open: true,
      state: this.stage === "command" ? "SelectCommand" : "SelectSellItem",
      commands: ["Buy", "Sell"],
      commandCursor: this.commandCursor,
      rows: list,
      cursor: list === null ? null : this.listCursor,
      listCursor: list === null ? null : this.listCursor,
      trade:
        this.stage === "trade"
          ? {
              count: this.tradeCount,
              max: this.items[this.listCursor]?.count ?? 1,
              price: this.items[this.listCursor]?.price ?? 0,
            }
          : null,
    };
  }

  private rows(): Reply[] {
    return this.items.map((item, index) => ({
      name: `<IC_ITEM>${item.name}`,
      price: `${item.price}`,
      have: `${item.count}`,
      canSelect: item.count > 0,
      focus: index === this.listCursor,
    }));
  }
}
