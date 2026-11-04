/**
 * What each monster is weak to, absorbs and is immune to (task 07): knowledge from the
 * walkthrough's monster lines plus what a battle taught us, merged and kept in
 * .deps/ds/elements-ff5.json. Enemy rows are keyed by the bestiary number (`book`) when they
 * have one, otherwise by name, because the game shows Chinese names in battle while the guide
 * writes them in English.
 *
 *     const elements = await Elements.load(path, guide?.ludo);
 *     elements.lookup({ book: 39, name: "败怨魔" }); // 弱 冰
 *     await elements.learnAbsorb(enemy, "冰");        // HP rose: it absorbs ice
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEPS } from "./paths.ts";
import { describeError, isMissingFile } from "./errors.ts";
import type { Chapter, Monster } from "./guide/ludo.ts";
import { isRecord, list, num, text, type Json } from "./values.ts";

/** The eight elements, as the rules and the bridge's magic names use them. */
export const ELEMENTS = ["火", "冰", "雷", "水", "风", "土", "圣", "毒"] as const;
export type Element = (typeof ELEMENTS)[number];

export const DEFAULT_FILE = join(DEPS, "ds", "elements-ff5.json");

// The walkthrough writes the English names; Thunder is the same element as Lightning.
const ELEMENT_NAMES: ReadonlyMap<string, Element> = new Map([
  ["fire", "火"],
  ["ice", "冰"],
  ["lightning", "雷"],
  ["thunder", "雷"],
  ["water", "水"],
  ["wind", "风"],
  ["air", "风"],
  ["earth", "土"],
  ["holy", "圣"],
  ["poison", "毒"],
  ...ELEMENTS.map((element) => [element, element] as const),
]);

/** An English or Chinese element name as a single Chinese character, or null. */
export function toElement(name: string): Element | null {
  return ELEMENT_NAMES.get(name.trim().toLowerCase()) ?? null;
}

export function isElement(value: string): value is Element {
  return (ELEMENTS as readonly string[]).includes(value);
}

/** What a battle row is known to do with an element; all three lists are Chinese. */
export interface EnemyResistances {
  readonly weak: readonly Element[];
  readonly absorb: readonly Element[];
  readonly immune: readonly Element[];
}

/** A source of element knowledge: battle choices only need to look rows up. */
export interface ElementKnowledge {
  lookup(enemy: unknown): EnemyResistances | null;
}

/** Element knowledge that can also grow from a battle. */
export interface ElementLearner extends ElementKnowledge {
  learnAbsorb(enemy: unknown, element: string): Promise<string | null>;
}

interface Entry {
  key: string;
  name: string;
  book: number | null;
  weak: Element[];
  absorb: Element[];
  immune: Element[];
}

/** `败怨魔(弱 冰;吸收 —)` body: the known rows, — when the guide knows none. */
export function describeElements(info: EnemyResistances): string {
  const weak = info.weak.length > 0 ? info.weak.join("、") : "—";
  const absorb = info.absorb.length > 0 ? info.absorb.join("、") : "—";
  const immune = info.immune.length > 0 ? `;无效 ${info.immune.join("、")}` : "";
  return `弱 ${weak};吸收 ${absorb}${immune}`;
}

/** Guide names carry a ☆ for bosses and may differ in case from the bestiary. */
function normalizeName(name: string): string {
  return name.replace(/[☆★*]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function addUnique(target: Element[], items: readonly Element[]): void {
  for (const item of items) if (!target.includes(item)) target.push(item);
}

function elementsOf(names: readonly string[] | undefined): Element[] {
  const out: Element[] = [];
  for (const name of names ?? []) {
    const element = toElement(name);
    if (element !== null && !out.includes(element)) out.push(element);
  }
  return out;
}

/**
 * Enemy element knowledge. `load` merges the guide's lists with the file of what battles
 * learned; `fromChapters` builds the guide half alone, for tests and callers that already
 * have the walkthrough in memory.
 */
export class Elements implements ElementLearner {
  readonly path: string | undefined;
  private readonly byKey = new Map<string, Entry>();
  private readonly byBook = new Map<number, Entry>();
  private readonly byName = new Map<string, Entry>();

  constructor(path?: string) {
    this.path = path;
  }

  static fromChapters(
    chapters: readonly Chapter[],
    bestiary: ReadonlyMap<number, string> = new Map(),
    path?: string,
  ): Elements {
    const elements = new Elements(path);
    for (const chapter of chapters) elements.addChapter(chapter, bestiary);
    return elements;
  }

  static async load(
    path: string = DEFAULT_FILE,
    chapters: readonly Chapter[] = [],
    signal?: AbortSignal,
    bestiary: ReadonlyMap<number, string> = new Map(),
  ): Promise<Elements> {
    const elements = Elements.fromChapters(chapters, bestiary, path);
    await elements.read(signal);
    return elements;
  }

  addChapter(chapter: Chapter, bestiary: ReadonlyMap<number, string> = new Map()): void {
    for (const monster of chapter.monsters) this.addGuide(monster, bestiary);
  }

  private addGuide(monster: Monster, bestiary: ReadonlyMap<number, string>): void {
    const book = monster.book > 0 ? monster.book : this.bookOf(monster.name, bestiary);
    const entry = this.ensure(book, monster.name);
    addUnique(entry.weak, elementsOf(monster.weak));
    addUnique(entry.absorb, elementsOf(monster.absorb));
    addUnique(entry.immune, elementsOf(monster.immune));
    // A learned absorb beats the guide's weakness, even when the guide is merged after it.
    entry.weak = entry.weak.filter((element) => !entry.absorb.includes(element));
  }

  /** The bestiary number whose English name matches, for a boss the page names only. */
  private bookOf(name: string, bestiary: ReadonlyMap<number, string>): number | null {
    const wanted = normalizeName(name);
    for (const [number, candidate] of bestiary) {
      if (normalizeName(candidate) === wanted) return number;
    }
    return null;
  }

  private ensure(book: number | null, name: string): Entry {
    const key = book !== null ? String(book) : normalizeName(name);
    let entry = this.byKey.get(key);
    if (entry === undefined) {
      entry = { key, name, book, weak: [], absorb: [], immune: [] };
      this.byKey.set(key, entry);
    }
    if (name) {
      entry.name = entry.name || name;
      this.byName.set(normalizeName(name), entry);
    }
    if (book !== null) this.byBook.set(book, entry);
    return entry;
  }

  lookup(enemy: unknown): EnemyResistances | null {
    if (!isRecord(enemy)) return null;
    const book = num(enemy.book);
    if (book !== undefined) {
      const entry = this.byBook.get(book);
      if (entry !== undefined) return entry;
    }
    const name = text(enemy.name);
    if (name !== undefined) return this.byName.get(normalizeName(name)) ?? null;
    return null;
  }

  /** The row's entry, created on first sight when it has a number or a name. */
  private entryFor(enemy: unknown): Entry | null {
    const known = this.lookup(enemy);
    if (known !== null) return known as Entry;
    if (!isRecord(enemy)) return null;
    const book = num(enemy.book) ?? null;
    const name = text(enemy.name) ?? "";
    if (book === null && name === "") return null;
    return this.ensure(book, name);
  }

  /**
   * Record an element the enemy absorbed (its HP rose after the hit) and save. Returns what
   * to tell the player, or null when it was already known.
   */
  async learnAbsorb(enemy: unknown, element: string): Promise<string | null> {
    const wanted = toElement(element);
    const entry = this.entryFor(enemy);
    if (wanted === null || entry === null || entry.absorb.includes(wanted)) return null;
    entry.absorb.push(wanted);
    entry.weak = entry.weak.filter((known) => known !== wanted);
    entry.immune = entry.immune.filter((known) => known !== wanted);
    await this.save();
    const name = (isRecord(enemy) ? text(enemy.name) : undefined) ?? entry.name;
    return `${name} 吸收${wanted},以后不对它用${wanted}`;
  }

  async save(): Promise<void> {
    if (this.path === undefined) return;
    await mkdir(dirname(this.path), { recursive: true });
    // Only what battles learned belongs in this file; the guide half is rebuilt from the
    // pages on every load, so an updated guide is never overridden by stale saved lists.
    const data: Record<string, Json> = {};
    for (const entry of this.byKey.values()) {
      if (entry.absorb.length === 0) continue;
      data[entry.key] = { name: entry.name, book: entry.book, absorb: entry.absorb };
    }
    try {
      await writeFile(this.path, JSON.stringify(data, null, 1), "utf8");
    } catch (error) {
      throw new Error(`写不了属性知识 ${this.path}:${describeError(error)}`, { cause: error });
    }
  }

  private async read(signal?: AbortSignal): Promise<void> {
    if (this.path === undefined) return;
    let body: string;
    try {
      body = await readFile(this.path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return;
      signal?.throwIfAborted();
      throw new Error(`读不了属性知识 ${this.path}:${describeError(error)}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂属性知识 ${this.path}:${describeError(error)}`, { cause: error });
    }
    if (!isRecord(parsed)) throw new Error(`属性知识 ${this.path} 不是 JSON 对象`);
    for (const [key, raw] of Object.entries(parsed)) {
      if (!isRecord(raw)) continue;
      const name = text(raw.name) ?? key;
      const stored = num(raw.book);
      const book = stored ?? (/^\d+$/.test(key) ? Number(key) : null);
      const entry = this.ensure(book, name);
      addUnique(entry.weak, elementsOf(stringList(raw.weak)));
      addUnique(entry.absorb, elementsOf(stringList(raw.absorb)));
      addUnique(entry.immune, elementsOf(stringList(raw.immune)));
      // The file's absorb was learned in battle; it overrides the guide's weakness.
      entry.weak = entry.weak.filter((element) => !entry.absorb.includes(element));
      entry.immune = entry.immune.filter((element) => !entry.absorb.includes(element));
    }
  }
}

function stringList(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === "string");
}
