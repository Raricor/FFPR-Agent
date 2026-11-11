/**
 * Task 150: the chapter table. The walkthrough has 77 sections (indexes 0–76; 0 is the
 * introduction and 76 the ending), grouped here into 23 chapters. Only the numbers live in
 * code; a chapter's title is the first section's title → the last section's title, read from
 * `.deps/knowledge/ff5/guide.json` at run time.
 *
 * The ranges are the user's 11-11 decision: one chapter is everything up to the next story
 * milestone, so the model plans a whole chapter once instead of patching one section at a time.
 */

import { Guide, INDEX_FILE } from "../guide/kb.ts";
import { chooseDefaultSection } from "./facts.ts";
import type { RouteBookSave, RouteSection } from "../stage/route-book.ts";
import { sectionFinished } from "../stage/route-book-load.ts";
import type { ChapterRange } from "./chapter-types.ts";

/** The 23 chapter ranges, in walkthrough order; both ends are inclusive section indexes. */
export const CHAPTER_RANGES: readonly ChapterRange[] = [
  { chapter: 1, from: 1, to: 3 },
  { chapter: 2, from: 4, to: 7 },
  { chapter: 3, from: 8, to: 10 },
  { chapter: 4, from: 11, to: 14 },
  { chapter: 5, from: 15, to: 16 },
  { chapter: 6, from: 17, to: 20 },
  { chapter: 7, from: 21, to: 23 },
  { chapter: 8, from: 24, to: 25 },
  { chapter: 9, from: 26, to: 27 },
  { chapter: 10, from: 28, to: 31 },
  { chapter: 11, from: 32, to: 33 },
  { chapter: 12, from: 34, to: 36 },
  { chapter: 13, from: 37, to: 40 },
  { chapter: 14, from: 41, to: 44 },
  { chapter: 15, from: 45, to: 47 },
  { chapter: 16, from: 48, to: 51 },
  { chapter: 17, from: 52, to: 53 },
  { chapter: 18, from: 54, to: 58 },
  { chapter: 19, from: 59, to: 61 },
  { chapter: 20, from: 62, to: 64 },
  { chapter: 21, from: 65, to: 67 },
  { chapter: 22, from: 68, to: 71 },
  { chapter: 23, from: 72, to: 75 },
];

/** The chapter containing a walkthrough section index; 0 and 76 are outside every chapter. */
export function chapterForSection(index: number): ChapterRange | null {
  if (!Number.isInteger(index)) return null;
  return CHAPTER_RANGES.find((range) => index >= range.from && index <= range.to) ?? null;
}

/** A chapter by its 1-based number (1–23). */
export function chapterByNumber(chapter: number): ChapterRange | null {
  return CHAPTER_RANGES.find((range) => range.chapter === chapter) ?? null;
}

function guideTitle(guide: Guide | null | undefined, index: number): string | null {
  const title = guide?.walkthrough[index]?.title;
  return title === undefined || title.trim() === "" ? null : title.trim();
}

/**
 * The chapter title: the first section's title → the last section's. Without the guide (tests,
 * a missing `.deps`) the fallback names the range instead of inventing a place name.
 */
export function chapterTitle(chapter: ChapterRange, guide: Guide | null | undefined): string {
  const first = guideTitle(guide, chapter.from);
  const last = guideTitle(guide, chapter.to);
  if (first !== null && last !== null) {
    return first === last ? first : `${first} → ${last}`;
  }
  if (first !== null) return first;
  if (last !== null) return last;
  return `第 ${chapter.chapter} 章(攻略第 ${chapter.from}–${chapter.to} 节)`;
}

/**
 * The chapter the party is in: `facts.ts`'s "current, unfinished section" picker (the section
 * covering the current map, else the next unfinished one), then that section's chapter. The
 * route book's array position is not the guide index, so `section.order` is what is mapped.
 */
export function currentChapter(
  sections: readonly RouteSection[],
  mapId: number | null,
  save: RouteBookSave,
): ChapterRange | null {
  const choice = chooseDefaultSection(sections, mapId, (section) => sectionFinished(section, save));
  return choice === null ? null : chapterForSection(choice.section.order);
}

/**
 * The chapter's guide sections in order, full text. Read at run time from `guide.json` by
 * `loadChapterGuideText`; this pure form takes the loaded guide so tests never touch `.deps`.
 */
export function chapterGuideText(chapter: ChapterRange, guide: Guide | null): string {
  if (guide === null) return "";
  const out: string[] = [];
  for (let index = chapter.from; index <= chapter.to; index += 1) {
    const section = guide.walkthrough[index];
    if (section === undefined) continue;
    out.push(`### 第 ${index} 节 ${section.title}\n${section.text}`);
  }
  return out.join("\n\n");
}

/** Load `.deps/knowledge/<game>/guide.json` and return the chapter's full guide text. */
export async function loadChapterGuideText(
  chapter: ChapterRange,
  guidePath: string = INDEX_FILE,
  signal?: AbortSignal,
): Promise<string> {
  const guide = await Guide.load(guidePath, signal);
  if (guide === null)
    throw new Error(`读不到攻略索引 ${guidePath},取不了第 ${chapter.chapter} 章原文`);
  return chapterGuideText(chapter, guide);
}
