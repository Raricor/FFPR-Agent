import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BOOK_ROUTE,
  bookRoute,
  defaultBookFiles,
  readBookPanel,
  type BookFiles,
  type BookPanelView,
} from "../src/plugin/panel.ts";

const NOW = "2026-11-11T10:20:00";

function book(): Record<string, unknown> {
  return {
    fromSection: "Prologue",
    fromPlace: null,
    toSection: "Wind Shrine",
    sections: [
      {
        title: "Prologue",
        order: 0,
        areaName: "洞窟、海盗据点",
        maps: [],
        places: [],
        stations: [
          {
            index: 16,
            where: "Cave - Entrance",
            kind: "move",
            mapId: 191,
            cell: null,
            action: "移动",
            text: "Go north.",
            basis: "",
            chest: null,
            pointCandidate: null,
          },
          {
            index: 18,
            where: "Cave - 1F",
            kind: "chest",
            mapId: 192,
            cell: [9, 11],
            action: "开宝箱",
            text: "Open the chest.",
            basis: "",
            chest: null,
            pointCandidate: null,
          },
          {
            index: 20,
            where: "Cave - 1F",
            kind: "talk",
            mapId: 192,
            cell: [10, 11],
            action: "对话",
            text: "Talk.",
            basis: "",
            chest: null,
            pointCandidate: null,
          },
        ],
        notes: [],
        chests: [],
        guideChestItems: [],
        chestsMatched: 1,
        chestsTotal: 2,
        monsters: [],
        bosses: [],
        blueMagic: [],
        grind: [],
        bestiaryMissing: 3,
        blueMagicMissing: 0,
        mismatches: 1,
      },
    ],
    totals: {
      sections: 1,
      stations: 3,
      chestsMatched: 1,
      chestsTotal: 2,
      bestiaryMissing: 3,
      bestiaryUnknown: true,
      blueMagicMissing: 0,
      mismatches: 1,
    },
  };
}

function progress(): Record<string, unknown> {
  return {
    game: "ff5",
    section: "Prologue",
    startedAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
    stations: [
      { index: 0, status: "done", note: "走到洞口" },
      { index: 1, status: "current", note: "开了 (9,11)" },
      { index: 2, status: "pending", note: "" },
    ],
    stats: {
      tools: 12,
      go: 7,
      route: 2,
      handoffs: 1,
      chestsOpened: 1,
      chestsTotal: 2,
      bestiaryMissing: 3,
      blueMagicMissing: null,
      minutes: 14,
    },
  };
}

async function withFiles(
  files: { readonly book?: unknown; readonly progress?: unknown },
  run: (paths: BookFiles) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ffpr-book-"));
  const paths: BookFiles = {
    book: join(directory, "routebook-ff5.json"),
    progress: join(directory, "routebook-progress-ff5.json"),
  };
  try {
    if (files.book !== undefined) {
      await writeFile(
        paths.book,
        typeof files.book === "string" ? files.book : JSON.stringify(files.book),
        "utf8",
      );
    }
    if (files.progress !== undefined) {
      await writeFile(
        paths.progress,
        typeof files.progress === "string" ? files.progress : JSON.stringify(files.progress),
        "utf8",
      );
    }
    await run(paths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function sectionOf(view: BookPanelView) {
  assert.ok(view.section);
  return view.section;
}

void test("both files show the current section, every station and the acceptance numbers", async () => {
  await withFiles({ book: book(), progress: progress() }, async (paths) => {
    const view = await readBookPanel(paths);
    assert.equal(view.title, "路线书");
    assert.equal(view.status, "进行中");
    assert.equal(view.message, null);
    const section = sectionOf(view);
    assert.equal(section.heading, "Prologue(洞窟、海盗据点)");
    assert.match(section.startedText, /^开始 11-11 10:20$/u);
    assert.equal(
      section.acceptanceText,
      "工具 12(go 7、route 2)、交回 1、宝箱 1/2、图鉴还缺 3、青魔法还缺 未知、用时 14 分",
    );
    assert.deepEqual(
      section.stations.map((row) => [row.number, row.mapText, row.cellText, row.statusText]),
      [
        [1, "191", "—", "完成"],
        [2, "192", "(9,11)", "进行中"],
        [3, "192", "(10,11)", "待做"],
      ],
    );
    assert.deepEqual(
      section.stations.map((row) => row.current),
      [false, true, false],
    );
    assert.equal(section.stations[1]?.note, "开了 (9,11)");
    assert.ok(view.totals);
    assert.deepEqual(view.totals.headers, ["段", "站点", "宝箱", "图鉴缺", "青魔法缺", "对不上"]);
    assert.deepEqual(view.totals.rows, [["1 段", "3", "1/2", "3+?", "0", "1"]]);
  });
});

void test("only the route book says execution has not started", async () => {
  await withFiles({ book: book() }, async (paths) => {
    const view = await readBookPanel(paths);
    assert.equal(view.status, "还没开始执行");
    assert.equal(view.message, "还没开始执行");
    assert.equal(view.section, null);
    assert.ok(view.totals);
  });
});

void test("neither file says there is no route book yet", async () => {
  await withFiles({}, async (paths) => {
    const view = await readBookPanel(paths);
    assert.equal(view.status, "还没有路线书");
    assert.equal(view.message, "还没有路线书");
    assert.equal(view.section, null);
    assert.equal(view.totals, null);
  });
});

void test("a broken route book is explained in Chinese and does not throw", async () => {
  await withFiles({ book: "{not json", progress: progress() }, async (paths) => {
    const view = await readBookPanel(paths);
    assert.equal(view.status, "路线书读不了");
    assert.match(view.message ?? "", /读不懂路线书/u);
    assert.equal(view.section, null);
    assert.equal(view.totals, null);
  });
});

void test("a broken progress file still shows the route book's totals", async () => {
  await withFiles({ book: book(), progress: "{not json" }, async (paths) => {
    const view = await readBookPanel(paths);
    assert.equal(view.status, "进度读不了");
    assert.match(view.message ?? "", /读不懂路线书进度/u);
    assert.equal(view.section, null);
    assert.ok(view.totals);
  });
});

void test("a progress section missing from the route book is named, not guessed", async () => {
  const other = { ...progress(), section: "Wind Shrine" };
  await withFiles({ book: book(), progress: other }, async (paths) => {
    const view = await readBookPanel(paths);
    assert.equal(view.status, "进行中");
    assert.match(view.message ?? "", /风之神殿|Wind Shrine/u);
    assert.match(view.message ?? "", /不在路线书里/u);
    assert.equal(view.section, null);
  });
});

void test("a finished progress marks the section done and falls back to guide step indexes", async () => {
  const finished = {
    ...progress(),
    finishedAt: "2026-11-11T10:34:00",
    stations: [
      { index: 16, status: "done", note: "走到洞口" },
      { index: 18, status: "done", note: "开了 (9,11)" },
      { index: 20, status: "done", note: "说完话" },
    ],
  };
  await withFiles({ book: book(), progress: finished }, async (paths) => {
    const view = await readBookPanel(paths);
    assert.equal(view.status, "已完成");
    const section = sectionOf(view);
    assert.equal(section.stateText, "已完成");
    assert.deepEqual(
      section.stations.map((row) => row.statusText),
      ["完成", "完成", "完成"],
    );
    assert.equal(
      section.stations.some((row) => row.current),
      false,
    );
  });
});

void test("an unknown status is shown as pending rather than crashing", async () => {
  const odd = {
    ...progress(),
    stations: [{ index: 0, status: "surprise", note: "" }],
  };
  await withFiles({ book: book(), progress: odd }, async (paths) => {
    const view = await readBookPanel(paths);
    const section = sectionOf(view);
    const first = section.stations[0];
    assert.ok(first);
    assert.equal(first.statusText, "待做");
    assert.equal(first.current, false);
  });
});

void test("the book route returns the rendered view over HTTP", async () => {
  await withFiles({ book: book(), progress: progress() }, async (paths) => {
    const route = bookRoute(undefined, () => paths);
    assert.equal(route.path, BOOK_ROUTE);
    const body = (await (
      await route.fetch(new Request("http://localhost/api/ffpr/book?game=ff5"))
    ).json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    const view = body.view as BookPanelView;
    assert.equal(view.status, "进行中");
    assert.equal(view.section?.heading, "Prologue(洞窟、海盗据点)");
  });
});

void test("default files are the .deps/ds names task 117 will replace with Config", () => {
  const paths = defaultBookFiles("ff5");
  assert.match(paths.book, /\.deps[/\\]ds[/\\]routebook-ff5\.json$/u);
  assert.match(paths.progress, /\.deps[/\\]ds[/\\]routebook-progress-ff5\.json$/u);
});
