import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

interface Preset {
  readonly id: string;
  readonly name: string;
  readonly game: string;
  readonly tactician: boolean;
}

function valueAfter(lines: readonly string[], prefix: string): string | undefined {
  return lines
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

/** The twelve presets of task 21, read from the patch dsh applies. */
async function presets(): Promise<Preset[]> {
  const text = await readFile(join(import.meta.dirname, "..", "cordis.patch.yml"), "utf8");
  const lines = text.split("\n");
  const starts = lines.flatMap((line, index) =>
    line.startsWith("    - id: preset-") ? [index] : [],
  );
  return starts.map((start, position) => {
    const chunk = lines.slice(start, starts[position + 1] ?? lines.length);
    const id = valueAfter(chunk, "        id: ") ?? assert.fail("preset 没有 id");
    const name = valueAfter(chunk, "        name: ") ?? assert.fail("preset 没有 name");
    const game = valueAfter(chunk, "              game: ") ?? assert.fail(`${id} 没有 game`);
    return {
      id,
      name,
      game,
      tactician: chunk.join("\n").includes("role: tactician"),
    };
  });
}

void test("the patch has one panel and twelve player/tactician presets for six games", async () => {
  const text = await readFile(join(import.meta.dirname, "..", "cordis.patch.yml"), "utf8");
  assert.equal(text.split("\n").filter((line) => line === "    - id: ffpr-panel").length, 1);
  const found = await presets();
  assert.equal(found.length, 12);
  const players = found.filter((preset) => !preset.tactician);
  const tacticians = found.filter((preset) => preset.tactician);
  assert.equal(players.length, 6);
  assert.equal(tacticians.length, 6);
  assert.deepEqual(
    players.map((preset) => [preset.id, preset.game, preset.name]),
    [
      ["ffpr", "ff5", "FF5 玩家"],
      ["ffpr-ff1", "ff1", "FF1 玩家"],
      ["ffpr-ff2", "ff2", "FF2 玩家"],
      ["ffpr-ff3", "ff3", "FF3 玩家"],
      ["ffpr-ff4", "ff4", "FF4 玩家"],
      ["ffpr-ff6", "ff6", "FF6 玩家"],
    ],
  );
  assert.deepEqual(
    tacticians.map((preset) => [preset.id, preset.game, preset.name]),
    [
      ["ffpr-tactician", "ff5", "FF5 战术官"],
      ["ffpr-tactician-ff1", "ff1", "FF1 战术官"],
      ["ffpr-tactician-ff2", "ff2", "FF2 战术官"],
      ["ffpr-tactician-ff3", "ff3", "FF3 战术官"],
      ["ffpr-tactician-ff4", "ff4", "FF4 战术官"],
      ["ffpr-tactician-ff6", "ff6", "FF6 战术官"],
    ],
  );
});
