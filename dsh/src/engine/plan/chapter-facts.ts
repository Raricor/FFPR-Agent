/**
 * Task 150: one chapter's whole fact sheet. A chapter is several walkthrough sections, so this
 * module calls the existing per-section builder (`facts.ts`) once per section, then adds what
 * only a multi-section view can show: hidden items on every map in the chapter, every shop with
 * its counter cell and prices, and each map's encounters with exp / gil / ABP and the bestiary
 * and blue-magic state. The Chinese text is what the model reads before writing one chapter plan.
 *
 * `buildChapterFacts` is pure: game-file data (hidden item spots, clerk NPCs, rewards) is
 * passed in, read once by `knowledge/chapter-files.ts`. `buildChapterFactsFromDisk` is the
 * runtime convenience that does that read; nothing here talks to the game.
 */

import type { Guide } from "../guide/kb.ts";
import { SHOP_KINDS } from "../guide/steam.ts";
import { cleanName } from "../icons.ts";
import { readChapterFileData } from "../knowledge/chapter-files.ts";
import type { GameMapFile, MonsterReward } from "../knowledge/game-files.ts";
import {
  areaKeys,
  monstersIn,
  normalizeName,
  type Knowledge,
  type MonsterKnowledge,
} from "../knowledge/index.ts";
import type { Cell } from "../nav.ts";
import { sectionFinished } from "../stage/route-book-load.ts";
import type { RouteBookSave, RouteSection } from "../stage/route-book.ts";
import type {
  ChapterEncounterMap,
  ChapterFactsData,
  ChapterHiddenItem,
  ChapterRange,
  ChapterShop,
} from "./chapter-types.ts";
import {
  describeChapterSectionFacts,
  segmentFacts,
  type SegmentFactsBagItem,
  type SegmentFactsBoss,
  type SegmentFactsPartyMember,
} from "./facts.ts";

/** One chapter's text is one prompt; past this the hard tail is cut. */
export const CHAPTER_FACTS_LIMIT = 32_000;

const MAX_SECTION_TEXT = 5_000;
const MAX_HIDDEN_ROWS = 160;
const MAX_SHOP_ROWS = 80;
const MAX_ENCOUNTER_ROWS = 200;

const EMPTY_SAVE: RouteBookSave = {
  bestiary: null,
  blueMagic: null,
  jobs: null,
  openedChests: null,
};

export interface ChapterFactsInput {
  readonly chapter: ChapterRange;
  /** The route book's sections; each chapter section is matched by `RouteSection.order`. */
  readonly sections: readonly RouteSection[];
  readonly knowledge: Knowledge;
  readonly save?: RouteBookSave | null;
  readonly party?: readonly SegmentFactsPartyMember[];
  readonly bag?: readonly SegmentFactsBagItem[];
  readonly gil?: number;
  readonly currentMapId?: number | null;
  /** The exported map files (hidden items and clerk cells); absent means those tables are empty. */
  readonly files?: readonly GameMapFile[] | null;
  /** `monster.csv` rewards by monster id; absent means exp / gil / ABP stay null. */
  readonly rewards?: ReadonlyMap<number, MonsterReward> | null;
  readonly guide?: Guide | null;
}

function sectionTitle(
  section: RouteSection,
  index: number,
  guide: Guide | null | undefined,
): string {
  const fromGuide = guide?.walkthrough[index]?.title;
  if (fromGuide !== undefined && fromGuide.trim() !== "") return fromGuide.trim();
  return section.title;
}

/** Build the structured chapter sheet; section facts are built by `segmentFacts`. */
export function buildChapterFacts(input: ChapterFactsInput): ChapterFactsData {
  const { chapter, knowledge, guide } = input;
  const save = input.save ?? null;
  const byOrder = new Map<number, RouteSection>();
  for (const section of input.sections) byOrder.set(section.order, section);

  const sections: ChapterFactsData["sections"][number][] = [];
  const routeSections: RouteSection[] = [];
  for (let index = chapter.from; index <= chapter.to; index += 1) {
    const section = byOrder.get(index);
    if (section === undefined) {
      throw new Error(
        `路线书里没有攻略第 ${index} 节,第 ${chapter.chapter} 章(${chapter.from}–${chapter.to})取不了事实`,
      );
    }
    routeSections.push(section);
    const facts = segmentFacts({
      game: knowledge.game,
      section,
      knowledge,
      save,
      party: input.party ?? [],
      bag: input.bag ?? [],
      gil: input.gil ?? 0,
      ...(index === chapter.from && input.currentMapId !== undefined
        ? { currentMapId: input.currentMapId }
        : {}),
    }).data;
    sections.push({
      index,
      title: sectionTitle(section, index, guide),
      done: sectionFinished(section, save ?? EMPTY_SAVE),
      facts,
    });
  }

  const mapIds = new Set<number>();
  for (const section of sections) {
    for (const map of section.facts.maps) mapIds.add(map.mapId);
    for (const map of section.facts.passThrough) mapIds.add(map.mapId);
    for (const map of section.facts.revisitMaps) mapIds.add(map.mapId);
  }

  const worldGuide = new Map<number, { books: Set<number>; names: Set<string> }>();
  for (const section of routeSections) {
    for (const map of section.maps) {
      if (!isWorldMapId(knowledge, map.mapId)) continue;
      const entry = worldGuide.get(map.mapId) ?? {
        books: new Set<number>(),
        names: new Set<string>(),
      };
      for (const monster of section.monsters) {
        if (monster.bookId !== null) entry.books.add(monster.bookId);
        entry.names.add(normalizeName(monster.name));
      }
      worldGuide.set(map.mapId, entry);
    }
  }
  for (const mapId of mapIds) {
    if (isWorldMapId(knowledge, mapId) && !worldGuide.has(mapId)) {
      worldGuide.set(mapId, { books: new Set(), names: new Set() });
    }
  }

  return {
    game: knowledge.game,
    chapter: chapter.chapter,
    from: chapter.from,
    to: chapter.to,
    sections,
    hiddenItems: buildHiddenItems(knowledge, input.files ?? [], input.save ?? null, mapIds),
    shops: buildShops(knowledge, input.files ?? [], mapIds),
    encounters: buildEncounters(
      knowledge,
      input.rewards ?? null,
      input.save ?? null,
      mapIds,
      worldGuide,
    ),
  };
}

/**
 * Read the game files (hidden item spots, clerk cells, monster rewards) and build the same
 * structured sheet. `buildChapterFacts` itself stays pure; task 151's runtime uses this form.
 */
export async function buildChapterFactsFromDisk(
  input: Omit<ChapterFactsInput, "files" | "rewards">,
  filesDir: string,
  signal?: AbortSignal,
): Promise<ChapterFactsData> {
  const files = await readChapterFileData(filesDir, input.knowledge.game, signal);
  return buildChapterFacts({
    ...input,
    files: files.maps,
    rewards: files.rewards,
  });
}

// ---------------------------------------------------------------------------------------------
// Hidden items

function itemName(knowledge: Knowledge, contentId: number): string {
  const content = knowledge.contentItems.find((item) => item.id === contentId);
  const names = content?.names;
  const trilingual = [names?.zhc, names?.en, names?.ja].find(
    (name): name is string => name !== null && name !== undefined && name.trim() !== "",
  );
  if (trilingual !== undefined) return cleanName(trilingual);
  const item = knowledge.items.find((entry) => entry.id === contentId);
  return item === undefined ? `物品 #${contentId}` : cleanName(item.name);
}

function hiddenOpened(
  knowledge: Knowledge,
  save: RouteBookSave | null,
  mapId: number,
  spot: { readonly cell: Cell; readonly flagId: number | null },
): boolean | null {
  const chest = knowledge.chests.find((entry) => {
    if (entry.mapId !== mapId) return false;
    if (spot.flagId !== null) return entry.flagId === spot.flagId;
    return entry.cell !== null && entry.cell[0] === spot.cell[0] && entry.cell[1] === spot.cell[1];
  });
  if (chest !== undefined && chest.opened !== null) return chest.opened;
  if (spot.flagId !== null && save?.treasureFlags != null) {
    return save.treasureFlags.get(spot.flagId) ?? null;
  }
  return null;
}

function eventOpened(save: RouteBookSave | null, flagId: number | null): boolean | null {
  if (flagId !== null && save?.treasureFlags != null) {
    return save.treasureFlags.get(flagId) ?? null;
  }
  return null;
}

function buildHiddenItems(
  knowledge: Knowledge,
  files: readonly GameMapFile[],
  save: RouteBookSave | null,
  mapIds: ReadonlySet<number>,
): ChapterHiddenItem[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  const out: ChapterHiddenItem[] = [];
  for (const mapId of mapIds) {
    const file = byId.get(mapId);
    if (file === undefined) continue;
    for (const spot of file.hiddenItems) {
      const script = spot.script;
      out.push({
        kind: script === null ? "hidden" : "event",
        mapId,
        cell: spot.cell,
        item: itemName(knowledge, spot.contentId),
        opened:
          script === null
            ? hiddenOpened(knowledge, save, mapId, spot)
            : eventOpened(save, spot.flagId),
        source:
          script === null
            ? `游戏文件 宝箱${spot.flagId === null ? "" : ` flag ${spot.flagId}`}`
            : `事件奖励，触发条件看攻略(脚本 ${script})`,
      });
    }
  }
  return out.sort(
    (left, right) =>
      left.mapId - right.mapId || left.cell[1] - right.cell[1] || left.cell[0] - right.cell[0],
  );
}

// ---------------------------------------------------------------------------------------------
// Shops

function mapTown(knowledge: Knowledge, mapId: number, fallback: string | null): string {
  const map = knowledge.maps.find((entry) => entry.id === mapId);
  const name = [map?.areaName, map?.name, fallback].find(
    (value): value is string => value !== null && value !== undefined && value.trim() !== "",
  );
  return name === undefined ? `地图 ${mapId}` : cleanName(name);
}

function areaMap(
  knowledge: Knowledge,
  areaName: string | null,
  mapIds: ReadonlySet<number>,
): number | null {
  if (areaName === null || areaName.trim() === "") return null;
  const wanted = normalizeName(areaName);
  if (wanted === "") return null;
  const matches = [...mapIds].filter((mapId) => {
    const map = knowledge.maps.find((entry) => entry.id === mapId);
    return [map?.areaName, map?.name].some(
      (name) => name !== null && name !== undefined && normalizeName(name) === wanted,
    );
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

const SHOP_KIND_ALIASES: Readonly<Record<string, string>> = {
  Item: "道具",
  Weapon: "武器",
  Armor: "防具",
  Inn: "旅店",
  Magic: "魔法",
  WhiteMagic: "白魔法",
  BlackMagic: "黑魔法",
  "White Magic": "白魔法",
  "Black Magic": "黑魔法",
};

function shopKindName(kind: string | null): string {
  const cleaned = cleanName(kind ?? "商店");
  return SHOP_KINDS[cleaned] ?? SHOP_KIND_ALIASES[cleaned] ?? cleaned;
}

function contentChineseName(knowledge: Knowledge, id: number | null, name: string): string | null {
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

function shopProductName(
  knowledge: Knowledge,
  product: { readonly itemId: number | null; readonly name: string },
): string {
  return contentChineseName(knowledge, product.itemId, product.name) ?? cleanName(product.name);
}

function isInnKind(kind: string): boolean {
  return /旅店|inn/iu.test(kind);
}

function productContentKind(
  knowledge: Knowledge,
  product: { readonly itemId: number | null; readonly name: string },
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
  }
  return null;
}

function mapTitleShopKind(title: GameMapFile["title"]): string | null {
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

/** The area's guide inn table, for a counter whose export products are another shop's. */
function innRestPrice(knowledge: Knowledge, mapId: number): number | null {
  const guide = knowledge.guide;
  if (guide === null) return null;
  const map = knowledge.maps.find((entry) => entry.id === mapId);
  const keys = areaKeys(guide, map?.areaName ?? map?.name ?? "");
  if (keys.length === 0) return null;
  for (const section of guide.walkthrough) {
    const sectionKeys = areaKeys(guide, section.title);
    if (!sectionKeys.some((key) => keys.includes(key))) continue;
    for (const shop of section.shops ?? []) {
      if (!/旅店|inn/iu.test(shop.kind)) continue;
      const rest = shop.goods.find((good) => /^rest$/iu.test(good.name));
      if (rest?.cost !== null && rest?.cost !== undefined) return rest.cost;
    }
  }
  return null;
}

/** No guide shop table names this clerk: infer the kind from what the counter sells. */
function inferShopKind(
  knowledge: Knowledge,
  products: readonly {
    readonly itemId: number | null;
    readonly name: string;
  }[],
): string | null {
  const counts = new Map<string, number>();
  for (const product of products) {
    if (/^(?:rest|住宿|宿泊|休息)$/iu.test(product.name)) {
      counts.set("旅店", (counts.get("旅店") ?? 0) + 1);
      continue;
    }
    const kind = productContentKind(knowledge, product);
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

function buildShops(
  knowledge: Knowledge,
  files: readonly GameMapFile[],
  mapIds: ReadonlySet<number>,
): ChapterShop[] {
  const counters = new Map<number, { readonly map: number; readonly cell: Cell }[]>();
  for (const file of files) {
    for (const npc of file.npcs) {
      if (npc.shopId === null) continue;
      const found = counters.get(npc.shopId) ?? [];
      if (
        !found.some(
          (spot) =>
            spot.map === file.id && spot.cell[0] === npc.cell[0] && spot.cell[1] === npc.cell[1],
        )
      ) {
        found.push({ map: file.id, cell: npc.cell });
      }
      counters.set(npc.shopId, found);
    }
  }

  const out: ChapterShop[] = [];
  const seen = new Set<string>();
  const push = (shop: Knowledge["shops"][number], mapId: number, counter: Cell | null): void => {
    const key = `${mapId}|${shop.id ?? `${shop.areaName ?? ""}:${shop.kind ?? ""}`}|${counter === null ? "" : `${counter[0]},${counter[1]}`}`;
    if (seen.has(key)) return;
    seen.add(key);
    // The map title is the game's own shop sign ("旅店", "武器防具店"); the export's labels
    // and guide pairing can be off by one table. Goods decide only the combined 武器防具店.
    const titleKind = mapTitleShopKind(files.find((file) => file.id === mapId)?.title ?? null);
    const inferred = inferShopKind(knowledge, shop.products);
    const kind =
      titleKind === "武器防具"
        ? (inferred ?? "武器")
        : (titleKind ?? inferred ?? shopKindName(shop.kind));
    const inn = isInnKind(kind);
    const restPrice = inn ? innRestPrice(knowledge, mapId) : null;
    const products =
      inn && restPrice !== null
        ? [{ name: "住宿", price: restPrice }]
        : [
            ...new Map(
              shop.products.flatMap((product) => {
                const name = shopProductName(knowledge, product);
                const service = /^(?:rest|住宿|宿泊|休息)$/iu.test(name);
                // A Rest row on a non-inn counter is a mis-paired guide table, not goods.
                if (service && !inn) return [];
                const renamed = inn && service ? "住宿" : name;
                return [
                  [`${renamed}|${product.price ?? ""}`, { name: renamed, price: product.price }],
                ];
              }),
            ).values(),
          ];
    out.push({
      mapId,
      town: mapTown(knowledge, mapId, shop.areaName),
      kind,
      counter,
      products,
    });
  };

  for (const shop of knowledge.shops) {
    const located = shop.id === null ? [] : (counters.get(shop.id) ?? []);
    if (located.length > 0) {
      for (const spot of located) {
        if (mapIds.has(spot.map)) push(shop, spot.map, spot.cell);
      }
      continue;
    }
    // A product group reused across towns can carry a misleading export mapId (live: map 30
    // Tule with mithril weapons). Without a clerk cell or a guide shop table there is no town
    // to place it in, so leave it out instead of inventing one.
    if (shop.guideWhere === null) continue;
    const mapId =
      shop.mapId !== null && mapIds.has(shop.mapId)
        ? shop.mapId
        : areaMap(knowledge, shop.areaName, mapIds);
    if (mapId !== null) push(shop, mapId, null);
  }
  return out.sort((left, right) => left.mapId - right.mapId || left.town.localeCompare(right.town));
}

// ---------------------------------------------------------------------------------------------
// Encounters

function mapName(knowledge: Knowledge, mapId: number): string {
  const known = knowledge.maps.find((map) => map.id === mapId);
  const name = known?.name;
  return name === undefined || name === null || name.trim() === ""
    ? `地图 ${mapId}`
    : cleanName(name);
}

function blueMagicOf(monster: MonsterKnowledge): string[] {
  const fromMoves = monster.moves
    .filter((move) => move.blueMagic === true)
    .map((move) => move.name);
  return [...new Set(fromMoves.length > 0 ? fromMoves : monster.guideBlueMagic)];
}

function isWorldMapId(knowledge: Knowledge, mapId: number): boolean {
  const name = knowledge.maps.find((map) => map.id === mapId)?.name ?? "";
  return /^Map_100|world.?map/iu.test(name);
}

function buildEncounters(
  knowledge: Knowledge,
  rewards: ReadonlyMap<number, MonsterReward> | null,
  save: RouteBookSave | null,
  mapIds: ReadonlySet<number>,
  worldGuide: ReadonlyMap<
    number,
    { readonly books: ReadonlySet<number>; readonly names: ReadonlySet<string> }
  >,
): ChapterEncounterMap[] {
  const bestiary = save?.bestiary ?? null;
  const out: ChapterEncounterMap[] = [];
  for (const mapId of [...mapIds].sort((left, right) => left - right)) {
    const world = worldGuide.get(mapId);
    const all = monstersIn(knowledge, { mapIds: [mapId] });
    const monsters =
      world === undefined
        ? all
        : all.filter(
            (monster) =>
              (monster.bookId !== null && world.books.has(monster.bookId)) ||
              world.names.has(normalizeName(monster.name)),
          );
    if (monsters.length === 0) continue;
    out.push({
      mapId,
      mapName: mapName(knowledge, mapId),
      monsters: monsters
        .map((monster) => {
          const reward = monster.id === null ? undefined : rewards?.get(monster.id);
          const bookId = monster.bookId;
          return {
            name: monster.name,
            bookId,
            registered: bookId === null || bestiary === null ? null : bestiary.has(bookId),
            blueMagic: blueMagicOf(monster),
            exp: reward?.exp ?? null,
            gil: reward?.gil ?? null,
            abp: reward?.abp ?? null,
          };
        })
        .sort(
          (left, right) =>
            (left.bookId ?? Number.MAX_SAFE_INTEGER) - (right.bookId ?? Number.MAX_SAFE_INTEGER) ||
            left.name.localeCompare(right.name),
        ),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Text

function sectionRange(data: ChapterFactsData): string {
  const first = data.sections[0]?.title;
  const last = data.sections[data.sections.length - 1]?.title;
  if (first === undefined) return "";
  if (last === undefined || first === last) return first;
  return `${first} → ${last}`;
}

function lastLine(lines: readonly string[], limit: number, what: string): string[] {
  if (lines.length <= limit) return [...lines];
  return [...lines.slice(0, limit), `- …另有 ${lines.length - limit} 个${what}未列出`];
}

/**
 * 11-11 live: the section text comes from `facts.ts`, so mark a boss already beaten in this
 * save without changing the per-section sheet. Only lines in the 首领 block are touched.
 */
function markDefeatedBosses(text: string, bosses: readonly SegmentFactsBoss[]): string {
  const names = bosses
    .filter((boss) => boss.defeated === true)
    .flatMap((boss) => [boss.name, boss.knowledgeName, boss.guideName])
    .filter((name): name is string => name !== null && name.trim() !== "")
    .map((name) => normalizeName(name))
    .filter((name) => name !== "");
  if (names.length === 0) return text;
  let inBosses = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("### ")) {
        inBosses = line.startsWith("### 首领");
        return line;
      }
      if (!inBosses || !line.startsWith("- ") || line.includes("已打倒")) return line;
      const key = normalizeName(line);
      return names.some((name) => key.includes(name)) ? `${line} 已打倒` : line;
    })
    .join("\n");
}

/**
 * The Chinese chapter sheet: every section's existing fact text, then the hidden item, shop and
 * encounter tables. Section text and table rows are capped so one chapter stays one prompt.
 */
export function chapterFactsText(data: ChapterFactsData): string {
  const lines: string[] = [
    `章节事实:第 ${data.chapter} 章 ${sectionRange(data)}(攻略第 ${data.from}–${data.to} 节)`,
    `### 节(${data.sections.length} 节)`,
  ];
  for (const section of data.sections) {
    lines.push(
      `#### 第 ${section.index} 节 ${section.title}${section.done ? " [已完成]" : ""}`,
      markDefeatedBosses(
        describeChapterSectionFacts(section.facts, MAX_SECTION_TEXT),
        section.facts.bosses,
      ),
    );
  }

  const names = new Map<number, string>();
  for (const section of data.sections) {
    for (const map of section.facts.maps) names.set(map.mapId, map.name);
    for (const map of section.facts.passThrough) names.set(map.mapId, map.name);
    for (const map of section.facts.revisitMaps) names.set(map.mapId, map.name);
  }
  const place = (mapId: number): string =>
    names.has(mapId) ? `地图 ${mapId}「${names.get(mapId) ?? "?"}」` : `地图 ${mapId}`;

  const hiddenSpots = data.hiddenItems.filter((item) => item.kind === "hidden");
  const eventRewards = data.hiddenItems.filter((item) => item.kind === "event");
  const hiddenLines = hiddenSpots.map(
    (item) =>
      `- ${place(item.mapId)} (${item.cell[0]},${item.cell[1]}) ${item.item} — ${item.source};${item.opened === null ? "开没开未知" : item.opened ? "已开" : "未开"}`,
  );
  lines.push(`### 隐藏道具(${hiddenSpots.length} 个)`);
  if (hiddenSpots.length === 0) lines.push("- 没有找到本章的隐藏道具。");
  lines.push(...lastLine(hiddenLines, MAX_HIDDEN_ROWS, "隐藏道具"));

  const eventLines = eventRewards.map(
    (item) =>
      `- ${place(item.mapId)} (${item.cell[0]},${item.cell[1]}) ${item.item} — ${item.source};${item.opened === null ? "拿没拿未知" : item.opened ? "已拿" : "未拿"}`,
  );
  lines.push(`### 事件奖励(${eventRewards.length} 个)`);
  if (eventRewards.length === 0) lines.push("- 本章没有事件奖励记录。");
  lines.push(...lastLine(eventLines, MAX_HIDDEN_ROWS, "事件奖励"));

  lines.push(`### 商店(${data.shops.length} 家)`);
  if (data.shops.length === 0) lines.push("- 本章没有商店记录。");
  const shopLines = data.shops.map((shop) => {
    const goods = shop.products.filter((product) => product.name !== "住宿");
    const rest = shop.products.find((product) => product.name === "住宿");
    const goodsText =
      goods.length === 0
        ? "没有货品记录"
        : goods
            .map(
              (product) => `${product.name}${product.price === null ? " ?" : ` ${product.price}`}`,
            )
            .join("、");
    const restText = rest === undefined ? "" : `;住宿 ${rest.price ?? "?"}`;
    return `- ${place(shop.mapId)} ${shop.town} ${shop.kind} 柜台${shop.counter === null ? "未知" : `(${shop.counter[0]},${shop.counter[1]})`}:${goodsText}${restText}`;
  });
  lines.push(...lastLine(shopLines, MAX_SHOP_ROWS, "商店"));

  const species = new Set(
    data.encounters.flatMap((map) =>
      map.monsters.map((monster) =>
        monster.bookId === null ? monster.name : `#${monster.bookId}`,
      ),
    ),
  ).size;
  lines.push(`### 遇敌(${data.encounters.length} 张图,${species} 种)`);
  if (data.encounters.length === 0) lines.push("- 本章的图没有遇敌记录。");
  const encounterLines = data.encounters.flatMap((map) => {
    if (map.monsters.length === 0) return [`- ${place(map.mapId)}:没有遇敌记录`];
    return map.monsters.map((monster) => {
      const book = monster.bookId === null ? "" : ` #${String(monster.bookId).padStart(3, "0")}`;
      const registered =
        monster.registered === null ? "图鉴:未知" : monster.registered ? "图鉴:已登记" : "图鉴:缺";
      const blue = monster.blueMagic.length === 0 ? "" : ` 青魔法:${monster.blueMagic.join("、")}`;
      return `- ${place(map.mapId)} ${monster.name}${book} ${registered}${blue} 经验 ${monster.exp ?? "?"} 金币 ${monster.gil ?? "?"} ABP ${monster.abp ?? "?"}`;
    });
  });
  lines.push(...lastLine(encounterLines, MAX_ENCOUNTER_ROWS, "怪物记录"));

  const last = data.sections[data.sections.length - 1];
  if (last !== undefined) {
    lines.push("### 队伍与背包(整章一次)");
    for (const member of last.facts.party) {
      const status = member.status.length === 0 ? "无" : member.status.join("、");
      const spells = member.spells.length === 0 ? "无" : member.spells.join("、");
      lines.push(
        `- ${member.name} ${member.job} Lv${member.level} HP ${member.hp}/${member.maxHp} MP ${member.mp}/${member.maxMp} 状态:${status} 魔法:${spells}`,
      );
    }
    const healing = last.facts.healing;
    if (healing !== undefined) {
      const spells = healing.spells.map((entry) => `${entry.spell}(${entry.member})`).join("、");
      const items = healing.items.map((item) => `${item.name}×${item.count}`).join("、");
      const revive = healing.reviveItems.map((item) => `${item.name}×${item.count}`).join("、");
      const parts = [spells, items, revive].filter((part) => part !== "");
      lines.push(`- 回复手段:${parts.length === 0 ? "没有记录" : parts.join("、")}`);
    }
    lines.push(`- 金钱 ${last.facts.gil}`);
    lines.push(
      last.facts.bag.length === 0
        ? "- 背包空"
        : `- 背包:${last.facts.bag.map((item) => `${item.name}×${item.count}`).join("、")}`,
    );
  }

  const text = lines.join("\n");
  const characters = Array.from(text);
  if (characters.length <= CHAPTER_FACTS_LIMIT) return text;
  const suffix = "\n…(章节事实太长,后面省略;完整见结构化数据)";
  return (
    characters.slice(0, Math.max(0, CHAPTER_FACTS_LIMIT - Array.from(suffix).length)).join("") +
    suffix
  );
}
