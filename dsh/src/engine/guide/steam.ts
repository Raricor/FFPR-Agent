/**
 * Steam Community guides for FINAL FANTASY V (Pixel Remaster, app 1173810), the sources the
 * user pointed to (10-21): the full walkthrough (77 sections, the whole game: shops with
 * prices, each area's monsters by bestiary number, boss stat tables with weaknesses,
 * strategies) and the simplified bestiary (bestiary number → English name for every enemy).
 * Ported from ffpr_agent/guide/steam.py; cached under .deps.
 */

import { unescapeHtml } from "./ludo.ts";

export const APP = 1173810;
export const WALKTHROUGH = "https://steamcommunity.com/sharedfiles/filedetails/?id=2651014732";
export const BESTIARY = "https://steamcommunity.com/sharedfiles/filedetails/?id=2682517364";
export const MISSABLES = "https://steamcommunity.com/sharedfiles/filedetails/?id=2651019340";
const ENTRY = /^(\d{1,3})\.\s+(.+)$/;

export interface ShopGood {
  name: string;
  cost: number | null;
  note: string;
}

export interface ShopTable {
  where: string;
  kind: string;
  goods: ShopGood[];
}

export interface Treasure {
  kind: "chest" | "hidden";
  n: number;
  where: string;
  text: string;
}

export interface SteamSection {
  title: string;
  text: string;
  shops?: ShopTable[];
  treasures?: Treasure[];
}

/** A section's HTML as lines of text (table cells one per line, as Steam renders them). */
export function clean(fragment: string): string {
  let text = fragment.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<(div|td|th|tr|li|p)[^>]*>/gi, "\n");
  text = unescapeHtml(text.replace(/<[^>]+>/g, ""));
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** [{"title", "text"}] in guide order. */
export function sections(page: string): SteamSection[] {
  const out: SteamSection[] = [];
  for (const part of page.split('<div class="subSectionTitle">').slice(1)) {
    const titleEnd = part.indexOf("</div>");
    const title = titleEnd >= 0 ? part.slice(0, titleEnd) : part;
    let body = titleEnd >= 0 ? part.slice(titleEnd + "</div>".length) : "";
    body = body.split('<div class="subSectionTitle">')[0] ?? "";
    // the guide's footer and comments follow the last section
    body = body.split(/<div class="commentthread|<div id="commentthread/)[0] ?? "";
    out.push({ title: clean(title), text: clean(body) });
  }
  return out;
}

/** Bestiary number → English name, from the simplified bestiary's list. */
export function bestiary(page: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of clean(page).split("\n")) {
    const match = ENTRY.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    const number = Number.parseInt(match[1], 10);
    if (!names.has(number)) names.set(number, match[2].trim());
  }
  return names;
}

const CHEST = /\[(\d+)(?:-\d+)?\/225\]/; // a chest's running number among the 225
const HIDDEN = /\{(\d+)(?:-\d+)?\/46\}/; // a hidden item's among the 46 (pots, barrels)
export const SHOP_KINDS: Readonly<Record<string, string>> = {
  Inn: "旅店",
  Items: "道具",
  Weapons: "武器",
  Armor: "防具",
  Shields: "盾",
  Helmets: "头盔",
  Accessories: "饰品",
  Magic: "魔法",
};
const TABLE_WORDS = new Set([
  "Item",
  "Service",
  "Cost",
  "Description",
  "ID",
  "MONSTER",
  "HP",
  "MP",
  "GIL",
  "EXP",
]);

/**
 * A sub-area heading in the walkthrough ("Tower of Walse - 5F", "Castle Walse"): short, no
 * sentence punctuation, not a table cell, not a monster's name (`skip`: the bestiary's names,
 * which the monster tables put on lines of their own).
 */
export function isPlace(line: string, skip: ReadonlySet<string> = new Set()): boolean {
  return (
    !skip.has(line) &&
    Array.from(line).length <= 40 &&
    !/[.!?:,;{}[\]()]/.test(line) &&
    !/^\d+$/.test(line) &&
    !TABLE_WORDS.has(line) &&
    !Object.hasOwn(SHOP_KINDS, line) &&
    /^\p{Lu}/u.test(line)
  );
}

/**
 * Chests ([n/225]) and hidden items ({n/46}) of a section: the line that finds them, with its
 * running number and the sub-area heading above it.
 */
export function treasures(
  section: SteamSection,
  skip: ReadonlySet<string> = new Set(),
): Treasure[] {
  const out: Treasure[] = [];
  let place = section.title;
  for (const line of section.text.split("\n")) {
    if (isPlace(line, skip)) place = line;
    for (const [kind, mark] of [
      ["chest", CHEST],
      ["hidden", HIDDEN],
    ] as const) {
      const match = mark.exec(line);
      if (match?.[1]) {
        out.push({
          kind,
          n: Number.parseInt(match[1], 10),
          where: place,
          text: line.replace(new RegExp(mark.source, "g"), "").trim(),
        });
      }
    }
  }
  return out;
}

/**
 * The shop tables of a section: [{"where", "kind", "goods": [{"name", "cost", "note"}]}].
 * Tables run category, header cells, then name / cost / description triples (the inn: service
 * / cost pairs); a price cell sometimes reads "Cost" instead of a number.
 */
export function shops(section: SteamSection, skip: ReadonlySet<string> = new Set()): ShopTable[] {
  const lines = section.text.split("\n");
  const out: ShopTable[] = [];
  let place = section.title;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    const header = lines.slice(i + 1, i + 4);
    const category = Object.hasOwn(SHOP_KINDS, line) ? SHOP_KINDS[line] : undefined;
    if (category !== undefined && (header[0] === "Item" || header[0] === "Service")) {
      const width = header[0] === "Service" ? 2 : 3;
      i += 1 + width; // past the header cells
      const goods: ShopGood[] = [];
      while (i + width - 1 < lines.length) {
        const name = lines[i] ?? "";
        const cost = lines[i + 1] ?? "";
        if (!(/^\d+$/.test(cost) || cost === "Cost") || TABLE_WORDS.has(name)) break;
        const note = width === 3 ? (lines[i + 2] ?? "") : "";
        goods.push({ name, cost: /^\d+$/.test(cost) ? Number.parseInt(cost, 10) : null, note });
        i += width;
      }
      if (goods.length > 0) out.push({ where: place, kind: category, goods });
      continue;
    }
    if (isPlace(line, skip)) place = line;
    i += 1;
  }
  return out;
}
