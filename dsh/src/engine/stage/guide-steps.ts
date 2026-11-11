/**
 * Turns one Steam walkthrough section into ordered steps for the route book (task 114, 11-11;
 * task 115 aligns the steps with map ids). The section text is one action per line, with
 * sub-location headers, chest (`[n/225]`) and hidden-item (`{n/46}`) marks, `BESTIARY:` tables
 * and boss stat blocks mixed in.
 *
 * Pure: the caller reads the guide cache (`.deps/knowledge/ff5/guide.json`) and passes the
 * section in. The shapes come from `guide-types.ts`, which task 115 shares.
 */

import { SHOP_KINDS, isPlace } from "../guide/steam.ts";
import type {
  GuideBoss,
  GuideMonster,
  GuideSection,
  GuideStep,
  GuideStepKind,
} from "./guide-types.ts";

const FILLER = /\u3164|\u00a0|\u200a|\u200b|\u200c|\ufeff/g;
const BESTIARY_HEADERS = ["ID", "MONSTER", "HP", "MP", "GIL", "EXP"] as const;
const BOSS_HEADERS = [
  "ID",
  "HP",
  "MP",
  "ATK",
  "DEF",
  "EVA",
  "M.DEF",
  "MAG",
  "WEAKNESS",
  "RESIST.",
  "ABSORBS",
  "CANCELS",
] as const;
const TABLE_WORDS: ReadonlySet<string> = new Set([
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
  "RATE",
  "MONSTERS",
  "ABP",
  ...BOSS_HEADERS,
  ...BESTIARY_HEADERS,
]);
const EMPTY_WORDS = /^(?:None|N\/A|\?+|---+|ABSORBS|CANCELS)$/i;
const PLACE_EXCEPTIONS: ReadonlySet<string> = new Set(["Overworld"]);
const NON_PLACES: ReadonlySet<string> = new Set([
  "Achievements",
  "Prerequisites",
  "Instructions",
  "Strategy",
  "Build",
  "Walkthrough",
]);

/** Keyword table for the prose lines; earlier kinds win when a line names several. */
const KIND_WORDS: readonly {
  readonly kind: GuideStepKind;
  readonly pattern: RegExp;
}[] = [
  {
    kind: "talk",
    pattern: /\b(?:speak|talk|answer|say|reply|respond|tell)\b/i,
  },
  {
    kind: "switch",
    pattern: /\b(?:switch|lever|push|secret passage|mechanism)\b/i,
  },
  { kind: "save", pattern: /\b(?:save|consecrated circle|quick-save)\b/i },
  {
    kind: "heal",
    pattern: /\b(?:healing point|healing pot|recovery spring|restore your party|heal)\b/i,
  },
  { kind: "cutscene", pattern: /\b(?:cutscene|scene|scenes)\b/i },
  { kind: "shop", pattern: /\b(?:shop|shopping|buy|purchase|sell)\b/i },
  { kind: "piano", pattern: /\bpiano\b/i },
  {
    kind: "move",
    pattern:
      /\b(?:head|go|take|return|exit|enter|walk|climb|ride|leave|follow|proceed|descend|ascend|jump|drop|board|sail|fly|run|travel|move|backtrack|approach|open|interact)\b/i,
  },
];

interface RefMark {
  readonly kind: "chest" | "hidden";
  readonly n: number;
  readonly end: number | undefined;
  readonly raw: string;
  readonly index: number;
}

interface RawItem {
  readonly text: string;
  readonly bare: boolean;
}

interface BossBlock {
  readonly end: number;
  readonly boss: GuideBoss;
}

/** The walkthrough sections of a cached `guide.json` (`walkthrough` is external data). */
export function parseWalkthrough(walkthrough: unknown): GuideSection[] {
  if (!Array.isArray(walkthrough)) throw new Error("攻略 walkthrough 不是数组");
  return walkthrough.map((raw, order) => {
    if (!isRecord(raw)) throw new Error(`攻略第 ${order} 节不是对象`);
    if (typeof raw.title !== "string" || typeof raw.text !== "string") {
      throw new Error(`攻略第 ${order} 节缺少 title 或 text 字符串`);
    }
    return parseGuideSection({ title: raw.title, text: raw.text }, order);
  });
}

/** One section; `order` is its position in the walkthrough, from 0. */
export function parseGuideSection(
  section: { title: string; text: string },
  order: number,
): GuideSection {
  const title = section.title.trim();
  const lines = section.text
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((line) => line !== "");
  const bosses = findBossBlocks(lines);
  const places: string[] = [];
  const seenPlaces = new Set<string>();
  const steps: GuideStep[] = [];
  const monsters: (GuideMonster & { readonly where: string | null })[] = [];
  let where: string | null = null;
  let listBlock = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.includes("BESTIARY:")) {
      const table = readBestiary(lines, i);
      for (const monster of table.monsters) monsters.push({ ...monster, where });
      i = table.end + 1;
      listBlock = false;
      continue;
    }
    const boss = bosses.get(i);
    if (boss !== undefined) {
      steps.push({
        index: steps.length,
        where,
        kind: "boss",
        text: boss.boss.name,
        ref: null,
        item: null,
        boss: boss.boss,
      });
      i = boss.end + 1;
      listBlock = false;
      continue;
    }
    const shopEnd = shopTableEnd(lines, i);
    if (shopEnd !== null) {
      i = shopEnd + 1;
      listBlock = false;
      continue;
    }
    const next = lines[i + 1] ?? "";
    const previous = lines[i - 1] ?? "";
    if (isSubHeader(line, previous, next, title, listBlock)) {
      where = line;
      if (!seenPlaces.has(line)) {
        seenPlaces.add(line);
        places.push(line);
      }
      listBlock = false;
      i += 1;
      continue;
    }
    for (const step of lineSteps(line, where)) {
      steps.push({ index: steps.length, ...step });
    }
    if (line.endsWith(":")) listBlock = true;
    else if (/[.!?]["'”’)]?$/.test(line)) listBlock = false;
    i += 1;
  }
  return { title, order, places, steps, monsters };
}

function cleanLine(line: string): string {
  return line.replace(FILLER, " ").replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A sub-location header: short, no sentence punctuation, not a table cell, and at most two
 * words unless it carries a floor ("2F") or a dash ("Tule - Pub"). A list introduced by a
 * colon ("Jobs unlocked:") keeps its entries out; those are names, not places.
 */
function isSubHeader(
  line: string,
  previous: string,
  next: string,
  title: string,
  listBlock: boolean,
): boolean {
  if (!isPlace(line) || /[→←#]/.test(line) || NON_PLACES.has(line)) return false;
  const dashed = /^.+\s+-\s*.*$/.test(line);
  const floor = /\bB?\d+[FB]\b/.test(line);
  if (dashed || floor) return true;
  if (line === title || line === title.split(":", 1)[0]?.trim()) return true;
  if (PLACE_EXCEPTIONS.has(line)) return true;
  // A run of short lines with no sentence punctuation is a list (jobs, songs, monster
  // names), not a stack of places. The first line of the run may still be a heading.
  if (previous !== "" && isPlace(previous)) return false;
  if (listBlock) return false;
  if (
    /^(?:Reached|Mastered|Collected|Obtained|Traveled|Completed|Learned|Defeated|Acquired)\b/.test(
      next,
    )
  ) {
    return false;
  }
  if (/^\d+$/.test(next) || TABLE_WORDS.has(next) || Object.hasOwn(SHOP_KINDS, next)) {
    return false;
  }
  return line.split(/\s+/).length <= 2;
}

/**
 * Where a recognised shop table ends (category, header cells, then name/cost/description
 * rows), or null when no table starts here. The guide sometimes labels a table
 * "Items (inside Inn)", so the category is not restricted to `SHOP_KINDS`.
 */
function shopTableEnd(lines: readonly string[], start: number): number | null {
  const header = lines[start + 1];
  if (header !== "Item" && header !== "Service") return null;
  if (lines[start + 2] !== "Cost") return null;
  const width = header === "Service" ? 2 : 3;
  if (width === 3 && lines[start + 3] !== "Description") return null;
  let row = start + 1 + width;
  while (row + width - 1 < lines.length) {
    const name = lines[row] ?? "";
    const cost = lines[row + 1] ?? "";
    if (!/^\d+$/.test(cost) && cost !== "Cost") break;
    if (TABLE_WORDS.has(name)) break;
    row += width;
  }
  return row - 1;
}

function readBestiary(
  lines: readonly string[],
  marker: number,
): { readonly monsters: GuideMonster[]; readonly end: number } {
  let header = marker + 1;
  while (header + BESTIARY_HEADERS.length <= lines.length) {
    const matches = BESTIARY_HEADERS.every((cell, offset) => lines[header + offset] === cell);
    if (matches) break;
    if (header - marker > 8) return { monsters: [], end: marker };
    header += 1;
  }
  if (header + BESTIARY_HEADERS.length > lines.length) return { monsters: [], end: marker };
  let row = header + BESTIARY_HEADERS.length;
  const monsters: GuideMonster[] = [];
  while (row + 5 < lines.length) {
    const id = lines[row] ?? "";
    const name = lines[row + 1] ?? "";
    const numbers = [lines[row + 2], lines[row + 3], lines[row + 4], lines[row + 5]];
    if (!/^\d{3}$/.test(id) || name === "") break;
    if (!numbers.every((value) => value !== undefined && /^\d+$/.test(value))) break;
    row += 6;
    let blueMagic: string | null = null;
    const magic = lines[row] ?? "";
    if (/^BM\s*:/i.test(magic)) {
      blueMagic = magic.replace(/^BM\s*:/i, "").trim() || null;
      row += 1;
    } else if (/^BM$/i.test(magic)) {
      row += 1;
    }
    monsters.push({ id: Number.parseInt(id, 10), name, blueMagic });
  }
  return { monsters, end: row - 1 };
}

/** Boss name index → the twelve-value block that follows it. */
function findBossBlocks(lines: readonly string[]): Map<number, BossBlock> {
  const out = new Map<number, BossBlock>();
  for (let i = 0; i + BOSS_HEADERS.length + 12 <= lines.length; i += 1) {
    if (!BOSS_HEADERS.every((header, offset) => lines[i + offset] === header)) continue;
    const name = lines[i - 1];
    if (name === undefined || name === "") continue;
    const values = lines.slice(i + BOSS_HEADERS.length, i + BOSS_HEADERS.length + 12);
    if (values.length !== 12) continue;
    out.set(i - 1, {
      end: i + BOSS_HEADERS.length + 11,
      boss: {
        name,
        hp: numberOrNull(values[1]),
        weak: listValue(values[8]),
        resist: listValue(values[9]),
        absorb: listValue(values[10]),
      },
    });
  }
  return out;
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const clean = value.replace(/,/g, "").trim();
  return /^\d+$/.test(clean) ? Number.parseInt(clean, 10) : null;
}

function listValue(value: string | undefined): string[] {
  if (value === undefined || EMPTY_WORDS.test(value.trim())) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !EMPTY_WORDS.test(part));
}

function lineSteps(line: string, where: string | null): Omit<GuideStep, "index">[] {
  const marks = findMarks(line);
  if (marks.length === 0) {
    return [
      {
        where,
        kind: classify(line),
        text: line,
        ref: null,
        item: null,
        boss: null,
      },
    ];
  }
  if (marks.length > 1) return multipleMarkSteps(line, marks, where);
  const mark = marks[0];
  if (mark === undefined) return [];
  const without = removeMarks(line);
  if (markAtEnd(line, mark) && isMultiContainer(without)) {
    const items = splitItems(without);
    const count = Math.max(items.length, containerCount(without) ?? 0);
    const first = mark.n - count + 1;
    if (count >= 2 && first >= 1) {
      const fallback = items.length === 1 ? items[0] : undefined;
      return Array.from({ length: count }, (_, offset) => ({
        where,
        kind: mark.kind,
        text: line,
        ref: { kind: mark.kind, n: first + offset },
        item: items[offset] ?? fallback ?? null,
        boss: null,
      }));
    }
  }
  const item = itemsFromClause(without)[0] ?? null;
  const numbers = mark.end !== undefined ? numberRange(mark.n, mark.end) : [mark.n];
  return numbers.map((n) => ({
    where,
    kind: mark.kind,
    text: line,
    ref: { kind: mark.kind, n },
    item,
    boss: null,
  }));
}

function multipleMarkSteps(
  line: string,
  marks: readonly RefMark[],
  where: string | null,
): Omit<GuideStep, "index">[] {
  const items = splitItems(removeMarks(line));
  const out: Omit<GuideStep, "index">[] = [];
  for (const [index, mark] of marks.entries()) {
    const item = items.length === marks.length ? (items[index] ?? null) : (items[0] ?? null);
    const numbers = mark.end !== undefined ? numberRange(mark.n, mark.end) : [mark.n];
    for (const n of numbers) {
      out.push({
        where,
        kind: mark.kind,
        text: line,
        ref: { kind: mark.kind, n },
        item,
        boss: null,
      });
    }
  }
  return out;
}

function numberRange(start: number, end: number): number[] {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  return Array.from({ length: high - low + 1 }, (_, offset) => low + offset);
}

function findMarks(line: string): RefMark[] {
  const marks: RefMark[] = [];
  for (const match of line.matchAll(/\[(\d+)(?:-(\d+))?\/225\]/g)) {
    const n = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(n)) continue;
    marks.push({
      kind: "chest",
      n,
      end: match[2] !== undefined ? Number.parseInt(match[2], 10) : undefined,
      raw: match[0],
      index: match.index,
    });
  }
  for (const match of line.matchAll(/\{(\d+)(?:-(\d+))?\/46\}/g)) {
    const n = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(n)) continue;
    marks.push({
      kind: "hidden",
      n,
      end: match[2] !== undefined ? Number.parseInt(match[2], 10) : undefined,
      raw: match[0],
      index: match.index,
    });
  }
  return marks.sort((left, right) => left.index - right.index);
}

function removeMarks(line: string): string {
  return line
    .replace(/\[\d+(?:-\d+)?\/225\]|\{\d+(?:-\d+)?\/46\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function markAtEnd(line: string, mark: RefMark): boolean {
  const rest = line.slice(mark.index + mark.raw.length).trim();
  return rest === "" || /^[.!?]+$/.test(rest);
}

/** How many containers a line names ("both chests", "all three pots"). */
function containerCount(line: string): number | null {
  const plural = String.raw`(?:chests|pots|barrels|boxes|crates|sacks)`;
  const patterns: readonly {
    readonly count: number;
    readonly pattern: RegExp;
  }[] = [
    {
      count: 2,
      pattern: new RegExp(String.raw`\bboth\b[^.!?]{0,40}\b${plural}\b`, "i"),
    },
    {
      count: 2,
      pattern: new RegExp(String.raw`\btwo\b[^.!?]{0,40}\b${plural}\b`, "i"),
    },
    {
      count: 3,
      pattern: new RegExp(String.raw`\bthree\b[^.!?]{0,40}\b${plural}\b`, "i"),
    },
    {
      count: 4,
      pattern: new RegExp(String.raw`\bfour\b[^.!?]{0,40}\b${plural}\b`, "i"),
    },
    {
      count: 5,
      pattern: new RegExp(String.raw`\bfive\b[^.!?]{0,40}\b${plural}\b`, "i"),
    },
    {
      count: 6,
      pattern: new RegExp(String.raw`\bsix\b[^.!?]{0,40}\b${plural}\b`, "i"),
    },
  ];
  for (const candidate of patterns) {
    if (candidate.pattern.test(line)) return candidate.count;
  }
  return null;
}

/** Whether the line really names several containers, not one chest plus scenery. */
function isMultiContainer(line: string): boolean {
  const plural = String.raw`(?:chests|pots|barrels|boxes|crates|sacks)`;
  const singular = String.raw`(?:chest|pot|barrel|box|crate|sack)`;
  const both = new RegExp(String.raw`\bboth\b[^.!?]{0,40}\b${plural}\b`, "i").test(line);
  const all = new RegExp(String.raw`\ball\b[^.!?]{0,40}\b${plural}\b`, "i").test(line);
  const numbered = new RegExp(
    String.raw`\b(?:two|three|four|five|six)\b[^.!?]{0,40}\b${plural}\b`,
    "i",
  ).test(line);
  const leftRight = /\bleft\b/i.test(line) && /\bright\b/i.test(line);
  const mentioned = new Set<string>();
  for (const match of line.matchAll(new RegExp(String.raw`\b${singular}s?\b`, "gi"))) {
    mentioned.add(match[0].replace(/s$/i, "").toLowerCase());
  }
  return both || all || numbered || leftRight || mentioned.size >= 2;
}

/**
 * Split "the pot for a Potion, the barrel for a Phoenix Down, and the box for a Tent" into
 * item names, keeping commas inside parentheses ("an Ether (don't waste, ...)") together.
 */
function splitItems(line: string): string[] {
  const masked = line.replace(/\([^)]*\)/g, (part) => part.replace(/,/g, "\uE000"));
  const normalized = masked.replace(/,\s*and\s+/gi, ", ");
  const out: string[] = [];
  for (const part of normalized.split(/\s*,\s*|\s+and\s+|\s+while\s+/i)) {
    const clause = part.replace(/\uE000/g, ",").trim();
    if (clause === "") continue;
    out.push(...itemsFromClause(clause));
  }
  return out;
}

function itemsFromClause(clause: string): string[] {
  const item = extractItem(clause);
  if (item === null) return [];
  return expandCounted(item).flatMap((raw) => {
    const name = cleanItem(raw);
    if (name === null) return [];
    if (item.bare && !isBareItem(name)) return [];
    return [name];
  });
}

function extractItem(clause: string): RawItem | null {
  let text = clause.trim();
  if (text === "") return null;
  if (/^B?\d+[FB]\s*→/i.test(text)) return null;
  text = text.replace(
    /^\s*(?:the\s+)?(?:left|right)(?:\s+one)?\s*(?:(?:contains?|containing|holds?)\s+)?/i,
    "",
  );
  text = text.trim();
  if (text === "") return null;

  const arrow = text.lastIndexOf("→");
  if (arrow >= 0) {
    const afterArrow = text.slice(arrow + 1).trim();
    if (afterArrow !== "") return { text: afterArrow, bare: false };
  }

  const rewarded = afterLastMatch(text, /\brewarded with\b/gi);
  if (rewarded !== null) return { text: rewarded, bare: false };

  const contains = afterLastMatch(text, /\b(?:contains?|containing)\b/gi);
  if (contains !== null) return { text: contains, bare: false };

  const another = afterLastMatch(text, /\b(?:another|one more|one last)\b/gi);
  if (
    another !== null &&
    !/^(?:chests?|pots?|barrels?|boxes|crates?|split|rooms?|doors?|areas?|passages?|tunnels?|paths?|stairs?|floors?|levels?)\b/i.test(
      another,
    )
  ) {
    return { text: another, bare: false };
  }

  const prize = afterLastMatch(text, /\b(?:prize is|reward will be|will net you|net you)\b/gi);
  if (prize !== null) return { text: prize, bare: false };

  const contained = afterLastMatch(text, /\b(?:contained|had)\b/gi);
  if (contained !== null) return { text: contained, bare: false };

  const markers = afterLastMatch(
    text,
    /\b(?:find|found|for|with|receive|received|get|obtain|gain)\b/gi,
  );
  if (markers !== null) return { text: markers, bare: false };

  const colon = text.lastIndexOf(":");
  if (colon >= 0) return { text: text.slice(colon + 1), bare: false };

  return { text, bare: true };
}

/** The text after the rightmost occurrence of a lead-in word. */
function afterLastMatch(text: string, pattern: RegExp): string | null {
  let end = -1;
  for (const match of text.matchAll(pattern)) {
    end = match.index + match[0].length;
  }
  return end >= 0 ? text.slice(end).trim() : null;
}

function expandCounted(item: RawItem): string[] {
  const text = item.text.trim();
  const times = /^(.*?)\s*(?:x|×)\s*(\d+)\s*$/i.exec(text);
  if (times?.[1] !== undefined && times[2] !== undefined) {
    const count = Math.min(Number.parseInt(times[2], 10), 20);
    const name = times[1];
    return Array.from({ length: count }, () => name);
  }
  const words = /^(two|three|four|five|six|seven|eight|nine|ten)\s+(.+)$/i.exec(text);
  if (words?.[1] !== undefined && words[2] !== undefined) {
    const count = wordCount(words[1]);
    const name = words[2].replace(/s$/i, "");
    return Array.from({ length: count }, () => name);
  }
  return [text];
}

function wordCount(word: string): number {
  const table: Readonly<Record<string, number>> = {
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  return table[word.toLowerCase()] ?? 1;
}

function cleanItem(raw: string): string | null {
  let item = raw;
  item = item
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ");
  item = item.replace(/^[\s"'“”]+|[\s"'“”]+$/g, "");
  item = item.replace(/[.!?,;:]+$/g, "").trim();
  item = item.split(/[.!?]\s/)[0] ?? item;
  item = item.replace(/^(?:a|an|the)\s+/i, "");
  item = item.replace(
    /^(?:another|yet another|one more|exactly another|just another|one last)\s+/i,
    "",
  );
  item = item.replace(/^(?:two|three|four|five|six|seven|eight|nine|ten)\s+/i, "");
  item = item.replace(/^(?:more|some)\s+/i, "");
  item = item.replace(/\s+(?:x|×)\s*\d+$/i, "");
  item = item.replace(/\s+as a reward\b.*$/i, "");
  item = item.replace(/\s+for such a feat\b.*$/i, "");
  item = item.replace(/\s+for us\b.*$/i, "");
  item = item.replace(/\s+after\s+.*$/i, "");
  item = item.replace(/\s+before\s+.*$/i, "");
  item = item.replace(/\s+for\s+.*$/i, "");
  item = item.replace(/\s+while\s+.*$/i, "");
  item = item.replace(/\s+and\s+.*$/i, "");
  item = item.replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "");
  item = item.replace(/\s+/g, " ").trim();
  if (item === "" || /^(?:nothing|none|n\/a|oxygen|air|\?+|---+)$/i.test(item)) return null;
  if (item.split(/\s+/).length > 6) return null;
  if (
    /\b(?:go|head|open|follow|take|walk|proceed|continue|enter|search|inspect|check|make|use|defeat|watch|find|receive|get|gain|contained|contains|containing|rewarded|prize|reward|chest|chests|pot|pots|barrel|barrels|box|boxes|crate|crates|encounter|tile|tiles|room|door|stairs|stair|staircase|path|floor|hole|split|area|passage|tunnel|front|back|way|level|from|here|there|left|right)\b/i.test(
      item,
    )
  ) {
    return null;
  }
  return item;
}

function isBareItem(item: string): boolean {
  if (item === "" || !/^[A-Z0-9]/.test(item) || item.split(/\s+/).length > 5) return false;
  return !/^(?:Also|Now|Then|So|But|And|Or|The|This|That|These|Those|It|We|You|Your|Our|Their|His|Her|There|Here|If|When|After|Before|Once|Next|First|Second|Third|Fourth|Fifth|Sixth|Left|Right|Open|Head|Go|Take|Follow|Walk|Proceed|Continue|Enter|Search|Inspect|Check|Make|Use|Defeat|Watch|Find|Receive|Get|Gain|Another|Contents)\b/.test(
    item,
  );
}

function classify(line: string): GuideStepKind {
  for (const candidate of KIND_WORDS) {
    if (candidate.pattern.test(line)) return candidate.kind;
  }
  return "note";
}
