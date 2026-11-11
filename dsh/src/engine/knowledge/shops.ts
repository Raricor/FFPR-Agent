/**
 * Correct shops for one actual map (task 151 follow-up, 11-11). `master:shops.json` reuses a
 * product group across towns and its `mapId`/kind can point at another town; the map files'
 * clerk `shopId` and map titles are the reliable place. `chapter-facts.ts` already does this for
 * the whole chapter; this module gives the per-section fact sheet the same data.
 */

import { SHOP_KINDS } from "../guide/steam.ts";
import { cleanName } from "../icons.ts";
import { normalizeName } from "./merge.ts";
import type { GameMapFile } from "./game-files.ts";
import type { Knowledge } from "./types.ts";

export interface MapShopProduct {
  readonly name: string;
  readonly price: number | null;
  readonly itemId: number | null;
  readonly aliases?: readonly string[];
}

export interface MapShop {
  readonly area: string;
  readonly kind: string;
  readonly products: readonly MapShopProduct[];
}

const KIND_ALIASES: Readonly<Record<string, string>> = {
  Item: "道具",
  Items: "道具",
  Weapon: "武器",
  Weapons: "武器",
  Armor: "防具",
  Shields: "盾",
  Helmets: "头盔",
  Accessories: "饰品",
  Inn: "旅店",
  Magic: "魔法",
  WhiteMagic: "白魔法",
  BlackMagic: "黑魔法",
  "White Magic": "白魔法",
  "Black Magic": "黑魔法",
};

function shopKindName(kind: string | null): string {
  const cleaned = cleanName(kind ?? "商店");
  return SHOP_KINDS[cleaned] ?? KIND_ALIASES[cleaned] ?? cleaned;
}

function mapTitleKind(title: GameMapFile["title"]): string | null {
  if (title === null || title === undefined) return null;
  const text = [title.zhc, title.en, title.ja]
    .filter((value): value is string => value !== null && value.trim() !== "")
    .join(" ")
    .toLowerCase();
  if (/旅店|inn/iu.test(text)) return "旅店";
  if (/武器.?防具|equipment/iu.test(text)) return "武器防具";
  if (/道具|item/iu.test(text)) return "道具";
  if (/武器|weapon/iu.test(text)) return "武器";
  if (/防具|armor/iu.test(text)) return "防具";
  if (/魔法|magic/iu.test(text)) return "魔法";
  return null;
}

function chineseName(knowledge: Knowledge, id: number | null, name: string): string | null {
  const wanted = normalizeName(name);
  if (wanted !== "") {
    for (const item of knowledge.contentItems) {
      const names = [item.names.zhc, item.names.en, item.names.ja].filter(
        (value): value is string => value !== null && value.trim() !== "",
      );
      if (!names.some((value) => normalizeName(value) === wanted)) continue;
      const chinese = item.names.zhc;
      if (chinese !== null && chinese.trim() !== "") return cleanName(chinese);
    }
  }
  if (id !== null) {
    const content = knowledge.contentItems.find((item) => item.id === id);
    if (content?.names.zhc !== null && content?.names.zhc !== undefined) {
      return cleanName(content.names.zhc);
    }
    const item = knowledge.items.find((entry) => entry.id === id);
    if (item !== undefined) return cleanName(item.name);
    const magic = knowledge.magic.find((entry) => entry.id === id);
    if (magic !== undefined) return cleanName(magic.name);
  }
  return null;
}

function productKind(
  knowledge: Knowledge,
  product: Knowledge["shops"][number]["products"][number],
): string | null {
  const wanted = normalizeName(product.name);
  for (const item of knowledge.contentItems) {
    const names = [item.names.zhc, item.names.en, item.names.ja].filter(
      (value): value is string => value !== null && value.trim() !== "",
    );
    if (names.some((value) => normalizeName(value) === wanted)) return item.kind;
  }
  if (product.itemId !== null) {
    const content = knowledge.contentItems.find((item) => item.id === product.itemId);
    if (content !== undefined) return content.kind;
    const item = knowledge.items.find((entry) => entry.id === product.itemId);
    if (item !== undefined) return item.kind;
    if (knowledge.magic.some((entry) => entry.id === product.itemId)) return "magic";
  }
  return knowledge.magic.some((entry) => normalizeName(entry.name) === wanted) ? "magic" : null;
}

function inferKind(
  knowledge: Knowledge,
  products: readonly Knowledge["shops"][number]["products"][number][],
): string | null {
  const counts = new Map<string, number>();
  for (const product of products) {
    const kind = productKind(knowledge, product);
    const label =
      kind === "weapon"
        ? "武器"
        : kind === "armor"
          ? "防具"
          : kind === "magic"
            ? "魔法"
            : kind === "item"
              ? "道具"
              : null;
    if (label !== null) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort(
    ([leftKind, leftCount], [rightKind, rightCount]) =>
      rightCount - leftCount || leftKind.localeCompare(rightKind),
  )[0];
  return best === undefined ? null : best[0];
}

function productOf(
  knowledge: Knowledge,
  product: Knowledge["shops"][number]["products"][number],
): MapShopProduct | null {
  const name = chineseName(knowledge, product.itemId, product.name) ?? cleanName(product.name);
  if (name === "") return null;
  const aliases = new Set<string>();
  for (const alias of product.aliases ?? []) {
    const cleaned = cleanName(alias);
    if (cleaned !== "" && normalizeName(cleaned) !== normalizeName(name)) aliases.add(cleaned);
  }
  const original = cleanName(product.name);
  if (original !== "" && normalizeName(original) !== normalizeName(name)) aliases.add(original);
  return {
    name,
    price: product.price,
    itemId: product.itemId,
    ...(aliases.size === 0 ? {} : { aliases: [...aliases] }),
  };
}

/** The shops whose clerk stands on `mapId`, with the map title's kind and Chinese goods. */
export function shopsOnMap(knowledge: Knowledge, mapId: number): MapShop[] {
  const file = knowledge.mapFiles?.find((entry) => entry.id === mapId);
  const clerkIds = new Set<number>();
  for (const npc of file?.npcs ?? []) {
    if (npc.shopId !== null) clerkIds.add(npc.shopId);
  }
  const hasMapFiles = (knowledge.mapFiles?.length ?? 0) > 0;
  const located = hasMapFiles
    ? clerkIds.size === 0
      ? []
      : knowledge.shops.filter((shop) => shop.id !== null && clerkIds.has(shop.id))
    : knowledge.shops.filter((shop) => shop.mapId === mapId);
  const map = knowledge.maps.find((entry) => entry.id === mapId);
  const area = cleanName(map?.areaName ?? map?.name ?? `地图 ${mapId}`);
  const titleKind = mapTitleKind(file?.title);
  const out: MapShop[] = [];
  const seen = new Set<string>();
  for (const shop of located) {
    if (seen.has(shop.id === null ? `${shop.areaName}:${shop.kind}` : String(shop.id))) continue;
    seen.add(shop.id === null ? `${shop.areaName}:${shop.kind}` : String(shop.id));
    const products: MapShopProduct[] = [];
    const productSeen = new Set<string>();
    for (const raw of shop.products) {
      const product = productOf(knowledge, raw);
      if (product === null) continue;
      const key = `${normalizeName(product.name)}|${product.price ?? ""}`;
      if (productSeen.has(key)) continue;
      productSeen.add(key);
      products.push(product);
    }
    out.push({
      area,
      kind: titleKind ?? inferKind(knowledge, shop.products) ?? shopKindName(shop.kind),
      products,
    });
  }
  return out;
}
