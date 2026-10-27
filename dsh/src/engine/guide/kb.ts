/**
 * The guide knowledge base (control plan §4.11), ported from ffpr_agent/guide/kb.py: what the
 * walkthroughs say about an area, a monster or a boss, looked up by Chinese, Japanese or
 * English name, or by bestiary number (the number the game's bestiary gives a monster, which
 * the bridge reads in battle).
 *
 * Sources, all fetched by `fetch` into .deps/knowledge/ff5 (a local cache for our own play,
 * never committed; every answer names its source):
 * - the Steam Community walkthrough for the Pixel Remaster (the user's pick, 10-21): the whole
 *   game in 77 sections, with shops, each area's monsters by number, boss stat tables;
 * - the Steam simplified bestiary: number → English name for all 302 enemies;
 * - ludo.guide's walkthrough: World 1 in 30 short chapters, with tips such as "RUN from
 *   Jackanapes".
 *
 *     const guide = await Guide.load();
 *     guide?.lookup("沃尔斯城"); // the Walse sections
 *     guide?.lookup("30");       // Jackanapes, wherever the guides mention it
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEPS } from "../paths.ts";
import { describeError, isMissingFile } from "../errors.ts";
import { isRecord, list, records, text, type Json } from "../values.ts";
import * as ludo from "./ludo.ts";
import { asDict, type Chapter } from "./ludo.ts";
import * as steam from "./steam.ts";
import type { ShopTable, SteamSection, Treasure } from "./steam.ts";

export const HOME = join(DEPS, "knowledge", "ff5");
const TOUGH = /\brun\b|tough|avoid|dangerous|careful|one-visit/i;
export const INDEX_FILE = join(HOME, "guide.json");

// English area names as the Steam walkthrough titles them → the game's Chinese names (seen in
// the probe logs, 10-20) and Japanese map names. Areas not visited yet carry the names the
// English suggests; anything unmatched falls back to a text search.
const AREAS: Readonly<Record<string, readonly string[]>> = {
  Prologue: ["泰空陨石", "タイクーンの隕石"],
  Tule: ["图尔村", "佐克的家", "トゥールの村"],
  "Wind Shrine": ["风之神殿", "風の神殿"],
  "Pirate's Hideout": ["海盗据点", "海盗船", "海賊のアジト"],
  "Torna Canal": ["托纳运河", "トルナ運河"],
  "Ship Graveyard": ["船舶墓场", "沉船", "船の墓場"],
  Carwen: ["卡文镇", "カーウェン"],
  "North Mountain": ["北山", "北の山"],
  "Castle Tycoon": ["泰空城", "タイクーン城"],
  Walse: ["沃尔斯城", "沃尔斯镇", "ウォルス城", "ウォルスの町"],
  "Tower of Walse": ["沃尔斯塔", "水晶之间", "ウォルスの塔"],
  Karnak: ["卡纳克镇", "卡纳克", "カルナック"],
  "Fire-Powered Ship": ["火力船"],
  "Karnak Castle": ["卡纳克城", "カルナック城"],
  "Walse & Karnak Meteorites": ["卡纳克陨石地", "沃尔斯陨石地"],
  "Library of the Ancients": ["古代图书馆", "古代図書館"],
  Crescent: ["克雷森特", "クレセント"],
  "Black Chocobo Forest": ["黑陆行鸟森林", "黒チョコボの森"],
  Istory: ["伊斯托里", "イストリー"],
  Jachol: ["贾克尔", "ジャコール"],
  Lix: ["里克斯村", "巴兹的家", "リックスの村"],
  "Desert of Shifting Sands": ["流沙沙漠", "流砂の砂漠"],
  Gohn: ["戈恩", "滅びの町ゴーン"],
  "Tycoon Meteorite": ["泰空陨石", "タイクーンの隕石"],
  "Ronka Ruins": ["罗卡遗迹", "ロンカ遺跡"],
};

/** Download the guides (each page once; `refresh` again), parse them, write guide.json. */
export async function fetch(
  home: string = HOME,
  refresh = false,
  pause = 1.0,
  say: (message: string) => void = console.log,
  signal?: AbortSignal,
): Promise<string> {
  await mkdir(home, { recursive: true });
  const headers = { "User-Agent": "Mozilla/5.0 (FFPR-Agent guide cache; personal use)" };

  const get = async (name: string, url: string): Promise<string> => {
    const path = join(home, "pages", `${name}.html`);
    if (!refresh) {
      try {
        return await readFile(path, { encoding: "utf8", signal });
      } catch (error) {
        if (!isMissingFile(error)) {
          signal?.throwIfAborted();
          throw new Error(`读不了攻略缓存 ${path}:${describeError(error)}`, { cause: error });
        }
      }
    }
    await mkdir(dirname(path), { recursive: true });
    const timeout = AbortSignal.timeout(60_000);
    const response = await globalThis.fetch(url, {
      headers,
      redirect: "follow",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`下载 ${url} 失败:HTTP ${response.status}`);
    const body = await response.text();
    await writeFile(path, body, "utf8");
    if (pause > 0) await delay(pause * 1000, signal);
    return body;
  };

  const names = steam.bestiary(await get("steam-bestiary", steam.BESTIARY));
  const monsters: ReadonlySet<string> = new Set(names.values());
  const walkthrough = steam.sections(await get("steam-walkthrough", steam.WALKTHROUGH));
  for (const section of walkthrough) {
    section.shops = steam.shops(section, monsters);
    section.treasures = steam.treasures(section, monsters);
  }
  say(
    `  Steam 攻略:${walkthrough.length} 节,` +
      `${walkthrough.reduce((sum, section) => sum + (section.shops?.length ?? 0), 0)} 张商店表,` +
      `${walkthrough.reduce((sum, section) => sum + (section.treasures?.length ?? 0), 0)} 条宝箱和拾取物`,
  );
  say(`  Steam 图鉴:${names.size} 种怪物`);
  const missables = steam.sections(await get("steam-missables", steam.MISSABLES));
  say(`  Steam 可错过内容:${missables.length} 节`);
  const chapters: Chapter[] = [];
  for (const slug of ludo.slugs(await get("ludo-index", ludo.INDEX))) {
    chapters.push(ludo.parse(slug, await get(`ludo-${slug}`, `${ludo.BASE}/${slug}`)));
  }
  say(`  ludo.guide:${chapters.length} 章`);
  const data: Json = {
    fetched: shanghaiDate(),
    sources: {
      walkthrough: steam.WALKTHROUGH,
      bestiary: steam.BESTIARY,
      missables: steam.MISSABLES,
      ludo: ludo.BASE,
    },
    walkthrough,
    missables,
    bestiary: Object.fromEntries(
      [...names.entries()]
        .sort(([left], [right]) => left - right)
        .map(([number, name]) => [String(number), name]),
    ),
    ludo: chapters.map(asDict),
  };
  const out = join(home, "guide.json");
  await writeFile(out, JSON.stringify(data, null, 1), "utf8");
  return out;
}

export class Guide {
  readonly walkthrough: readonly SteamSection[];
  readonly bestiary: ReadonlyMap<number, string>;
  readonly ludo: readonly Chapter[];
  readonly missables: readonly SteamSection[];
  readonly sources: Readonly<Record<string, string>>;

  constructor(
    walkthrough: readonly SteamSection[],
    bestiary: ReadonlyMap<number, string>,
    ludo: readonly Chapter[] = [],
    missables: readonly SteamSection[] = [],
    sources: Readonly<Record<string, string>> = {},
  ) {
    this.walkthrough = walkthrough;
    this.bestiary = bestiary;
    this.ludo = ludo;
    this.missables = missables;
    this.sources = sources;
  }

  static async load(path: string = INDEX_FILE, signal?: AbortSignal): Promise<Guide | null> {
    let body: string;
    try {
      body = await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (isMissingFile(error)) return null;
      signal?.throwIfAborted();
      throw new Error(`读不了攻略索引 ${path}:${describeError(error)}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`读不懂攻略索引 ${path}:${describeError(error)}`, { cause: error });
    }
    if (!isRecord(parsed)) throw new Error(`攻略索引 ${path} 不是 JSON 对象`);
    const bestiary = new Map<number, string>();
    for (const [key, value] of Object.entries(isRecord(parsed.bestiary) ? parsed.bestiary : {})) {
      const number = Number.parseInt(key, 10);
      const name = text(value);
      if (Number.isFinite(number) && name !== undefined) bestiary.set(number, name);
    }
    const sources: Record<string, string> = {};
    for (const [key, value] of Object.entries(isRecord(parsed.sources) ? parsed.sources : {})) {
      const source = text(value);
      if (source !== undefined) sources[key] = source;
    }
    const chapters = readChapters(parsed.ludo);
    // The pages are the source, guide.json only an index: re-read the cached chapters so a
    // parser fix (task 07: monster elements, 10-27) reaches an index fetched before it.
    if (path === INDEX_FILE) await refreshLudoMonsters(chapters, signal);
    return new Guide(
      readSections(parsed.walkthrough),
      bestiary,
      chapters,
      readSections(parsed.missables),
      sources,
    );
  }

  /** English area names the query means: by Chinese / Japanese alias or by English. */
  areasFor(query: string): string[] {
    const trimmed = query.trim().toLowerCase();
    // A game map name carries a room suffix ("卡纳克镇 旅店", "沃尔斯塔 １层"); match the
    // part before the first space as well. English names with spaces still match whole.
    const queries = [...new Set([trimmed, trimmed.split(/\s+/, 1)[0] ?? trimmed])];
    const exact: string[] = [];
    const loose: string[] = [];
    for (const [key, aliases] of Object.entries(AREAS)) {
      const names = [key.toLowerCase(), ...aliases.map((alias) => alias.toLowerCase())];
      if (queries.some((q) => names.some((name) => q === name))) {
        exact.push(key);
      } else if (
        queries.some((q) =>
          names.some(
            (name) =>
              (codePointLength(name) > 1 && q.includes(name)) ||
              (codePointLength(q) > 2 && name.includes(q)),
          ),
        )
      ) {
        loose.push(key);
      }
    }
    return exact.length > 0 ? exact : loose;
  }

  /** The walkthrough sections for an area (an exact title first), and ludo's tips. */
  area(query: string, limit = 3500, part = 1): string {
    const keys = this.areasFor(query);
    if (keys.length === 0) return "";
    const sections = this.sectionsFor(query);
    const exact = sections.filter((section) => keys.includes(section.title));
    const loose = sections.filter((section) => !exact.includes(section));
    const texts = [...exact, ...loose.slice(0, 1)].map(
      (section) => `【${section.title}】\n${section.text}`,
    );
    const tips = this.ludo
      .filter((chapter) =>
        keys.some((key) => chapter.title.toLowerCase().includes(key.toLowerCase())),
      )
      .flatMap((chapter) => chapter.tips);
    if (tips.length > 0)
      texts.push("ludo.guide 提示:\n" + tips.map((tip) => `- ${tip}`).join("\n"));
    return page(texts.join("\n\n"), limit, part, this.sources.walkthrough ?? "");
  }

  /**
   * Where the guides mention a monster (by bestiary number or English name): the lines around
   * each mention, with the section's title, and ludo's line for it.
   */
  monster(query: string, context = 10, limit = 3000): string {
    let name = query.trim();
    let number: number | null = null;
    if (/^\d+$/.test(name.replace(/^#+/, ""))) {
      number = Number.parseInt(name.replace(/^#+/, ""), 10);
      name = this.bestiary.get(number) ?? "";
    }
    if (!name) return "";
    const out = [
      number !== null ? `图鉴 #${String(number).padStart(3, "0")}:${name}` : `怪物:${name}`,
    ];
    const word = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
    for (const section of this.walkthrough) {
      const lines = section.text.split("\n");
      const hits = lines.flatMap((line, index) => (word.test(line) ? [index] : []));
      const first = hits[0];
      if (first !== undefined) {
        out.push(
          `【${section.title}】\n` +
            lines.slice(Math.max(0, first - 3), first + context).join("\n"),
        );
      }
    }
    for (const chapter of this.ludo) {
      for (const monster of chapter.monsters) {
        if (monster.name.toLowerCase() === name.toLowerCase()) {
          out.push(`ludo.guide:${pythonRepr(monsterJson(monster))}`);
        }
      }
      out.push(
        ...chapter.tips.filter((tip) => word.test(tip)).map((tip) => `ludo.guide 提示:${tip}`),
      );
      out.push(
        ...chapter.steps.filter((step) => word.test(step)).map((step) => `ludo.guide 步骤:${step}`),
      );
    }
    if (out.length === 1) return "";
    return page([...new Set(out)].join("\n\n"), limit, 1, this.sources.walkthrough ?? "");
  }

  /**
   * Short things to know before going in: one-visit locations, missables, and the tips that
   * tell to run or call something tough.
   */
  warnings(area: string, limit = 5): string[] {
    const keys = this.areasFor(area);
    const out: string[] = [];
    for (const section of this.walkthrough) {
      if (!keys.includes(section.title)) continue;
      for (const line of section.text.split("\n")) {
        if (line.startsWith("WARNING") || line.includes("one-visit")) out.push(line);
      }
    }
    for (const chapter of this.ludo) {
      if (keys.some((key) => chapter.title.toLowerCase().includes(key.toLowerCase()))) {
        out.push(...chapter.tips.filter((tip) => TOUGH.test(tip)));
      }
    }
    return [...new Set(out)].slice(0, limit);
  }

  /**
   * One monster's line and the sentences about it, short. The old version took every line that
   * mentioned the name, which dragged a whole "Engine Room Section 4: ... Boss ... Chests ..."
   * step in for each of its four monsters (10-27). Keep only ludo's own row and sentences whose
   * subject is this monster.
   */
  monsterNote(book: number, limit = 300): string {
    const name = this.bestiary.get(book);
    if (name === undefined) return "";
    const word = monsterNamePattern(name);
    if (word === null) return "";
    const notes: string[] = [];
    const seen = new Set<string>();
    const add = (value: string): void => {
      const note = value.trim();
      if (note === "" || seen.has(note)) return;
      seen.add(note);
      notes.push(note);
    };
    let rowAdded = false;
    for (const chapter of this.ludo) {
      const monster = chapter.monsters.find(
        (known) => known.book === book || known.name.toLowerCase() === name.toLowerCase(),
      );
      if (monster === undefined) continue;
      if (!rowAdded) {
        add(monsterRow(monster));
        rowAdded = true;
      }
      for (const line of [...chapter.tips, ...chapter.steps]) {
        if (!word.test(line)) continue;
        for (const sentence of sentences(line)) {
          if (isAboutMonster(sentence, name, this.bestiary, true)) add(sentence);
        }
      }
    }
    for (const section of this.walkthrough) {
      for (const line of section.text.split("\n")) {
        if (!word.test(line)) continue;
        for (const sentence of sentences(line)) {
          if (isAboutMonster(sentence, name, this.bestiary, false)) add(sentence);
        }
      }
    }
    return notes.length > 0 ? codePointSlice(notes.join(" / "), 0, limit) : "";
  }

  /**
   * The walkthrough sections for an area: an exact title first, then titles that contain it
   * (Tower of Walse for Walse comes last).
   */
  sectionsFor(query: string): SteamSection[] {
    const keys = this.areasFor(query);
    const exact = this.walkthrough.filter((section) => keys.includes(section.title));
    const loose = this.walkthrough.filter(
      (section) =>
        !exact.includes(section) &&
        keys.some((key) => section.title.toLowerCase().includes(key.toLowerCase())),
    );
    return [...exact, ...loose];
  }

  /**
   * What the area's shops sell: the inn's price, items, weapons, armour, magic, with prices
   * and what each does (English names; the game shows them in Chinese).
   */
  shops(query: string, limit = 2500): string {
    const out: string[] = [];
    for (const section of this.sectionsFor(query).slice(0, 1)) {
      for (const shop of section.shops ?? []) {
        const goods = shop.goods
          .map(
            (good) =>
              `${good.name} ${good.cost !== null ? String(good.cost) : "?"}` +
              (good.note ? `(${good.note})` : ""),
          )
          .join(";");
        out.push(`${shop.kind}(${shop.where}):${goods}`);
      }
      if (out.length > 0) {
        out.splice(0, 0, `【${section.title}】的商店(攻略里的英文名,游戏里是中文名):`);
      }
    }
    return out.length > 0 ? page(out.join("\n"), limit, 1, this.sources.walkthrough ?? "") : "";
  }

  /**
   * The area's chests ([n/225]) and hidden items ({n/46}, pots, barrels, bushes), each with
   * where it is and how the guide finds it.
   */
  treasures(query: string, limit = 2500): string {
    const out: string[] = [];
    for (const section of this.sectionsFor(query).slice(0, 1)) {
      for (const treasure of section.treasures ?? []) {
        const mark =
          treasure.kind === "chest" ? `宝箱 [${treasure.n}/225]` : `拾取物 {${treasure.n}/46}`;
        out.push(`${mark} ${treasure.where}:${treasure.text}`);
      }
      if (out.length > 0) {
        out.splice(0, 0, `【${section.title}】的宝箱和可拾取物品:`);
      }
    }
    return out.length > 0 ? page(out.join("\n"), limit, 1, this.sources.walkthrough ?? "") : "";
  }

  /**
   * An area, a monster (number or name) or anything else: the area's sections, the monster's
   * mentions, or the walkthrough's lines that contain the words. `kind` "shop" or "treasure"
   * gives only the area's shops or its chests and hidden items.
   */
  lookup(query: string, part = 1, kind = "area"): string {
    const q = query.trim();
    if (!q) return "";
    if (kind === "shop") return this.shops(q);
    if (kind === "treasure") return this.treasures(q);
    if (/^\d+$/.test(q.replace(/^#+/, ""))) return this.monster(q);
    const found = this.area(q, 3500, part);
    if (found) return found;
    if ([...this.bestiary.values()].some((name) => name.toLowerCase() === q.toLowerCase())) {
      return this.monster(q);
    }
    return this.search(q);
  }

  search(query: string, limit = 3000): string {
    const word = query.toLowerCase();
    const out: string[] = [];
    for (const section of [...this.walkthrough, ...this.missables]) {
      const lines = section.text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (line.toLowerCase().includes(word)) {
          out.push(`【${section.title}】\n` + lines.slice(Math.max(0, i - 2), i + 6).join("\n"));
          break;
        }
      }
    }
    return out.length > 0 ? page(out.join("\n\n"), limit, 1, this.sources.walkthrough ?? "") : "";
  }
}

/** One `limit`-sized part of a long answer, numbered, with the source. */
function page(text: string, limit: number, part: number, source: string): string {
  const parts = Math.max(1, Math.ceil(codePointLength(text) / limit));
  const current = Math.min(Math.max(part, 1), parts);
  const body = codePointSlice(text, (current - 1) * limit, current * limit);
  const more =
    current < parts ? `\n(第 ${current}/${parts} 段;要看后面就带 part=${current + 1} 再查)` : "";
  return `${body}${more}\n出处:${source}`;
}

function readSections(value: unknown): SteamSection[] {
  return records(value).map((raw) => {
    const section: SteamSection = { title: text(raw.title) ?? "", text: text(raw.text) ?? "" };
    if (Array.isArray(raw.shops)) section.shops = records(raw.shops) as unknown as ShopTable[];
    if (Array.isArray(raw.treasures)) {
      section.treasures = records(raw.treasures) as unknown as Treasure[];
    }
    return section;
  });
}

/**
 * Replace each chapter's monsters with what its cached page parses to now. A missing cache or
 * page keeps the index's copy; an unreadable page is an error like any other guide read.
 */
async function refreshLudoMonsters(chapters: Chapter[], signal?: AbortSignal): Promise<void> {
  const directory = join(HOME, "pages");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return;
    signal?.throwIfAborted();
    throw new Error(`读不了攻略缓存目录 ${directory}:${describeError(error)}`, { cause: error });
  }
  const pages = new Map(
    names
      .filter((name) => name.startsWith("ludo-") && name.endsWith(".html"))
      .map((name) => [name.slice("ludo-".length, -".html".length), name]),
  );
  for (const chapter of chapters) {
    const page = pages.get(chapter.slug);
    if (page === undefined) continue;
    const html = await readFile(join(directory, page), { encoding: "utf8", signal });
    chapter.monsters = ludo.parse(chapter.slug, html).monsters;
  }
}

function readChapters(value: unknown): Chapter[] {
  return records(value).map((raw) => {
    const chapter: Chapter = {
      slug: text(raw.slug) ?? "",
      title: text(raw.title) ?? "",
      url: text(raw.url) ?? "",
      summary: text(raw.summary) ?? "",
      prerequisites: stringList(raw.prerequisites),
      steps: stringList(raw.steps),
      tips: stringList(raw.tips),
      monsters: records(raw.monsters).map((monster) => ({
        book: typeof monster.book === "number" ? monster.book : 0,
        name: text(monster.name) ?? "",
        area: text(monster.area) ?? "",
        level: typeof monster.level === "number" ? monster.level : null,
        hp: typeof monster.hp === "number" ? monster.hp : null,
        weak: stringList(monster.weak),
        absorb: stringList(monster.absorb),
        immune: stringList(monster.immune),
        steal: text(monster.steal) ?? "",
        drop: text(monster.drop) ?? "",
        blue: text(monster.blue) ?? "",
        notes: text(monster.notes) ?? "",
        row: text(monster.row) ?? "",
      })),
      bosses: stringMap(raw.bosses),
      items: stringMap(raw.items),
      previous: text(raw.previous) ?? "",
      next: text(raw.next) ?? "",
    };
    return chapter;
  });
}

function stringList(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === "string");
}

function stringMap(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, items] of Object.entries(isRecord(value) ? value : {})) {
    out[key] = stringList(items);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** ludo's own row for a monster, or one rebuilt from the parsed fields (old indexes have no row). */
function monsterRow(monster: Chapter["monsters"][number]): string {
  const row = typeof monster.row === "string" ? monster.row : "";
  if (row !== "") return row;
  const number = monster.book > 0 ? `${String(monster.book).padStart(3, "0")} ` : "";
  const head = `${number}${monster.name} (Level ${pythonValue(monster.level)}, HP ${pythonValue(monster.hp)})`;
  const details: string[] = [];
  if (monster.steal !== "") details.push(`Steals ${monster.steal}`);
  if (monster.drop !== "") details.push(`Drop: ${monster.drop}`);
  if (monster.blue !== "") details.push(`Blue Magic: ${monster.blue}`);
  if (monster.weak.length > 0) details.push(`Weak to ${monster.weak.join(", ")}`);
  if (monster.absorb.length > 0) details.push(`Absorbs ${monster.absorb.join(", ")}`);
  if (monster.immune.length > 0) details.push(`Immune to ${monster.immune.join(", ")}`);
  if (monster.notes !== "") details.push(monster.notes);
  return details.length > 0 ? `${head}: ${details.join(". ")}.` : head;
}

/** Split a guide line into sentences; guide rows often share one line with prose. */
function sentences(line: string): string[] {
  return line
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

/**
 * Whether a sentence is about this monster: it starts with the name, or (for ludo's advice)
 * names this monster and no other. Numbered bestiary rows are left to monsterRow.
 */
function isAboutMonster(
  sentence: string,
  name: string,
  bestiary: ReadonlyMap<number, string>,
  allowObject: boolean,
): boolean {
  const trimmed = sentence.trim();
  if (/^\d{3}\s/.test(trimmed)) return false;
  if (codePointLength(trimmed) <= codePointLength(name)) return false;
  const clean = monsterName(name);
  const own = monsterNamePattern(name);
  if (clean === "" || !own?.test(trimmed)) return false;
  const subject = new RegExp(`^\\s*(?:the\\s+)?${escapeRegExp(clean)}\\b`, "i");
  if (subject.test(trimmed)) return true;
  if (!allowObject) return false;
  for (const other of bestiary.values()) {
    if (other.toLowerCase() === name.toLowerCase()) continue;
    const pattern = monsterNamePattern(other);
    if (pattern?.test(trimmed)) return false;
  }
  return true;
}

/** A bestiary name without decoration such as Liquid Flame's trailing star. */
function monsterName(name: string): string {
  return name.replace(/[^\p{L}\p{N}' -]/gu, "").trim();
}

function monsterNamePattern(name: string): RegExp | null {
  const clean = monsterName(name);
  return clean === "" ? null : new RegExp(`\\b${escapeRegExp(clean)}\\b`, "i");
}

/** Python's f-string on a JSON value: None prints as "None". */
function pythonValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value) || "";
}

/** A ludo monster without empty new element fields, so old answers keep their exact text. */
function monsterJson(monster: Chapter["monsters"][number]): Json {
  return {
    book: monster.book,
    name: monster.name,
    area: monster.area,
    level: monster.level,
    hp: monster.hp,
    weak: monster.weak,
    ...(monster.absorb.length > 0 ? { absorb: monster.absorb } : {}),
    ...(monster.immune.length > 0 ? { immune: monster.immune } : {}),
    steal: monster.steal,
    drop: monster.drop,
    blue: monster.blue,
    notes: monster.notes,
  };
}

/** Python's repr() for the JSON dicts ludo keeps: single quotes, True/False/None. */
function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(", ")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${pythonRepr(key)}: ${pythonRepr(item)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value) || "";
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function codePointSlice(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("操作已取消", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("操作已取消", "AbortError"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function shanghaiDate(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
