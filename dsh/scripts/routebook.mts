// Build the FF5 route book offline and write it for review. No bridge, no laptop.
//
//   node scripts/routebook.mts
//   node scripts/routebook.mts --from "Prologue" --from-place "Cave - Entrance" --to "Wind Shrine"
//   node scripts/routebook.mts --game ff5
//
// Reads the cached guide, the knowledge export, the atlas and the first-arrival log under
// `.deps/`; writes `.deps/ds/routebook-<game>.md` and `.json`; prints the total table.

import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Atlas } from "../src/engine/atlas.ts";
import { loadKnowledge } from "../src/engine/knowledge/index.ts";
import { DEPS } from "../src/engine/paths.ts";
import { parseWalkthrough } from "../src/engine/stage/guide-steps.ts";
import { buildRouteBook } from "../src/engine/stage/route-book.ts";
import { readRouteBookFiles } from "../src/engine/stage/route-book-load.ts";
import { renderRouteBook } from "../src/engine/stage/route-book-render.ts";
import { isRecord } from "../src/engine/values.ts";

interface Options {
  readonly game: string;
  readonly from: string;
  readonly fromPlace: string | null;
  readonly to: string;
}

function arg(args: readonly string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function optionsOf(args: readonly string[]): Options {
  const fromPlace = arg(args, "--from-place", "Cave - Entrance");
  return {
    game: arg(args, "--game", "ff5"),
    from: arg(args, "--from", "Prologue"),
    fromPlace: fromPlace === "" ? null : fromPlace,
    to: arg(args, "--to", "Wind Shrine"),
  };
}

async function readGuideSections(game: string) {
  const path = join(DEPS, "knowledge", game, "guide.json");
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`攻略 ${path} 不是 JSON 对象`);
  return parseWalkthrough(parsed.walkthrough);
}

async function readVisitOrder(game: string): Promise<string[]> {
  const path = join(DEPS, "ds", `activity-${game}.jsonl`);
  try {
    await access(path);
  } catch {
    return [];
  }
  const body = await readFile(path, "utf8");
  const order: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.kind !== "event" || typeof parsed.text !== "string") {
      continue;
    }
    const match = /^地点 首次到达「(.+)」$/u.exec(parsed.text.trim());
    if (match?.[1] !== undefined) order.push(match[1]);
  }
  return order;
}

async function bestiaryOf(game: string, knowledge: Awaited<ReturnType<typeof loadKnowledge>>) {
  const path = join(DEPS, "ds", `bestiary-save-${game}.json`);
  try {
    await access(path);
  } catch {
    return null;
  }
  return new Set(knowledge.progress.bestiary);
}

function totalTable(markdown: string): string {
  const lines = markdown.split("\n");
  const start = lines.indexOf("## 总表");
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

async function main(): Promise<void> {
  const options = optionsOf(process.argv.slice(2));
  if (process.argv.includes("--help")) {
    console.log(
      'node scripts/routebook.mts [--from "Prologue"] [--from-place "Cave - Entrance"] [--to "Wind Shrine"] [--game ff5]',
    );
    return;
  }
  const sections = await readGuideSections(options.game);
  const knowledge = await loadKnowledge({
    game: options.game,
    atlas: null,
    collisions: null,
  });
  const atlas = await Atlas.load(join(DEPS, "ds", `atlas-${options.game}.json`));
  const visitOrder = await readVisitOrder(options.game);
  const bestiary = await bestiaryOf(options.game, knowledge);
  const files = await readRouteBookFiles(options.game, knowledge.filesDir);
  const book = buildRouteBook({
    sections,
    fromSection: options.from,
    ...(options.fromPlace === null ? {} : { fromPlace: options.fromPlace }),
    toSection: options.to,
    knowledge,
    atlas,
    visitOrder,
    ...(files === null ? {} : { files }),
    save: {
      bestiary,
      blueMagic: null,
      jobs: null,
      openedChests: null,
    },
  });
  const markdown = renderRouteBook(book);
  const stem = join(DEPS, "ds", `routebook-${options.game}`);
  await writeFile(`${stem}.md`, markdown, "utf8");
  await writeFile(`${stem}.json`, `${JSON.stringify(book, null, 2)}\n`, "utf8");
  console.log(totalTable(markdown));
  console.log(`\n写:${stem}.md\n写:${stem}.json`);
}

await main();
