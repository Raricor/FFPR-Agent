/**
 * Whole-chapter checks (task 151, 11-11). A chapter plan is several `SegmentPlan`s plus growth,
 * fallback and skipped targets. Each segment goes through the existing `validatePlan`; this
 * module adds what only the whole chapter can know: every unopened chest, hidden item, boss,
 * bestiary entry and blue spell is covered (or deliberately skipped), every `buy` station names
 * a shop on its own map, the chapter's purchases are affordable, and growth / fallback / segment
 * order are sane.
 *
 * Pure: no bridge, no file, no clock. Problems are Chinese, one per line; the caller decides
 * whether to return them to the model. Warnings (overspending) do not reject the plan.
 */

import { cleanIconTags } from "../icons.ts";
import type { Knowledge } from "../knowledge/index.ts";
import { isRecord, text } from "../values.ts";
import type { ChapterFactsData, ChapterPlan, ChapterSkipped } from "./chapter-types.ts";
import {
  segmentFactsKnowledge,
  type SegmentFactsBlueMagic,
  type SegmentFactsBoss,
  type SegmentFactsChest,
  type SegmentFactsData,
} from "./facts.ts";
import type { PlanStation, SegmentPlan } from "./types.ts";
import {
  itemCatalog,
  nameKey,
  parseTarget,
  productIsWanted,
  validatePlan,
  type ItemCatalog,
  type PlanValidation,
} from "./validate.ts";

export interface ChapterValidation {
  readonly ok: boolean;
  /** Chinese, one line per problem; empty means the plan can be used. */
  readonly problems: readonly string[];
  /** Chinese, one line per non-blocking concern (for example total purchases over budget). */
  readonly warnings: readonly string[];
  /** Set when a segment's small fixes (optional heal/save) were applied. */
  readonly fixed?: ChapterPlan;
}

const SKIPPED_KINDS: ReadonlySet<string> = new Set([
  "bestiary",
  "blueMagic",
  "hidden",
  "chest",
  "shop",
  "boss",
]);

const BLUE_MAGE_KEYS: ReadonlySet<string> = new Set(["bluemage", "青魔导士"]);

interface ChapterSection {
  readonly index: number;
  readonly title: string;
  readonly done: boolean;
  readonly facts: SegmentFactsData;
}

function sectionsOf(facts: ChapterFactsData): ChapterSection[] {
  return [...facts.sections]
    .sort((left, right) => left.index - right.index)
    .map((section) => ({
      index: section.index,
      title: section.title,
      // 11-11 live: chests/bosses alone called Prologue done; the story flag must also hold.
      done: section.done && section.facts.storyDone === true,
      facts: section.facts,
    }));
}

function nameMatches(left: string, target: string): boolean {
  const a = nameKey(left);
  const b = nameKey(target);
  if (a === "" || b === "") return false;
  return a === b || a.includes(b) || b.includes(a);
}

function mapLabel(mapId: number, name?: string): string {
  return name === undefined || name.trim() === "" ? `地图 ${mapId}` : `地图 ${mapId} ${name}`;
}

function chestLabel(chest: SegmentFactsChest): string {
  const where =
    chest.mapId === null || chest.cell === null
      ? (chest.mapName ?? "位置不明")
      : `${chest.mapId}:${chest.cell[0]},${chest.cell[1]}`;
  return `${where}「${chest.item}」`;
}

// ---------------------------------------------------------------------------------------------
// Skipped targets

function skippedMatches(
  skipped: readonly ChapterSkipped[],
  kind: ChapterSkipped["kind"],
  name: string,
  where?: {
    readonly mapId: number;
    readonly cell: readonly [number, number] | null;
  },
): ChapterSkipped | undefined {
  return skipped.find((entry) => {
    if (entry.kind !== kind || !nameMatches(entry.name, name)) return false;
    if (entry.where === undefined || where === undefined) return true;
    const target = parseTarget(entry.where);
    if (typeof target === "string") return false;
    if (target.mapId !== where.mapId) return false;
    if (target.cell === null || where.cell === null) return true;
    return target.cell[0] === where.cell[0] && target.cell[1] === where.cell[1];
  });
}

function skippedComplaint(
  skipped: readonly ChapterSkipped[],
  kind: ChapterSkipped["kind"],
  name: string,
  where?: {
    readonly mapId: number;
    readonly cell: readonly [number, number] | null;
  },
): ChapterSkipped | undefined {
  const found = skippedMatches(skipped, kind, name, where);
  return found !== undefined && found.why.trim() !== "" ? found : undefined;
}

function checkSkipped(value: unknown, problems: string[]): ChapterSkipped[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push("skipped 要写成数组");
    return [];
  }
  const out: ChapterSkipped[] = [];
  for (const [index, raw] of value.entries()) {
    const where = `skipped 第 ${index + 1} 项`;
    if (!isRecord(raw)) {
      problems.push(`${where}不是对象`);
      continue;
    }
    const kind = text(raw.kind)?.trim() ?? "";
    if (!SKIPPED_KINDS.has(kind)) {
      problems.push(`${where}的 kind 不认识;能用:bestiary、blueMagic、hidden、chest、shop、boss`);
    }
    const name = text(raw.name)?.trim() ?? "";
    if (name === "") problems.push(`${where}没有写 name`);
    const why = text(raw.why)?.trim() ?? "";
    if (why === "") problems.push(`${where}的 why 要写清楚为什么不拿`);
    if (raw.where !== undefined) {
      if (typeof raw.where !== "string" || typeof parseTarget(raw.where) === "string") {
        problems.push(`${where}的 where 要写成「地图号:x,y」或「地图号」`);
      }
    }
    if (typeof raw.kind === "string" && SKIPPED_KINDS.has(raw.kind) && name !== "" && why !== "") {
      out.push({
        kind: raw.kind as ChapterSkipped["kind"],
        name,
        ...(typeof raw.where === "string" ? { where: raw.where } : {}),
        why,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Per-segment validation

function bossAliases(boss: SegmentFactsBoss): string[] {
  return [
    boss.name,
    boss.knowledgeName ?? "",
    boss.guideName ?? "",
    boss.bookId === null ? "" : String(boss.bookId),
  ]
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

function planNamesBoss(plan: unknown, boss: SegmentFactsBoss): boolean {
  if (!isRecord(plan) || !Array.isArray(plan.bosses)) return false;
  const aliases = bossAliases(boss);
  return plan.bosses.some((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.trim() === "") {
      return false;
    }
    return aliases.some((alias) => nameMatches(entry.name as string, alias));
  });
}

/**
 * 11-11 live: a boss can be listed by one segment and its `boss` station placed on the approach
 * map. The guide names it in any language; for coverage the plan's own `bosses` table is enough,
 * but only in the same segment that has the boss station.
 */
function planCoversBoss(plan: unknown, boss: SegmentFactsBoss): boolean {
  if (!isRecord(plan) || !Array.isArray(plan.stations)) return false;
  const hasBossStation = plan.stations.some(
    (station) => isRecord(station) && station.do === "boss",
  );
  return hasBossStation && planNamesBoss(plan, boss);
}

function plannedBlueMage(plan: unknown): boolean {
  if (!isRecord(plan) || !isRecord(plan.prep) || !Array.isArray(plan.prep.jobs)) return false;
  return plan.prep.jobs.some(
    (job) => isRecord(job) && typeof job.job === "string" && BLUE_MAGE_KEYS.has(nameKey(job.job)),
  );
}

/**
 * Drop the chests and bosses the chapter already listed in `skipped`, for `validatePlan`. When
 * this segment's prep changes someone into a Blue Mage, the section's `canLearn` flags (computed
 * from the current jobs) are raised for the grind check.
 */
function factsForSegment(
  facts: SegmentFactsData,
  skipped: readonly ChapterSkipped[],
  plan: unknown,
): SegmentFactsData {
  const chests = facts.chests.filter(
    (chest) =>
      chest.mapId === null ||
      chest.cell === null ||
      skippedComplaint(skipped, "chest", chest.item, {
        mapId: chest.mapId,
        cell: chest.cell,
      }) === undefined,
  );
  const bosses = facts.bosses.filter(
    (boss) =>
      boss.maps.length === 0 ||
      (skippedComplaint(skipped, "boss", boss.name) === undefined && !planCoversBoss(plan, boss)),
  );
  const hasBlueMage =
    facts.party.some((member) => BLUE_MAGE_KEYS.has(nameKey(member.job))) || plannedBlueMage(plan);
  const blueMagic = hasBlueMage
    ? facts.blueMagic.map((spell) => (spell.canLearn ? spell : { ...spell, canLearn: true }))
    : facts.blueMagic;
  return { ...facts, chests, bosses, blueMagic };
}

/** The same check `validateChapterPlan` runs on one segment, for the draft tool. */
export function validateChapterSegment(
  plan: unknown,
  facts: SegmentFactsData,
  skipped: readonly ChapterSkipped[] = [],
): PlanValidation {
  return validatePlan(plan, factsForSegment(facts, skipped, plan));
}

interface SegmentEntry {
  readonly index: number;
  readonly section: ChapterSection | undefined;
  readonly plan: SegmentPlan | undefined;
}

function validateSegments(
  values: readonly unknown[],
  sections: readonly ChapterSection[],
  skipped: readonly ChapterSkipped[],
  problems: string[],
  warnings: string[],
): {
  readonly entries: SegmentEntry[];
  readonly fixed: SegmentPlan[];
  readonly changed: boolean;
} {
  const byTitle = new Map(sections.map((section) => [section.title, section]));
  const expected = sections.filter((section) => !section.done);
  const positions = new Map(expected.map((section, position) => [section.title, position]));
  const seen = new Set<string>();
  let previous = -1;
  let changed = false;
  const entries: SegmentEntry[] = [];
  const fixed: SegmentPlan[] = [];
  for (const [index, raw] of values.entries()) {
    const where = `第 ${index + 1} 段`;
    if (!isRecord(raw)) {
      problems.push(`${where}不是对象`);
      entries.push({ index, section: undefined, plan: undefined });
      continue;
    }
    const title = text(raw.section)?.trim() ?? "";
    const section = byTitle.get(title);
    if (section === undefined) {
      problems.push(`${where}「${title === "" ? "没写 section" : title}」不是本章的一节`);
      entries.push({ index, section: undefined, plan: undefined });
      continue;
    }
    if (section.done) {
      warnings.push(`事实认为${where}「${title}」已完成;剧情若没走完可以照写`);
    } else {
      const position = positions.get(title);
      if (position !== undefined) {
        if (seen.has(title)) problems.push(`${where}「${title}」写了两遍`);
        else if (position <= previous) {
          // 11-11 live: the story can force another order (the ship went to the Wind Shrine
          // before Tule); the plan decides, the check only points it out.
          warnings.push(`${where}「${title}」和攻略的节序不同;剧情若要求这样可以照写`);
        }
        if (position > previous) previous = position;
        seen.add(title);
      }
    }
    const validation: PlanValidation = validateChapterSegment(raw, section.facts, skipped);
    for (const problem of validation.problems) problems.push(`${where}:${problem}`);
    for (const warning of validation.warnings ?? []) warnings.push(`${where}:${warning}`);
    const plan = validation.fixed ?? (raw as unknown as SegmentPlan);
    if (validation.fixed !== undefined) changed = true;
    const knowledge = segmentFactsKnowledge(section.facts);
    for (const [stationIndex, station] of plan.stations.entries()) {
      const warning = storyTriggerWarning(station, knowledge);
      if (warning !== null) warnings.push(`${where}第 ${stationIndex + 1} 站:${warning}`);
    }
    entries.push({ index, section, plan });
    fixed.push(plan);
  }
  for (const [position, section] of expected.entries()) {
    if (seen.has(section.title)) continue;
    problems.push(`第 ${position + 1} 段「${section.title}」没写进计划`);
  }
  return { entries, fixed, changed };
}

// ---------------------------------------------------------------------------------------------
// Coverage

function stationTarget(station: PlanStation): ReturnType<typeof parseTarget> {
  return parseTarget(station.to);
}

function openAt(
  stations: readonly PlanStation[],
  mapId: number,
  cell: readonly [number, number],
): boolean {
  return stations.some((station) => {
    if (station.do !== "open") return false;
    const target = stationTarget(station);
    return (
      typeof target !== "string" &&
      target.cell !== null &&
      target.mapId === mapId &&
      target.cell[0] === cell[0] &&
      target.cell[1] === cell[1]
    );
  });
}

const EVENT_ACTIONS: ReadonlySet<PlanStation["do"]> = new Set([
  "open",
  "talk",
  "story",
  "switch",
  "choose",
]);

/** 11-11: an event reward can be triggered anywhere on its map, not only on the recorded cell. */
function eventStationOn(stations: readonly PlanStation[], mapId: number): boolean {
  return stations.some((station) => {
    if (!EVENT_ACTIONS.has(station.do)) return false;
    const target = stationTarget(station);
    return typeof target !== "string" && target.mapId === mapId;
  });
}

function bossAt(stations: readonly PlanStation[], maps: readonly number[]): boolean {
  return stations.some((station) => {
    if (station.do !== "boss") return false;
    const target = stationTarget(station);
    return typeof target !== "string" && maps.includes(target.mapId);
  });
}

/**
 * Task 161: a story station with no cell is only a warning. The exported map's scripted NPCs
 * list the candidates, so the planner can write one cell if it wants; the executor can also
 * pick by name/scene number on its own.
 */
export function storyTriggerWarning(
  station: PlanStation,
  knowledge: Knowledge | undefined,
): string | null {
  if (station.do !== "story") return null;
  const target = parseTarget(station.to);
  if (typeof target === "string" || target.cell !== null) return null;
  const file = knowledge?.mapFiles?.find((entry) => entry.id === target.mapId);
  if (file === undefined) return null;
  const found = new Map<
    string,
    { cell: readonly [number, number]; name: string; script: number }
  >();
  for (const npc of file.npcs) {
    const script = /(?:sc_e_|ev_e_)(\d+)/iu.exec(npc.name);
    if (script === null) continue;
    const number = Number(script[1]);
    if (!Number.isInteger(number)) continue;
    const key = `${npc.cell[0]},${npc.cell[1]}`;
    if (!found.has(key)) found.set(key, { cell: npc.cell, name: npc.name, script: number });
  }
  const candidates = [...found.values()].sort(
    (left, right) => left.script - right.script || left.cell[1] - right.cell[1],
  );
  if (candidates.length <= 1) return null;
  return (
    `剧情站「${station.to}」没写格子，这张图导出的剧情触发点有 ${candidates.length} 个:` +
    candidates
      .slice(0, 10)
      .map((entry) => `(${entry.cell[0]},${entry.cell[1]})「${entry.name}」`)
      .join("、") +
    "；写上格子更稳，执行器也会按 why 里的名字和场景号自己挑"
  );
}

/**
 * Task 156: a boss station that writes only its map must still be executable. The chapter
 * facts (task 146) must have a trigger cell for that boss on that map; the executor knows how
 * to walk to it. No trigger anywhere means the plan would need the model again, so reject it.
 */
function checkBossStationCells(entries: readonly SegmentEntry[], problems: string[]): void {
  for (const entry of entries) {
    const section = entry.section;
    const plan = entry.plan;
    if (section === undefined || plan === undefined) continue;
    for (const [index, station] of plan.stations.entries()) {
      if (station.do !== "boss") continue;
      const target = stationTarget(station);
      if (typeof target === "string" || target.cell !== null) continue;
      const where = `第 ${entry.index + 1} 段第 ${index + 1} 站`;
      const onMap = section.facts.bosses.filter(
        (boss) => boss.maps.length === 0 || boss.maps.includes(target.mapId),
      );
      const label = `${station.to} ${station.why ?? ""}`;
      const planBoss =
        plan.bosses.find((boss) => boss.name !== "" && label.includes(boss.name)) ??
        plan.bosses.find((boss) => boss.map === target.mapId) ??
        (plan.bosses.length === 1 ? plan.bosses[0] : undefined);
      const named =
        planBoss === undefined
          ? []
          : onMap.filter((boss) =>
              bossAliases(boss).some((alias) => nameMatches(planBoss.name, alias)),
            );
      const candidates = named.length > 0 ? named : onMap.length === 1 ? onMap : [];
      const cells = candidates.flatMap((boss) =>
        boss.triggers.filter((trigger) => trigger.map === target.mapId),
      );
      if (cells.length > 0) continue;
      const name = planBoss?.name ?? (onMap.map((boss) => boss.name).join("、") || "这个首领");
      problems.push(
        `${where}:首领站「${station.to}」没写坐标，章事实里也找不到「${name}」的触发点`,
      );
    }
  }
}

function grindStations(stations: readonly PlanStation[]): PlanStation[] {
  return stations.filter((station) => station.do === "grind" && station.until !== undefined);
}

function untilIncludesBestiary(
  station: PlanStation,
  monster: { readonly name: string; readonly bookId: number | null },
  aliases: readonly string[],
): boolean {
  const targets = station.until?.bestiary ?? [];
  return targets.some((target) => {
    if (typeof target === "number") return monster.bookId !== null && target === monster.bookId;
    return [monster.name, ...aliases].some((name) => nameMatches(name, target));
  });
}

function monsterAliases(
  facts: readonly ChapterSection[],
  monster: { readonly name: string; readonly bookId: number | null },
): string[] {
  const aliases = new Set<string>();
  for (const section of facts) {
    for (const known of section.facts.monsters) {
      const same =
        (monster.bookId !== null && known.bookId === monster.bookId) ||
        nameMatches(known.name, monster.name);
      if (!same) continue;
      aliases.add(known.name);
      if (known.guideName !== null) aliases.add(known.guideName);
    }
  }
  return [...aliases];
}

function missingCollection(
  values: readonly {
    readonly label: string;
    readonly covered: boolean;
    readonly why: string;
  }[],
  problems: string[],
): void {
  for (const value of values) {
    if (!value.covered) problems.push(`本章${value.label}没写进计划,也没写进 skipped:${value.why}`);
  }
}

function checkCoverage(
  sections: readonly ChapterSection[],
  facts: ChapterFactsData,
  entries: readonly SegmentEntry[],
  stations: readonly PlanStation[],
  skipped: readonly ChapterSkipped[],
  problems: string[],
): void {
  // Chests and hidden items need an `open` station on the same map and cell, or a skipped row.
  const chests: { label: string; covered: boolean; why: string }[] = [];
  const seenChests = new Set<string>();
  for (const section of sections) {
    for (const chest of section.facts.chests) {
      if (chest.opened === true || chest.mapId === null || chest.cell === null) continue;
      const key = `${chest.mapId}:${chest.cell[0]},${chest.cell[1]}|${nameKey(chest.item)}`;
      if (seenChests.has(key)) continue;
      seenChests.add(key);
      const where = { mapId: chest.mapId, cell: chest.cell };
      const covered =
        openAt(stations, chest.mapId, chest.cell) ||
        skippedComplaint(skipped, "chest", chest.item, where) !== undefined;
      chests.push({ label: "宝箱", covered, why: chestLabel(chest) });
    }
  }
  const events: {
    readonly label: string;
    readonly covered: boolean;
    readonly why: string;
  }[] = [];
  for (const hidden of facts.hiddenItems) {
    if (hidden.opened === true) continue;
    const key = `${hidden.mapId}:${hidden.cell[0]},${hidden.cell[1]}|${nameKey(hidden.item)}`;
    if (seenChests.has(key)) continue;
    seenChests.add(key);
    const where = { mapId: hidden.mapId, cell: hidden.cell };
    if (hidden.kind === "event") {
      // 11-11: script rewards (piano song, NPC ribbon) may start on another cell, so any
      // talk/open/story/switch/choose station on the same map counts; the guide has the trigger.
      const covered =
        eventStationOn(stations, hidden.mapId) ||
        skippedComplaint(skipped, "hidden", hidden.item, {
          mapId: hidden.mapId,
          cell: null,
        }) !== undefined;
      events.push({
        label: "事件奖励",
        covered,
        why: `${hidden.mapId}:${hidden.cell[0]},${hidden.cell[1]}「${hidden.item}」(触发条件看攻略)`,
      });
      continue;
    }
    const covered =
      openAt(stations, hidden.mapId, hidden.cell) ||
      skippedComplaint(skipped, "hidden", hidden.item, where) !== undefined;
    chests.push({
      label: "隐藏道具",
      covered,
      why: `${hidden.mapId}:${hidden.cell[0]},${hidden.cell[1]}「${hidden.item}」`,
    });
  }
  missingCollection(chests, problems);
  for (const event of events) {
    if (event.covered) continue;
    problems.push(`事件奖励：${event.why}没写进计划,也没写进 skipped`);
  }

  // Bosses: a boss station on one of the boss's maps, or skipped.
  const bosses: { label: string; covered: boolean; why: string }[] = [];
  const seenBosses = new Set<string>();
  for (const section of sections) {
    for (const boss of section.facts.bosses) {
      if (boss.defeated === true || boss.maps.length === 0) continue;
      const key = `${nameKey(boss.name)}|${boss.maps.join(",")}`;
      if (seenBosses.has(key)) continue;
      seenBosses.add(key);
      const covered =
        bossAt(stations, boss.maps) ||
        entries.some((entry) => planCoversBoss(entry.plan, boss)) ||
        skippedComplaint(skipped, "boss", boss.name) !== undefined;
      bosses.push({
        label: "首领",
        covered,
        why: `${boss.name}(${boss.maps.join("、")})`,
      });
    }
  }
  missingCollection(bosses, problems);

  // Bestiary: every map's missing monster must appear in a grind stop's until.bestiary.
  const bestiary: { label: string; covered: boolean; why: string }[] = [];
  for (const map of facts.encounters) {
    for (const monster of map.monsters) {
      if (monster.registered === true) continue;
      const aliases = monsterAliases(sections, monster);
      const target = { name: monster.name, bookId: monster.bookId };
      const covered =
        grindStations(stations).some((station) =>
          untilIncludesBestiary(station, target, aliases),
        ) || skippedComplaint(skipped, "bestiary", monster.name) !== undefined;
      bestiary.push({
        label: "图鉴",
        covered,
        why: `${mapLabel(map.mapId, map.mapName)}的「${monster.name}」`,
      });
    }
  }
  missingCollection(bestiary, problems);

  // Blue magic: learn it, or skip it with a reason. Without a Blue Mage the only option is skip.
  const spells = new Map<string, SegmentFactsBlueMagic>();
  for (const section of sections) {
    for (const spell of section.facts.blueMagic) {
      if (spell.learned) continue;
      const key = nameKey(spell.name);
      if (key !== "" && !spells.has(key)) spells.set(key, spell);
    }
  }
  const hasBlueMage =
    sections.some((section) =>
      section.facts.party.some((member) => BLUE_MAGE_KEYS.has(nameKey(member.job))),
    ) || entries.some((entry) => entry.plan !== undefined && plannedBlueMage(entry.plan));
  for (const spell of spells.values()) {
    const learnedByGrind = grindStations(stations).some((station) =>
      (station.until?.blueMagic ?? []).some((name) => nameMatches(name, spell.name)),
    );
    const skippedRow = skippedComplaint(skipped, "blueMagic", spell.name);
    const covered = learnedByGrind || skippedRow !== undefined;
    if (covered) continue;
    if (!hasBlueMage) {
      problems.push(
        `本章青魔法「${spell.name}」没写进计划:队里没有青魔导士,也没有安排换职业,` +
          "只能写进 skipped 并说明原因",
      );
    } else {
      problems.push(`本章青魔法「${spell.name}」没写进计划,也没写进 skipped`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Buy stations and the chapter budget

function chapterCatalog(facts: ChapterFactsData): ItemCatalog {
  for (const section of facts.sections) {
    const knowledge: Knowledge | undefined = segmentFactsKnowledge(section.facts);
    if (knowledge !== undefined) return itemCatalog(knowledge, section.facts);
  }
  return itemCatalog(undefined);
}

function productFor(
  catalog: ItemCatalog,
  shop: ChapterFactsData["shops"][number],
  item: string,
): { readonly name: string; readonly price: number | null } | undefined {
  return shop.products.find((product) => productIsWanted(catalog, product, item));
}

function magicShop(shop: ChapterFactsData["shops"][number]): boolean {
  return /魔法|magic/iu.test(shop.kind);
}

function stationStops(entries: readonly SegmentEntry[]): {
  readonly segment: number;
  readonly station: number;
  readonly plan: PlanStation;
}[] {
  const out: { segment: number; station: number; plan: PlanStation }[] = [];
  for (const entry of entries) {
    if (entry.plan === undefined) continue;
    for (const [station, plan] of entry.plan.stations.entries()) {
      out.push({ segment: entry.index, station, plan });
    }
  }
  return out;
}

function shopStockOf(shops: readonly ChapterFactsData["shops"][number][]): string[] {
  const names: string[] = [];
  for (const shop of shops) {
    for (const product of shop.products) {
      const name = cleanIconTags(product.name).trim();
      if (name !== "" && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function chestGil(sections: readonly ChapterSection[]): number {
  let total = 0;
  for (const section of sections) {
    for (const chest of section.facts.chests) {
      if (chest.opened === true) continue;
      const match = /(\d[\d,]*)\s*(?:gil|ギル|金币)/iu.exec(chest.item);
      if (match === null) continue;
      const amount = Number.parseInt((match[1] ?? "").replace(/,/gu, ""), 10);
      if (Number.isFinite(amount)) total += amount;
    }
  }
  return total;
}

function checkBuyStations(
  entries: readonly SegmentEntry[],
  facts: ChapterFactsData,
  problems: string[],
  warnings: string[],
): void {
  const catalog = chapterCatalog(facts);
  let cost = 0;
  const unknownPrice = new Set<string>();
  for (const stop of stationStops(entries)) {
    if (stop.plan.do !== "buy") continue;
    const where = `第 ${stop.segment + 1} 段第 ${stop.station + 1} 站`;
    const target = stationTarget(stop.plan);
    if (typeof target === "string") {
      problems.push(`${where}:${target}`);
      continue;
    }
    const shops = facts.shops.filter((shop) => shop.mapId === target.mapId);
    if (shops.length === 0) {
      problems.push(`${where}:地图 ${target.mapId} 上没有这家店,不能在这里买东西`);
      continue;
    }
    const items = stop.plan.items ?? [];
    if (items.length === 0) problems.push(`${where}:items 不能是空的`);
    for (const item of items) {
      const name = cleanIconTags(item.item).trim();
      const magic = catalog.magicKeys.has(nameKey(name));
      const sellers = magic ? shops.filter(magicShop) : shops;
      const product = sellers
        .map((shop) => productFor(catalog, shop, name))
        .find((entry) => entry !== undefined);
      if (product === undefined) {
        const stock = shopStockOf(sellers);
        problems.push(
          `${where}:地图 ${target.mapId} 的${magic ? "魔法店" : "商店"}没有卖「${name}」;` +
            `这些店有卖:${stock.length === 0 ? "没有记录" : stock.join("、")}`,
        );
        continue;
      }
      if (typeof item.count === "number" && Number.isInteger(item.count) && item.count > 0) {
        if (product.price === null) unknownPrice.add(name);
        else cost += item.count * product.price;
      }
    }
  }

  // Prepared purchases are part of the same purse; find their price anywhere in the chapter.
  for (const entry of entries) {
    if (entry.plan === undefined) continue;
    for (const purchase of entry.plan.prep.buy) {
      const product = facts.shops
        .map((shop) => productFor(catalog, shop, purchase.item))
        .find((found) => found !== undefined);
      if (product === undefined) continue;
      if (product.price === null) unknownPrice.add(purchase.item);
      else if (Number.isInteger(purchase.count) && purchase.count > 0) {
        cost += purchase.count * product.price;
      }
    }
  }

  for (const name of unknownPrice) {
    warnings.push(`「${name}」的价格未知,没有算进整章采购总价`);
  }
  if (cost === 0) return;
  const gil = facts.sections[0]?.facts.gil ?? 0;
  const found = chestGil(facts.sections);
  const budget = gil + found;
  if (cost > budget) {
    warnings.push(
      `整章采购约 ${cost} gil,现有金钱 ${gil} + 本章宝箱里的金币 ${found} = ${budget} gil,` +
        "不够,执行时会按金钱能买的买(不退回)",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Growth, fallback, order

function stationWhere(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const target = parseTarget(value);
  return typeof target === "string" ? null : value.trim();
}

function checkGrowth(value: unknown, segmentCount: number, problems: string[]): void {
  if (!Array.isArray(value)) {
    problems.push("growth 要写成数组");
    return;
  }
  for (const [index, raw] of value.entries()) {
    const where = `growth 第 ${index + 1} 项`;
    if (!isRecord(raw)) {
      problems.push(`${where}不是对象`);
      continue;
    }
    const before = raw.before;
    if (
      typeof before !== "number" ||
      !Number.isInteger(before) ||
      before < 0 ||
      before >= segmentCount
    ) {
      problems.push(`${where}的 before 要在 0 到 ${Math.max(0, segmentCount - 1)} 之间`);
    }
    if (stationWhere(raw.where) === null) {
      problems.push(`${where}的 where 要写成「地图号:x,y」或「地图号」`);
    }
    if (typeof raw.why !== "string" || raw.why.trim() === "") {
      problems.push(`${where}的 why 要写清楚为什么刷`);
    }
    if (
      typeof raw.maxMinutes !== "number" ||
      !Number.isFinite(raw.maxMinutes) ||
      raw.maxMinutes <= 0
    ) {
      problems.push(`${where}的 maxMinutes 要是正数`);
    }
    if (raw.level === undefined && raw.gil === undefined) {
      problems.push(`${where}至少要写 level 或 gil 一个目标`);
    }
    for (const field of ["level", "gil"] as const) {
      const number = raw[field];
      if (number === undefined) continue;
      if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
        problems.push(`${where}的 ${field} 要是正整数`);
      }
    }
  }
}

function checkFallback(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push("fallback 要写成对象");
    return;
  }
  const retries = value.retries;
  if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 || retries > 3) {
    problems.push("fallback.retries 要是 0 到 3 的整数");
  }
  if (!isRecord(value.bossLost)) {
    problems.push("fallback.bossLost 要写成对象");
  } else {
    const levels = value.bossLost.levels;
    if (typeof levels !== "number" || !Number.isInteger(levels) || levels < 1) {
      problems.push("fallback.bossLost.levels 要是正整数");
    }
    if (value.bossLost.where !== null && stationWhere(value.bossLost.where) === null) {
      problems.push("fallback.bossLost.where 要写成「地图号:x,y」、「地图号」或 null");
    }
    const tries = value.bossLost.tries;
    if (typeof tries !== "number" || !Number.isInteger(tries) || tries < 0 || tries > 3) {
      problems.push("fallback.bossLost.tries 要是 0 到 3 的整数");
    }
  }
  if (typeof value.skipOptional !== "boolean") {
    problems.push("fallback.skipOptional 要是布尔值");
  }
  const heal = value.healBelowPct;
  if (typeof heal !== "number" || !Number.isFinite(heal) || heal < 10 || heal > 60) {
    problems.push("fallback.healBelowPct 要是 10 到 60 之间的数");
  }
}

/**
 * Task 155: chapter execution never calls the model again, so a `replan` turn-back would
 * stop the chapter for a replan that cannot happen. Only `heal-and-continue` is accepted.
 */
function checkChapterTurnBack(segments: readonly unknown[], problems: string[]): void {
  for (const [segmentIndex, raw] of segments.entries()) {
    if (!isRecord(raw) || !Array.isArray(raw.turnBack)) continue;
    for (const [index, condition] of raw.turnBack.entries()) {
      if (!isRecord(condition) || condition.then !== "replan") continue;
      problems.push(
        `第 ${segmentIndex + 1} 段回头条件第 ${index + 1} 项的 then 要改成 heal-and-continue:` +
          "整章模式执行期间不会再叫你，回头条件只能是 heal-and-continue",
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Public entry

/**
 * Validate one whole chapter plan. Segment checks run first, then chapter coverage, buys,
 * growth, fallback and order; an empty `problems` list means the caller may save the plan.
 */
export function validateChapterPlan(plan: unknown, facts: ChapterFactsData): ChapterValidation {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(plan)) {
    return { ok: false, problems: ["章计划要是 JSON 对象"], warnings: [] };
  }
  if (plan.version !== 1) problems.push("version 要是 1");
  if (plan.chapter !== facts.chapter) {
    problems.push(`chapter 是「${String(plan.chapter)}」,事实单这一章是第 ${facts.chapter} 章`);
  }
  if (typeof plan.goal !== "string" || plan.goal.trim() === "") problems.push("没有写 goal");
  if (plan.notes !== undefined && typeof plan.notes !== "string") {
    problems.push("notes 要是字符串");
  }
  const sections = sectionsOf(facts);
  const skipped = checkSkipped(plan.skipped, problems);
  const segmentValues = Array.isArray(plan.segments) ? plan.segments : [];
  if (!Array.isArray(plan.segments)) problems.push("segments 要写成数组");
  const checked = validateSegments(segmentValues, sections, skipped, problems, warnings);
  checkChapterTurnBack(segmentValues, problems);
  const stations = stationStops(checked.entries).map((stop) => stop.plan);
  checkCoverage(sections, facts, checked.entries, stations, skipped, problems);
  checkBossStationCells(checked.entries, problems);
  checkBuyStations(checked.entries, facts, problems, warnings);
  checkGrowth(plan.growth, segmentValues.length, problems);
  if (!isRecord(plan.fallback)) {
    problems.push("fallback 要写成对象");
  } else {
    checkFallback(plan.fallback, problems);
  }
  const fixed =
    checked.changed && problems.length === 0
      ? ({ ...plan, segments: checked.fixed } as unknown as ChapterPlan)
      : undefined;
  return {
    ok: problems.length === 0,
    problems,
    warnings,
    ...(fixed === undefined ? {} : { fixed }),
  };
}
