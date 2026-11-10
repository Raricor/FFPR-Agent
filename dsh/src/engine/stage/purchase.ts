/**
 * Shopping list for the stage layer (task 96, 11-10). It turns the officer's `buyTo` targets
 * into quantities to buy at the shops the stage's starting town actually has, spending the
 * party's gil by usefulness: revival, then cures for the stage's dangerous statuses, then the
 * rest. Pure: no menu, no bridge, no gil is actually spent here.
 */

import type { StageFacts, StagePlan } from "./types.ts";

/** A shop's wares; the area and kind are accepted for callers passing StageFacts["shops"]. */
export interface ShopHere {
  readonly area?: string;
  readonly kind?: string;
  readonly products: readonly { readonly name: string; readonly price: number | null }[];
}

export interface Purchase {
  readonly item: string;
  readonly count: number;
  /** Unit price, the same number the shop shows; multiply by count for the total. */
  readonly price: number;
}

export interface PurchaseList {
  readonly buy: Purchase[];
  readonly skipped: string[];
}

/** Both Chinese names the games use for the revive item (grind.ts has the same pair). */
const REVIVE_ITEMS: readonly string[] = ["不死鸟之尾", "凤凰尾"];

/** Status cures, matching the Chinese FF5 names in gambit.CURES (skills/gambit.ts). */
const STATUS_ITEMS: Readonly<Record<string, string>> = {
  解毒药: "毒",
  眼药: "黑暗",
  金针: "石化",
  少女之吻: "青蛙",
  木槌: "迷你",
  回音草: "沉默",
  万能药: "*",
};

/** Healing and travel supplies count after cures, before ordinary gear. */
const RECOVERY_ITEMS = /恢复药|以太|帐篷|Potion|Ether|Tent/iu;

function bagCount(bag: StageFacts["bag"], item: string): number {
  let total = 0;
  for (const row of bag) {
    if (row.name === item) total += Math.max(0, row.count);
  }
  return total;
}

function curesThreat(item: string, threats: readonly string[]): boolean {
  const status = STATUS_ITEMS[item];
  if (status === undefined) return false;
  if (status === "*") return threats.length > 0;
  return threats.some((threat) => threat.includes(status) || status.includes(threat));
}

/**
 * Lower runs first. Revival is first because a wipe ends the run; a cure for a status the plan
 * names as a threat comes next (11-10: "先能治高威胁状态的药、复活道具,再别的").
 */
function priority(item: string, threats: readonly string[]): number {
  if (REVIVE_ITEMS.some((revive) => revive === item || item.includes(revive))) return 0;
  if (curesThreat(item, threats)) return 1;
  if (STATUS_ITEMS[item] !== undefined) return 2;
  if (RECOVERY_ITEMS.test(item)) return 3;
  return 4;
}

/**
 * The cheapest known price for `item` among the shops here. Undefined means no shop sells it;
 * null means a shop sells it but none of them shows a usable price.
 */
function cheapestPrice(shops: readonly ShopHere[], item: string): number | null | undefined {
  let sold = false;
  let best: number | null = null;
  for (const shop of shops) {
    for (const product of shop.products) {
      if (product.name !== item) continue;
      sold = true;
      const price = product.price;
      if (price === null || !Number.isFinite(price) || price < 0) continue;
      if (best === null || price < best) best = price;
    }
  }
  if (!sold) return undefined;
  return best;
}

/** Buy up to `buyTo` of each supply, skipping what the shops or the purse cannot cover. */
export function purchaseList(
  plan: StagePlan,
  bag: StageFacts["bag"],
  gil: number,
  shopsHere: readonly ShopHere[],
): PurchaseList {
  const buy: Purchase[] = [];
  const skipped: string[] = [];
  let money = Number.isFinite(gil) ? Math.max(0, gil) : 0;

  const wanted = plan.supplies
    .map((supply, index) => ({
      ...supply,
      index,
      count: Math.max(0, supply.buyTo - bagCount(bag, supply.item)),
    }))
    .filter((supply) => supply.count > 0)
    .sort(
      (left, right) =>
        priority(left.item, plan.threats) - priority(right.item, plan.threats) ||
        left.index - right.index,
    );

  for (const supply of wanted) {
    const price = cheapestPrice(shopsHere, supply.item);
    if (price === undefined) {
      skipped.push(`本店不卖「${supply.item}」,还差 ${supply.count} 个`);
      continue;
    }
    if (price === null) {
      skipped.push(`「${supply.item}」的价格未知,没买成,还差 ${supply.count} 个`);
      continue;
    }
    const affordable = price === 0 ? supply.count : Math.floor(money / price);
    const count = Math.min(supply.count, affordable);
    if (count > 0) {
      buy.push({ item: supply.item, count, price });
      money -= price * count;
    }
    if (count < supply.count) {
      const missing = supply.count - count;
      skipped.push(
        count === 0
          ? `钱不够,「${supply.item}」一个也没买到,还差 ${missing} 个`
          : `钱不够,「${supply.item}」只买到 ${count} 个,还差 ${missing} 个`,
      );
    }
  }
  return { buy, skipped };
}
