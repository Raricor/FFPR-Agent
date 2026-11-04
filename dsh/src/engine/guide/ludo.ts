/**
 * Read the Final Fantasy V walkthrough on ludo.guide (human-written, covers the Pixel
 * Remaster) into structured chapters: steps, tips, monsters with bestiary numbers, bosses,
 * items, and the chapter order. Ported from ffpr_agent/guide/ludo.py; control plan §4.11.
 * The pages are cached under .deps, never committed: the text is the guide's, kept for our
 * own play with its source URL on every chapter.
 *
 *     const chapters = pages.map(([slug, html]) => parse(slug, html));
 */

const BASE = "https://www.ludo.guide/guide/final-fantasy-v";
const INDEX = BASE;
const SLUG_SOURCE = 'href="/guide/final-fantasy-v/([a-z0-9-]+)"';
// 030 Jackanapes (Level 20, HP 666, Steal: Speed Shake, Elixir, Drop: Phoenix Down, ...)
// 037 Crew Dust (Level 17, HP 240): Steals Potion. Weak to Ice, Water, Wind.
const MONSTER_HEAD = /(?<!\d)(\d{3})\s+([A-Za-z][^()]*?)\s*\((Level[^)]*)\)\s*:?\s*/g;
// Weakness prose for bosses without a numbered row: Liquid Flame's weaknesses are Ice, ...
const BOSS_WEAK =
  /([A-Z][A-Za-z' -]{2,40}?)(?:'s)?\s+(?:weaknesses are|weakness is|is weak to|are weak to)\s+([^.;]+)/g;
const PRONOUNS = new Set(["he", "she", "it", "they", "this", "that", "the"]);
const STEP = /^(\d{1,2})\s+(.+)$/;
const HEADINGS = ["Prerequisites", "Walkthrough", "Tips"];
const END = "More in this chapter";

export interface Monster {
  book: number; // the bestiary number (the game's PictureBook id)
  name: string;
  area: string;
  level: number | null;
  hp: number | null;
  weak: string[]; // English element names, as the guide writes them
  absorb: string[];
  immune: string[];
  steal: string;
  drop: string;
  blue: string; // blue magic it teaches
  notes: string; // anything else in the parentheses
  row: string; // the guide's own numbered row, for the one-monster note (task 11)
}

export interface Chapter {
  slug: string;
  title: string;
  url: string;
  summary: string;
  prerequisites: string[];
  steps: string[];
  tips: string[];
  monsters: Monster[];
  bosses: Record<string, string[]>; // area → boss names
  items: Record<string, string[]>; // area → items
  previous: string;
  next: string;
}

/** Python's dataclasses.asdict for a Chapter: a plain, deep copy. */
export function asDict(chapter: Chapter): Chapter {
  return {
    ...chapter,
    prerequisites: [...chapter.prerequisites],
    steps: [...chapter.steps],
    tips: [...chapter.tips],
    monsters: chapter.monsters.map((monster) => ({
      ...monster,
      weak: [...monster.weak],
      absorb: [...monster.absorb],
      immune: [...monster.immune],
    })),
    bosses: Object.fromEntries(
      Object.entries(chapter.bosses).map(([area, names]) => [area, [...names]]),
    ),
    items: Object.fromEntries(
      Object.entries(chapter.items).map(([area, names]) => [area, [...names]]),
    ),
  };
}

/** Chapter slugs in the index's order, unsectioned duplicates removed. */
export function slugs(indexHtml: string): string[] {
  const seen: string[] = [];
  for (const match of indexHtml.matchAll(new RegExp(SLUG_SOURCE, "g"))) {
    const slug = match[1];
    if (slug && !seen.includes(slug) && slug !== "about") seen.push(slug);
  }
  return seen;
}

export function textLines(page: string): string[] {
  let text = page.replace(/<script.*?<\/script>|<style.*?<\/style>|<!--.*?-->/gs, "");
  text = text.replace(/<(br|\/p|\/li|\/h[1-6]|\/div|\/tr|\/dt|\/dd)[^>]*>/gi, "\n");
  text = unescapeHtml(text.replace(/<[^>]+>/g, " "));
  const lines = text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line.length > 0);
  return lines;
}

/** The first monster row on a line, or null; rows may share a line with prose. */
export function parseMonster(line: string, area: string): Monster | null {
  return monstersIn(line, area)[0] ?? null;
}

/**
 * Every numbered monster row on a line. The fire-powered-ship page puts all four in one
 * walkthrough step ("Enemies: 037 Crew Dust (...) ... 038 Poltergeist (...)..."), so a row
 * is not necessarily a whole line.
 */
export function monstersIn(line: string, area: string): Monster[] {
  const matches = [...line.matchAll(MONSTER_HEAD)];
  const out: Monster[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const number = match?.[1];
    const name = match?.[2];
    const inside = match?.[3];
    if (number === undefined || name === undefined || inside === undefined) continue;
    const start = match?.index ?? 0;
    const end = matches[i + 1]?.index ?? line.length;
    const after = line.slice(start + (match?.[0].length ?? 0), end);
    const row = line.slice(start, end).trim();
    out.push(monsterFrom(Number.parseInt(number, 10), name.trim(), inside, after, area, row));
  }
  return out;
}

function monsterFrom(
  book: number,
  name: string,
  inside: string,
  after: string,
  area: string,
  row: string,
): Monster {
  const monster: Monster = {
    book,
    name,
    area,
    level: null,
    hp: null,
    weak: [],
    absorb: [],
    immune: [],
    steal: "",
    drop: "",
    blue: "",
    notes: "",
    row,
  };
  const rest: string[] = [];
  for (const raw of inside.split(/,\s*(?=[A-Z][A-Za-z ]+:|Level|HP)/)) {
    const part = raw.trim();
    if (part.startsWith("Level")) monster.level = intValue(part);
    else if (part.startsWith("HP")) monster.hp = intValue(part);
    else if (part.startsWith("Steal:")) monster.steal = part.slice(6).trim();
    else if (part.startsWith("Drop:")) monster.drop = part.slice(5).trim();
    else if (part.startsWith("Blue Magic:")) monster.blue = part.slice(11).trim();
    else if (/^(Weak|Absorb|Immune|Null)\b/i.test(part)) continue;
    else if (part) rest.push(part);
  }
  const attributes = attributesOf(`${inside} ${after}`);
  monster.weak = attributes.weak;
  monster.absorb = attributes.absorb;
  monster.immune = attributes.immune;
  // The fire-powered-ship rows write "Steals ... Weak to ..." after the parentheses.
  monster.steal = monster.steal || detailOf(after, /\bSteals?\b/i);
  monster.drop = monster.drop || detailOf(after, /\bDrops?\b/i);
  monster.blue = monster.blue || detailOf(after, /\bBlue Magic\b/i);
  monster.notes = rest.join(", ");
  return monster;
}

/** The text after a label such as "Steals" or "Drop:", up to the sentence or next label. */
function detailOf(text: string, label: RegExp): string {
  const pattern = new RegExp(
    `${label.source}\\s*:?\\s*([^.;]+?)(?=\\.|,\\s*(?:Drops?|Weak|Absorb|Immune|Null|Blue Magic)|$)`,
    "i",
  );
  return pattern.exec(text)?.[1]?.trim() ?? "";
}

const ATTRIBUTE =
  /\b(Weak(?:ness(?:es)?)?|Absorb(?:s|ed)?|Immune|Null(?:ifies)?)\b\s*(?:to|are|is|against|:|---)?\s*([^.;)]*?)(?=(?:[.;)]|\b(?:Weak|Absorb|Immune|Null)\b|$))/gi;

/** Weak, absorb and immune lists from a monster row or a boss sentence (English names). */
export function attributesOf(source: string): {
  weak: string[];
  absorb: string[];
  immune: string[];
} {
  const result = { weak: [] as string[], absorb: [] as string[], immune: [] as string[] };
  const text = source.replace(/extit\{([^}]*)\}/g, "$1");
  for (const match of text.matchAll(ATTRIBUTE)) {
    const kind = (match[1] ?? "").toLowerCase();
    const names = splitAttributes(match[2] ?? "");
    const target = kind.startsWith("weak")
      ? result.weak
      : kind.startsWith("absorb")
        ? result.absorb
        : result.immune;
    for (const name of names) if (!target.includes(name)) target.push(name);
  }
  return result;
}

function splitAttributes(value: string): string[] {
  const cleaned = value
    .replace(/---/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .trim();
  if (!cleaned || /^(?:none|nothing|no elements?|-)\b/i.test(cleaned)) return [];
  const out: string[] = [];
  for (const raw of cleaned.split(/\s*(?:,|and|\/|&)\s*/i)) {
    const name = raw
      .replace(/[^A-Za-z ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!name || name.split(" ").length > 2) continue;
    if (
      /^(?:but|can|it|use|drop|steal|blue|level|hp|when|alone|susceptible|physical)$/i.test(name)
    ) {
      continue;
    }
    out.push(name);
  }
  return out;
}

/** Bosses named only in prose ("Liquid Flame's weaknesses are Ice, Water, and Wind"). */
function bossMonsters(lines: readonly string[], area: string): Monster[] {
  const out: Monster[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(BOSS_WEAK)) {
      const name = (match[1] ?? "").trim();
      if (!name || PRONOUNS.has(name.toLowerCase())) continue;
      const weak = splitAttributes(match[2] ?? "");
      if (weak.length === 0) continue;
      out.push({
        book: 0,
        name,
        area,
        level: null,
        hp: null,
        weak,
        absorb: [],
        immune: [],
        steal: "",
        drop: "",
        blue: "",
        notes: "",
        row: match[0].trim(),
      });
    }
  }
  return out;
}

function intValue(text: string): number | null {
  const match = /\d+/.exec(text.replace(/,/g, ""));
  return match ? Number.parseInt(match[0], 10) : null;
}

export function parse(slug: string, page: string): Chapter {
  const lines = textLines(page);
  const titleMatch = /<h1[^>]*>(.*?)<\/h1>/s.exec(page);
  let title = slug;
  if (titleMatch?.[1] !== undefined) {
    title = unescapeHtml(titleMatch[1].replace(/<[^>]+>/g, "")).trim();
  }
  const chapter: Chapter = {
    slug,
    title,
    url: `${BASE}/${slug}`,
    summary: "",
    prerequisites: [],
    steps: [],
    tips: [],
    monsters: [],
    bosses: {},
    items: {},
    previous: "",
    next: "",
  };
  let section = "";
  let area = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line === END) break;
    if (HEADINGS.includes(line)) {
      section = line;
      if (i > 0 && !chapter.summary && section === "Prerequisites") {
        const previous = lineAt(lines, i - 1) ?? "";
        chapter.summary = previous === "⚡" ? (lineAt(lines, i - 2) ?? "") : previous;
      }
      continue;
    }
    if (line.startsWith("Monsters in ") && line.endsWith(":")) {
      section = "Monsters";
      area = line.slice("Monsters in ".length, -1);
      continue;
    }
    if (line.startsWith("Bosses in ") && line.endsWith(":")) {
      section = "Bosses";
      area = line.slice("Bosses in ".length, -1);
      continue;
    }
    if (line.startsWith("Items in ") && line.endsWith(":")) {
      section = "Items";
      area = line.slice("Items in ".length, -1);
      continue;
    }
    if (section === "Prerequisites") {
      chapter.prerequisites.push(line);
    } else if (section === "Walkthrough") {
      const match = STEP.exec(line);
      if (match?.[2] !== undefined) chapter.steps.push(match[2]);
      else if (chapter.steps.length > 0) {
        const last = chapter.steps.length - 1;
        chapter.steps[last] = `${chapter.steps[last] ?? ""} ${line}`;
      }
      for (const monster of monstersIn(line, area || chapter.title)) addMonster(chapter, monster);
    } else if (section === "Tips") {
      chapter.tips.push(line);
    } else if (section === "Monsters") {
      for (const monster of monstersIn(line, area)) addMonster(chapter, monster);
    } else if (section === "Bosses") {
      const bosses = chapter.bosses[area] ?? [];
      bosses.push(line);
      chapter.bosses[area] = bosses;
    } else if (section === "Items") {
      const items = chapter.items[area] ?? [];
      items.push(line);
      chapter.items[area] = items;
    }
  }
  for (const monster of bossMonsters(lines, chapter.title)) addMonster(chapter, monster);
  for (const line of lines) {
    if (line.startsWith("Previous: ")) chapter.previous = line.slice("Previous: ".length);
    else if (line.startsWith("Next: ")) chapter.next = line.slice("Next: ".length);
  }
  return chapter;
}

/** Add a row found in prose, merging with the numbered row of the same monster. */
function addMonster(chapter: Chapter, monster: Monster): void {
  const existing =
    (monster.book > 0
      ? chapter.monsters.find((known) => known.book === monster.book)
      : undefined) ??
    chapter.monsters.find((known) => known.name.toLowerCase() === monster.name.toLowerCase());
  if (existing === undefined) {
    chapter.monsters.push(monster);
    return;
  }
  for (const weak of monster.weak) if (!existing.weak.includes(weak)) existing.weak.push(weak);
  for (const absorb of monster.absorb) {
    if (!existing.absorb.includes(absorb)) existing.absorb.push(absorb);
  }
  for (const immune of monster.immune) {
    if (!existing.immune.includes(immune)) existing.immune.push(immune);
  }
  if (existing.book <= 0 && monster.book > 0) existing.book = monster.book;
  if (existing.row === "" && monster.row !== "") existing.row = monster.row;
}

/** Python's negative list indexing: line_at(lines, -1) is the last line. */
function lineAt(lines: readonly string[], index: number): string | undefined {
  if (index >= 0) return lines[index];
  return lines[lines.length + index];
}

/**
 * HTML entities Node does not decode for us. The cached pages only use these six, plus
 * numeric references; a few common named ones are here so a changed page still reads right.
 */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  eacute: "é",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  times: "×",
  laquo: "«",
  raquo: "»",
};

export function unescapeHtml(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]+));/g,
    (
      match,
      decimal: string | undefined,
      hexadecimal: string | undefined,
      name: string | undefined,
    ) => {
      if (decimal !== undefined) {
        const code = Number.parseInt(decimal, 10);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      if (hexadecimal !== undefined) {
        const code = Number.parseInt(hexadecimal, 16);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return (name !== undefined ? ENTITIES[name] : undefined) ?? match;
    },
  );
}

export { BASE, INDEX };
