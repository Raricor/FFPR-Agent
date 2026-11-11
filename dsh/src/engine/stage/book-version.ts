/**
 * Route-book plan versioning (task 131, 11-11). A saved stage plan's route comes from one book
 * section; when the code that turns a section into stops changes, or the section's station data
 * changes, the old plan is stale and must be rebuilt instead of trusted.
 *
 * The digest deliberately covers save-independent station identity only. Opening a chest or
 * learning a blue spell changes the live build but not the guide the plan was written from, so
 * it must not make a running plan stale halfway through a section.
 */

import type { RouteSection, RouteStation } from "./route-book.ts";
import type { StagePlan, StageTarget } from "./types.ts";

/** Bump this whenever the section → stage plan conversion changes. */
export const ROUTE_BOOK_PLAN_VERSION = 2;

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function stationShape(station: RouteStation): unknown[] {
  return [
    station.index,
    station.where,
    station.kind,
    station.mapId,
    station.cell === null ? null : [station.cell[0], station.cell[1]],
    station.action,
    station.text,
    station.basis,
    station.chest === null
      ? null
      : [
          station.chest.item,
          station.chest.text,
          station.chest.mapId,
          station.chest.cell,
          station.chest.match,
          station.chest.note,
        ],
    station.grind === undefined || station.grind === null
      ? null
      : [station.grind.blueMagic, station.grind.bestiary],
  ];
}

/** Stable digest of the guide data a section's plan is built from, without this save's state. */
export function bookSectionDigest(section: RouteSection): string {
  const data = [
    section.title,
    section.order,
    section.areaName,
    section.maps.map((map) => [map.mapId, map.name, map.areaName]),
    section.places.map((place) => [place.title, place.mapIds, place.unmatched]),
    section.stations.map(stationShape),
    section.revisit?.stations.map(stationShape) ?? [],
    section.notes.map((note) => [note.index, note.where, note.text, note.basis]),
  ];
  return hashText(JSON.stringify(data));
}

/** The statistics label: the book's section plus the Chinese area, never a game resource name. */
export function bookPlanLabel(section: RouteSection): string {
  const area =
    section.areaName?.trim() ||
    section.maps.find((map) => (map.areaName?.trim() ?? "") !== "")?.areaName?.trim() ||
    "";
  if (area === "" || area === section.title) return section.title;
  return `${section.title}（${area}）`;
}

/** The target a book plan is stored under; the first map the section really visits. */
export function bookPlanTarget(section: RouteSection): StageTarget | null {
  const mapId = section.maps.find((map) => map.mapId !== 1)?.mapId ?? null;
  if (mapId === null) return null;
  return {
    mapId,
    areaName: section.areaName,
    label: bookPlanLabel(section),
  };
}

/** The first-plan line task 131 asks the tool result to start with. */
export function bookPlanAnnouncement(section: RouteSection, route: StagePlan["route"]): string {
  let chests = 0;
  let story = 0;
  let handoffs = 0;
  for (const stop of route) {
    const kind = stop.book?.kind;
    if (stop.do === "handoff" || stop.do === "boss" || kind === "boss") {
      handoffs += 1;
    } else if (kind === "chest" || kind === "hidden" || stop.do === "open") {
      chests += 1;
    } else if (kind === "cutscene" || kind === "talk") {
      story += 1;
    }
  }
  return (
    `已按路线书为「${bookPlanLabel(section)}」生成计划，共 ${route.length} 站` +
    `(宝箱 ${chests}、剧情 ${story}、交回 ${handoffs}),代码会按计划走;` +
    "处理完交回站再 `route {}`"
  );
}
