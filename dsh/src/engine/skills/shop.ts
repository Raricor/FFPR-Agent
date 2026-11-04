/**
 * Buying and selling in an open shop, checked against the shop the bridge reads (0.4.0+).
 * Ported from ffpr_agent/skills/shop.py.
 */

import type { Pilot, Reply } from "../pilot.ts";
import { isRecord, num, records, record, text, truthy } from "../values.ts";
import { moveCursor, pick } from "./cursor.ts";

export const ICON = /^<[^>]+>/;

/** Python's str() for a value the messages embed, so None does not become "undefined". */
function show(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  if (isRecord(value)) {
    const pairs = Object.entries(value).map(([key, item]) => `'${key}': ${show(item)}`);
    return `{${pairs.join(", ")}}`;
  }
  return JSON.stringify(value);
}

function rowsOf(value: unknown): Reply[] | null {
  if (value === null || value === undefined) return null;
  return records(value);
}

export async function shopState(pilot: Pilot): Promise<Reply> {
  return record((await pilot.query("shop")).shop);
}

/** Product types worn by someone. */
export const GEAR: ReadonlySet<string> = new Set(["Weapon", "Armor"]);

/**
 * The members' marks for the highlighted product, once the shop has drawn them; None
 * when the bridge does not read them (before 0.7.0).
 */
export async function waitParty(pilot: Pilot, seconds = 1.0): Promise<Reply[] | null> {
  const deadline = pilot.now() + seconds * 1000;
  let rows: Reply[] | null = null;
  while (pilot.now() < deadline) {
    rows = rowsOf((await shopState(pilot)).party);
    if (rows !== null && rows.length > 0) return rows;
    await pilot.sleep(150);
  }
  return rows;
}

/** 「巴兹 更强、加拉夫 已装备、蕾娜 不能装备」 from the shop's marks. */
export function whoCan(rows: Reply[]): string {
  const mark = (row: Reply): string => {
    if (!truthy(row.canEquip)) return "不能装备";
    if (truthy(row.equipped)) return "已经装着";
    if (truthy(row.up)) return "更强";
    return truthy(row.down) ? "更弱" : "差不多";
  };
  return rows.map((row) => `${show(row.name)} ${mark(row)}`).join("、");
}

/**
 * Every weapon and piece of armour in the open shop, with who can wear it and who would
 * be stronger, read off the shop as each one is highlighted.
 */
export async function gearReport(pilot: Pilot): Promise<[boolean, string]> {
  let shop = await shopState(pilot);
  if (!truthy(shop.open)) return [false, "商店没有打开:先和店员说话"];
  const opened = await openProducts(pilot, shop);
  if (opened === null) return [false, "没能打开购买列表"];
  shop = opened;
  const lines: string[] = [];
  let at = num(shop.listCursor) ?? 0;
  const products = records(shop.products);
  for (let i = 0; i < products.length; i++) {
    const product = products[i] ?? {};
    if (typeof product.type !== "string" || !GEAR.has(product.type)) continue;
    await moveCursor(pilot, at, i);
    at = i;
    const rows = await waitParty(pilot);
    if (rows === null) return [false, "桥插件早于 0.7.0,读不到谁能装备"];
    const name = iconName(product.name);
    lines.push(`${name} ${show(product.buy)} 金币:${whoCan(rows)}`);
  }
  return [true, lines.join("\n") || "这家店没有武器和防具"];
}

function iconName(value: unknown): string {
  return (text(value) ?? "").replace(ICON, "");
}

export async function gil(pilot: Pilot): Promise<number | null> {
  const sample = record(record((await pilot.query("sample")).sample).user);
  return num(sample.gil) ?? null;
}

/**
 * In an open shop: Buy → the product (by name) → quantity → confirm. Every step is checked
 * against the shop state the bridge (0.4.0+) reads, and the result against the gil.
 */
export async function buy(pilot: Pilot, product: string, count = 1): Promise<[boolean, string]> {
  let shop = await shopState(pilot);
  if (!truthy(shop.open)) return [false, "商店没有打开:先和店员说话"];
  const products = records(shop.products);
  const names = products.map((entry) => text(entry.name));
  const index = pick(names, product);
  if (index === null) {
    return [false, `这家店没有「${product}」,有:${names.filter(Boolean).join("、")}`];
  }
  const first = products[index];
  const gear = first !== undefined && typeof first.type === "string" && GEAR.has(first.type);
  const opened = await openProducts(pilot, shop);
  if (opened === null) return [false, "没能打开购买列表"];
  shop = opened;
  await moveCursor(pilot, num(shop.listCursor) ?? 0, index);
  let note = "";
  if (gear) {
    // Weapons and armour: as many as members who can wear it and would be stronger
    // (bridge 0.7.0 reads the shop's own marks; 10-21: four of each bought, some for
    // nobody).
    const rows = await waitParty(pilot);
    if (rows !== null) {
      const useful = rows
        .filter((row) => truthy(row.canEquip) && truthy(row.up))
        .map((row) => show(row.name));
      if (useful.length === 0) {
        return [false, `不买「${show(names[index])}」:${whoCan(rows)},没有人用得上`];
      }
      if (count > useful.length) {
        note = `(只买 ${useful.length} 件:用得上的只有 ${useful.join("、")})`;
        count = useful.length;
      }
    }
  }
  const picked = records(shop.products)[index] ?? {};
  const price = (num(picked.buy) ?? 0) * count;
  const before: number | null = await gil(pilot);
  if (before !== null && price > before) {
    return [false, `钱不够:${product}×${count} 要 ${price},只有 ${before}`];
  }
  await pilot.send("keys", { keys: ["Enter"], gap: 300 });
  const afterEnter = await shopState(pilot);
  let trade = record(afterEnter.trade);
  if (!truthy(trade) && afterEnter.state === "SelectProduct") {
    // Nothing opened: a spell the party has already learned (or one it cannot afford)
    // takes no quantity (10-20: three spells bought again and again, reported as maybe
    // not bought).
    return [false, `买不了「${show(names[index])}」:魔法已经学会了(魔法只能买一次),或者钱不够`];
  }
  for (let i = 0; i < 20; i++) {
    const now = num(trade.count);
    if (now === undefined || now === count) break;
    await pilot.send("keys", { keys: [now < count ? "Right" : "Left"], gap: 120 });
    trade = record((await shopState(pilot)).trade);
  }
  await pilot.send("keys", { keys: ["Enter"], gap: 500 });
  // A confirmation or "thank you" line may follow; one more Enter clears it.
  let after: number | null = await gil(pilot);
  if (after !== null && before !== null && after === before) {
    await pilot.send("keys", { keys: ["Enter"], gap: 500 });
    after = await gil(pilot);
  }
  // The shop goes back to its list by itself: stay there, ready for the next purchase.
  if (after !== null && before !== null && after < before) {
    return [
      true,
      `买了「${show(names[index])}」×${count},花了 ${before - after},剩 ${after}${note}`,
    ];
  }
  return [false, `金钱没有变化(${show(before)}),可能没买成`];
}

/**
 * Get the keys onto the product list; returns the shop then, None if that fails.
 *
 * The list is on screen (with a cursor) while the command menu has the keys too, so the
 * shop's state (bridge 0.5.2+) decides. Older bridges have only the list cursor to go by.
 */
export async function openProducts(pilot: Pilot, shop: Reply): Promise<Reply | null> {
  if (shop.state === null || shop.state === undefined) {
    if (shop.listCursor === null || shop.listCursor === undefined) {
      await enterBuy(pilot, shop);
      shop = await shopState(pilot);
    }
    return shop.listCursor !== null && shop.listCursor !== undefined ? shop : null;
  }
  for (let i = 0; i < 4; i++) {
    const state = shop.state;
    if (state === "SelectProduct" && shop.listCursor !== null && shop.listCursor !== undefined) {
      return shop;
    }
    if (state === "SelectCommand") await enterBuy(pilot, shop);
    else await pilot.send("keys", { keys: ["Backspace"], gap: 300 });
    shop = await shopState(pilot);
  }
  return null;
}

async function enterBuy(pilot: Pilot, shop: Reply): Promise<void> {
  const commands = (Array.isArray(shop.commands) ? shop.commands : []).filter(
    (command): command is string => typeof command === "string",
  );
  if (commands.includes("Buy")) {
    await moveCursor(pilot, num(shop.commandCursor) ?? 0, commands.indexOf("Buy"));
    await pilot.send("keys", { keys: ["Enter"], gap: 300 });
  }
}

/**
 * Back out of a list, quantity window or confirmation until the command menu has the
 * keys (bridge 0.5.2+ reads the shop's state).
 */
export async function toCommandMenu(pilot: Pilot, shop: Reply): Promise<Reply | null> {
  for (let i = 0; i < 4; i++) {
    if (shop.state === "SelectCommand") return shop;
    await pilot.send("keys", { keys: ["Backspace"], gap: 300 });
    shop = await shopState(pilot);
  }
  return null;
}

/**
 * In an open shop with a Sell command: Sell → the bag's item (by name, scrolling the list
 * as drawn, bridge 0.7.3+) → quantity → confirm; checked against the gil. For gear nobody
 * wears any more (10-21: surplus helmets and armour bought four at a time).
 */
export async function sell(pilot: Pilot, item: string, count = 1): Promise<[boolean, string]> {
  let shop = await shopState(pilot);
  if (!truthy(shop.open)) return [false, "商店没有打开:先和店员说话"];
  shop = (await toCommandMenu(pilot, shop)) ?? {};
  const commands = (Array.isArray(shop.commands) ? shop.commands : []).filter(
    (command): command is string => typeof command === "string",
  );
  if (!commands.includes("Sell")) {
    return [false, "这家店不收东西(没有「卖出」;魔法店只卖不收)"];
  }
  await moveCursor(pilot, num(shop.commandCursor) ?? 0, commands.indexOf("Sell"));
  await pilot.send("keys", { keys: ["Enter"], gap: 300 });
  shop = await shopState(pilot);
  if (shop.state !== "SelectSellItem" || shop.rows === null || shop.rows === undefined) {
    return [false, "没能打开卖出列表(或桥插件早于 0.7.3)"];
  }
  const row = await findRow(pilot, item);
  if (row === null) {
    const held = records((await shopState(pilot)).rows)
      .map((entry) => iconName(entry.name))
      .join("、");
    await toCommandMenu(pilot, await shopState(pilot));
    return [false, `背包里没有「${item}」可卖;卖出列表开头是:${held}`];
  }
  if (!(row.canSelect === undefined ? true : truthy(row.canSelect))) {
    await toCommandMenu(pilot, await shopState(pilot));
    return [false, `「${iconName(row.name)}」不能卖`];
  }
  const before = await gil(pilot);
  await pilot.send("keys", { keys: ["Enter"], gap: 300 });
  let trade = record((await shopState(pilot)).trade);
  const most = num(trade.max);
  count = most ? Math.min(count, most) : count;
  for (let i = 0; i < 60; i++) {
    const now = num(trade.count);
    if (now === undefined || now === count) break;
    await pilot.send("keys", { keys: [now < count ? "Right" : "Left"], gap: 110 });
    trade = record((await shopState(pilot)).trade);
  }
  await pilot.send("keys", { keys: ["Enter"], gap: 500 });
  let after = await gil(pilot);
  if (after !== null && before !== null && after === before) {
    await pilot.send("keys", { keys: ["Enter"], gap: 500 }); // a "sell this?" confirmation
    after = await gil(pilot);
  }
  await toCommandMenu(pilot, await shopState(pilot));
  const name = iconName(row.name);
  if (after !== null && before !== null && after > before) {
    return [true, `卖了「${name}」×${count},得到 ${after - before},现在 ${after}`];
  }
  return [false, `金钱没有变化(${show(before)}),可能没卖成`];
}

/**
 * Move the sell list's cursor onto `item`, scrolling down then up through the list as
 * drawn; the row, or None when the list does not have it.
 */
export async function findRow(pilot: Pilot, item: string, tries = 120): Promise<Reply | null> {
  let seenBottom = false;
  for (let i = 0; i < tries; i++) {
    const rows = records((await shopState(pilot)).rows);
    const names = rows.map((row) => iconName(row.name));
    const focusIndex = rows.findIndex((row) => truthy(row.focus));
    const focus = focusIndex < 0 ? null : focusIndex;
    const target = pick(names, item);
    if (target !== null && focus !== null && target === focus) return rows[target] ?? null;
    let key: string;
    if (target !== null && focus !== null) key = target > focus ? "Down" : "Up";
    else key = seenBottom ? "Up" : "Down";
    const beforeNames = names;
    const beforeFocus = focus;
    await pilot.send("keys", { keys: [key], gap: 110 });
    const afterRows = records((await shopState(pilot)).rows);
    const afterNames = afterRows.map((row) => iconName(row.name));
    const afterFocusIndex = afterRows.findIndex((row) => truthy(row.focus));
    const afterFocus = afterFocusIndex < 0 ? null : afterFocusIndex;
    const same =
      afterFocus === beforeFocus &&
      afterNames.length === beforeNames.length &&
      afterNames.every((name, index) => name === beforeNames[index]);
    if (same) {
      // the cursor did not move: the end of the list
      if (seenBottom || key === "Up") return null;
      seenBottom = true;
    }
  }
  return null;
}
