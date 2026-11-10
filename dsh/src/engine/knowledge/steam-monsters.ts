/**
 * The Steam walkthrough's per-area monster tables (task 93 follow-up). `guide/kb.ts` already
 * parses shops and treasures but not these tables, and this module may not change it. The
 * cached section text carries:
 *
 *     BESTIARY: WIND SHRINE
 *     ID MONSTER HP MP GIL EXP
 *     008 Water Spirit 120 20 30 25
 *     BM: Water Wave
 *
 * The bestiary page (`Guide.bestiary`, number → English name, 302 rows in FF5) is the base when
 * no bridge export exists; these tables add where each number appears, its table stats and its
 * blue-magic note. Read only, and tolerant of the walkthrough's filler characters and spacing.
 */

import type { Guide } from "../guide/kb.ts";
import type { SourceRef } from "./types.ts";

export interface SteamAreaMonster {
  readonly area: string;
  readonly book: number;
  readonly name: string;
  readonly hp: number | null;
  readonly mp: number | null;
  readonly gil: number | null;
  readonly exp: number | null;
  readonly blueMagic: readonly string[];
  readonly source: SourceRef;
}

export interface SteamAreaTable {
  readonly area: string;
  readonly section: string;
  readonly source: SourceRef;
  readonly monsters: readonly SteamAreaMonster[];
}

const FILLER = /\u3164|\u00a0|\u200a|\u200b|\u200c|\ufeff/g;
const ID = /^\d{3}$/;
const COUNT = /^\d+$/;

function clean(value: string): string {
  return value.replace(FILLER, " ").replace(/\s+/g, " ").trim();
}

function blueNames(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/,|;|\/|\band\b/gi)
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    ),
  ];
}

function countOf(value: string): number | null {
  return COUNT.test(value) ? Number.parseInt(value, 10) : null;
}

/**
 * Every `BESTIARY:` table in the walkthrough, in section order. A table starts after the
 * `EXP` header cell; rows are id / name / HP / MP / GIL / EXP with an optional `BM:` line.
 * Anything that does not fit ends the table, so prose after it is ignored.
 */
export function steamAreaTables(guide: Guide | null): SteamAreaTable[] {
  if (guide === null) return [];
  const out: SteamAreaTable[] = [];
  for (const section of guide.walkthrough) {
    const lines = section.text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const marker = lines[index];
      if (!marker?.includes("BESTIARY:")) continue;
      const area = clean(marker.slice(marker.indexOf("BESTIARY:") + "BESTIARY:".length))
        .replace(/\s+AREA$/i, "")
        .trim();
      if (area === "") continue;
      let row = index + 1;
      while (row < lines.length && clean(lines[row] ?? "") !== "EXP") row += 1;
      row += 1;
      const monsters: SteamAreaMonster[] = [];
      const source: SourceRef = { kind: "guide", ref: `steam:${section.title}` };
      while (row + 5 < lines.length) {
        const bookText = clean(lines[row] ?? "");
        const name = clean(lines[row + 1] ?? "");
        const hp = countOf(clean(lines[row + 2] ?? ""));
        const mp = countOf(clean(lines[row + 3] ?? ""));
        const gil = countOf(clean(lines[row + 4] ?? ""));
        const exp = countOf(clean(lines[row + 5] ?? ""));
        if (!ID.test(bookText) || name === "" || hp === null || mp === null) break;
        if (gil === null || exp === null) break;
        row += 6;
        let blue: string[] = [];
        const next = clean(lines[row] ?? "");
        if (/^BM\s*:/i.test(next)) {
          blue = blueNames(next.replace(/^BM\s*:/i, ""));
          row += 1;
        }
        monsters.push({
          area,
          book: Number.parseInt(bookText, 10),
          name,
          hp,
          mp,
          gil,
          exp,
          blueMagic: blue,
          source,
        });
      }
      if (monsters.length > 0) out.push({ area, section: section.title, source, monsters });
      index = row - 1;
    }
  }
  return out;
}
