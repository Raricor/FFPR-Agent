/**
 * Markdown rendering for the route book (task 115). Kept apart from the pure alignment so the
 * user-facing text can change without touching how maps, chests and spells are matched.
 */

import type { Cell } from "../nav.ts";
import type {
  RouteBook,
  RouteGrind,
  RouteMonster,
  RoutePlace,
  RouteSection,
} from "./route-book.ts";

/** Chinese Markdown for the user's review: one section per walkthrough chapter. */
export function renderRouteBook(book: RouteBook): string {
  const origin =
    book.fromPlace === null ? book.fromSection : `${book.fromSection} / ${book.fromPlace}`;
  const lines: string[] = [
    `# 路线书:${origin} → ${book.toSection}`,
    "",
    "## 总表",
    "",
    "| # | 段 | 地区 | 站点 | 剧情站有坐标 | 宝箱 | 图鉴缺 | 青魔法缺 | 回头学 | 对不上 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  book.sections.forEach((section, index) => {
    lines.push(
      `| ${index + 1} | ${markdown(section.title)} | ${markdown(section.areaName ?? "没对上地图")} | ${section.stations.length} | ${storyText(section)} | ${section.chestsMatched}/${section.chestsTotal} | ${missingText(section)} | ${blueMissingText(section)} | ${section.revisit === null ? "—" : section.revisit.stations.length} | ${section.mismatches.length} |`,
    );
  });
  const blueUnknown = book.sections.some((section) =>
    section.blueMagic.some((spell) => spell.learned === null),
  );
  const story = book.sections.reduce(
    (sum, section) => {
      const counts = storyCounts(section);
      return { located: sum.located + counts.located, total: sum.total + counts.total };
    },
    { located: 0, total: 0 },
  );
  lines.push(
    `| 合计 | ${book.totals.sections} 段 | — | ${book.totals.stations} | ${storyRatio(story)} | ${book.totals.chestsMatched}/${book.totals.chestsTotal} | ${book.totals.bestiaryMissing}${book.totals.bestiaryUnknown ? "+?" : ""} | ${book.totals.blueMagicMissing}${blueUnknown ? "+?" : ""} | ${book.totals.revisit} | ${book.totals.mismatches} |`,
    "",
  );
  book.sections.forEach((section, index) => {
    renderSection(lines, section, index);
  });
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Rendering

function renderSection(lines: string[], section: RouteSection, index: number): void {
  const area = section.areaName ?? "没对上地图";
  lines.push(`## ${index + 1}. ${section.title}(${area})`, "");
  lines.push(`小节:${section.places.map(renderPlace).join("、") || "—"}`, "");
  lines.push("### 地图和依据", "");
  if (section.maps.length === 0) {
    lines.push("没对上地图。", "");
  } else {
    lines.push("| 地图 | 名称 | 地区 | 依据 |", "| --- | --- | --- | --- |");
    for (const map of section.maps) {
      lines.push(
        `| ${map.mapId} | ${markdown(map.name)} | ${markdown(map.areaName ?? "—")} | ${markdown(map.reasons.join(";") || "—")} |`,
      );
    }
    lines.push("");
  }

  lines.push("### 站点", "");
  if (section.stations.length === 0) {
    lines.push("攻略这一段没有步骤。", "");
  } else {
    lines.push(
      "| 序号 | 图 | 坐标 | 做什么 | 攻略原文 | 依据 |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    section.stations.forEach((station, stationIndex) => {
      lines.push(
        `| ${stationIndex + 1} | ${station.mapId ?? "—"} | ${cellText(station.cell)} | ${markdown(station.action)} | ${markdown(station.text)} | ${markdown(station.basis)} |`,
      );
    });
    lines.push("");
  }
  if (section.notes.length > 0) {
    lines.push(`另有 ${section.notes.length} 条攻略说明(JSON 里保留全文)。`, "");
  }

  lines.push("### 收集清单", "");
  renderChests(lines, section);
  renderBestiary(lines, section);
  renderBlueMagic(lines, section);
  renderGrind(lines, section);
  lines.push("### 对不上的地方", "");
  if (section.mismatches.length === 0) {
    lines.push("- 没有。", "");
  } else {
    for (const mismatch of section.mismatches) lines.push(`- ${mismatch}`);
    lines.push("");
  }
  if (section.revisit !== null) renderRevisit(lines, section);
}

/** Task 119: the "回头学" block uses the same map/station/grind layout as a normal section. */
function renderRevisit(lines: string[], section: RouteSection): void {
  const revisit = section.revisit;
  if (revisit === null) return;
  lines.push(`### ${revisit.title}`, "");
  lines.push(revisit.note, "");
  if (revisit.maps.length > 0) {
    lines.push("| 地图 | 名称 | 地区 | 依据 |", "| --- | --- | --- | --- |");
    for (const map of revisit.maps) {
      lines.push(
        `| ${map.mapId} | ${markdown(map.name)} | ${markdown(map.areaName ?? "—")} | ${markdown(map.reasons.join(";") || "—")} |`,
      );
    }
    lines.push("");
  }
  lines.push("#### 回头学站点", "");
  if (revisit.stations.length === 0) {
    lines.push("没有要回头补的东西。", "");
  } else {
    lines.push(
      "| 序号 | 图 | 坐标 | 做什么 | 攻略原文 | 依据 |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    revisit.stations.forEach((station, index) => {
      lines.push(
        `| ${index + 1} | ${station.mapId ?? "—"} | ${cellText(station.cell)} | ${markdown(station.action)} | ${markdown(station.text)} | ${markdown(station.basis)} |`,
      );
    });
    lines.push("");
  }
  renderGrindRows(lines, revisit.grind, "回头没有要刷的怪。");
}

function renderPlace(place: RoutePlace): string {
  const maps = place.mapIds.length === 0 ? "没对上" : place.mapIds.join(",");
  const note = place.note === null ? "" : `(${place.note})`;
  return `${place.title}[${maps}]${note}`;
}

function renderChests(lines: string[], section: RouteSection): void {
  lines.push("#### 宝箱 / 隐藏道具", "");
  if (section.chests.length === 0) {
    lines.push("攻略这一段没有写宝箱或隐藏道具。", "");
    return;
  }
  lines.push(
    `攻略说这里有：${section.guideChestItems.join("、")}（共 ${section.guideChestItems.length} 个）。`,
    "",
  );
  lines.push("| 编号 | 东西 | 图 | 坐标 | 状态 | 依据 |", "| --- | --- | --- | --- | --- | --- |");
  for (const chest of section.chests) {
    const number =
      chest.n === null ? "—" : `${chest.kind === "hidden" ? "隐藏" : "宝箱"} ${chest.n}`;
    const unpaired = chest.match === "none" && chest.candidates.length > 0;
    const opened = unpaired
      ? "未配对"
      : chest.opened === null
        ? "开没开未知"
        : chest.opened
          ? "已开"
          : "未开";
    lines.push(
      `| ${number} | ${markdown(chest.item)} | ${chest.mapId ?? "—"} | ${cellText(chest.cell)} | ${opened} | ${markdown(chest.note)} |`,
    );
  }
  const opened = section.chests.filter((chest) => chest.opened === true).length;
  const unknown = section.chests.filter(
    (chest) => chest.opened === null && !(chest.match === "none" && chest.candidates.length > 0),
  ).length;
  const unpaired = section.chests.filter(
    (chest) => chest.match === "none" && chest.candidates.length > 0,
  ).length;
  const unknownText = unknown === 0 ? "" : `;开没开未知 ${unknown} 个`;
  const unpairedText = unpaired === 0 ? "" : `;未配对 ${unpaired} 个`;
  lines.push(
    `本段合计 ${section.chestsMatched}/${section.chestsTotal};已开 ${opened} 个${unknownText}${unpairedText}。`,
    "",
  );
}

function renderBestiary(lines: string[], section: RouteSection): void {
  lines.push("#### 图鉴", "");
  if (section.monsters.length === 0) {
    lines.push("攻略和遇敌表都没有这一段的普通怪。", "");
  } else {
    lines.push("| 图鉴 | 怪 | 状态 | 错过 | 图 |", "| --- | --- | --- | --- | --- |");
    for (const monster of section.monsters) {
      lines.push(
        `| ${monster.bookId === null ? "—" : padBook(monster.bookId)} | ${markdown(monster.name)}${monster.guideName === null ? "" : `(${markdown(monster.guideName)})`} | ${registeredText(monster)} | ${monster.missable ? "错过就没了" : "—"} | ${monster.maps.join(",") || "—"} |`,
      );
    }
    lines.push("");
  }
  lines.push("#### 首领", "");
  if (section.bosses.length === 0) {
    lines.push("这一段没有记下首领。", "");
    return;
  }
  lines.push("| 图鉴 | 首领 | 状态 | 图 |", "| --- | --- | --- | --- |");
  for (const boss of section.bosses) {
    lines.push(
      `| ${boss.bookId === null ? "—" : padBook(boss.bookId)} | ${markdown(boss.name)}${boss.guideName === null ? "" : `(${markdown(boss.guideName)})`} | ${registeredText(boss)} | ${boss.maps.join(",") || "—"} |`,
    );
  }
  lines.push("");
}

function renderBlueMagic(lines: string[], section: RouteSection): void {
  lines.push("#### 青魔法", "");
  if (section.blueMagic.length === 0) {
    lines.push("这一段没有记下青魔法。", "");
    return;
  }
  lines.push(
    "| 青魔法 | 教的怪 | 什么时候能学 | 窗口 | 学了没 | 青魔导士 | 出没 | 说明 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const spell of section.blueMagic) {
    const teachers = spell.teachers.map((teacher) => teacher.monster).join("、") || "—";
    const learned = spell.learned === null ? "未知" : spell.learned ? "学了" : "没学";
    const job = spell.hasBlueMage === null ? "未知" : spell.hasBlueMage ? "有" : "没有";
    lines.push(
      `| ${markdown(spell.name)} | ${markdown(teachers)} | ${markdown(spell.when)} | ${markdown(spell.window)} | ${learned} | ${job} | ${spell.maps.join(",") || "—"} | ${markdown(spell.note)} |`,
    );
  }
  lines.push("");
}

function renderGrind(lines: string[], section: RouteSection): void {
  renderGrindRows(lines, section.grind, "这一段没有“错过就没了”的怪或青魔法,不需要专门刷。");
}

function renderGrindRows(lines: string[], rows: readonly RouteGrind[], emptyText: string): void {
  lines.push("#### 刷怪建议", "");
  if (rows.length === 0) {
    lines.push(emptyText, "");
    return;
  }
  for (const grind of rows) {
    const chance = grind.chance === null ? "概率未知" : `约 ${Math.round(grind.chance * 100)}%`;
    const weight = grind.weight === null ? "权重未知" : `权重 ${grind.weight}`;
    const until = grind.until.blueMagic === null ? "" : `;直到学会 ${grind.until.blueMagic}`;
    lines.push(
      `- 在 ${grind.mapId} 刷 ${grind.monster}(${grind.what}):${weight},${chance}${until};${grind.reason}`,
    );
  }
  lines.push("");
}

/** Task 122: cutscene/dialog/mechanism stations, and how many already have a real cell. */
function storyCounts(section: RouteSection): { located: number; total: number } {
  const stations = section.stations.filter(
    (station) =>
      station.kind === "cutscene" || station.kind === "talk" || station.kind === "switch",
  );
  return {
    located: stations.filter((station) => station.mapId !== null && station.cell !== null).length,
    total: stations.length,
  };
}

function storyText(section: RouteSection): string {
  return storyRatio(storyCounts(section));
}

function storyRatio(counts: { located: number; total: number }): string {
  return counts.total === 0 ? "—" : `${counts.located}/${counts.total}`;
}

function missingText(section: RouteSection): string {
  const unknown = [...section.monsters, ...section.bosses].some(
    (monster) => monster.registered === null,
  );
  return `${section.bestiaryMissing}${unknown ? "+?" : ""}`;
}

function blueMissingText(section: RouteSection): string {
  const unknown = section.blueMagic.some((spell) => spell.learned === null);
  return `${section.blueMagicMissing}${unknown ? "+?" : ""}`;
}

function registeredText(monster: RouteMonster): string {
  if (monster.registered === null) return "未知";
  return monster.registered ? "已登记" : "缺";
}

function markdown(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim();
}

function cellText(cell: Cell | null): string {
  return cell === null ? "—" : `(${cell[0]},${cell[1]})`;
}

function padBook(bookId: number): string {
  return String(bookId).padStart(3, "0");
}
