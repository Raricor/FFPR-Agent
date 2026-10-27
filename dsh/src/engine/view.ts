/**
 * Text views of the game state for people and for the model: the probe's newest sample with
 * the events since the last look, items and entities. Ported from ffpr_agent/view.py; the SSH
 * state script and its parser live in state-script.ts (task 02).
 */

import { isRecord, list, record, truthy } from "./values.ts";
import type { Cell } from "./nav.ts";
import { statuses } from "./skills/gambit.ts";
import type { Json } from "./skills/gambit.ts";

export const TAIL_BYTES = 96 * 1024;

// "Nothing" placeholders the item list carries for empty equipment slots.
export const PLACEHOLDER_ITEMS: ReadonlySet<string> = new Set(["空手", "无"]);

// Named event cells the model should know about. A name may carry a circled number on the
// map (流される①, 流される②); the note is looked up without it.
export const EVENT_NOTES: ReadonlyMap<string, string> = new Map([
  ["流される", "传送带，踩上去会被带走"],
]);

const CIRCLED_DIGITS = /[①-⑳]/g;
const ICON_TAG = /<IC_[A-Z_]+>/g;

/** The event name without its circled number, for the EVENT_NOTES lookup. */
export function eventBaseName(name: string): string {
  return name.replace(CIRCLED_DIGITS, "").trim();
}

/** What the model should know about a named event cell, or "" for an unknown name. */
export function eventNote(name: string): string {
  return EVENT_NOTES.get(eventBaseName(name)) ?? "";
}

/**
 * One line per event name, its cells together: named events (conveyors, save points, story
 * triggers) are not in the collision grid, so look_around has to list them. Same-named cells
 * are merged so a room of conveyors does not flood the answer.
 */
export function describeEvents(found: unknown): string {
  const entities = Array.isArray(found) ? found : list(record(found).entities);
  const groups = new Map<string, Cell[]>();
  for (const item of entities) {
    const entity = record(item);
    const name = pyText(truthy(entity.name) ? entity.name : "").trim();
    const cellValue = truthy(entity.cell) ? entity.cell : entity.tile;
    const cell = Array.isArray(cellValue) ? cellOf(cellValue) : null;
    if (name === "" || cell === null) continue;
    const cells = groups.get(name) ?? [];
    if (!cells.some((existing) => existing[0] === cell[0] && existing[1] === cell[1])) {
      cells.push(cell);
      groups.set(name, cells);
    }
  }
  const lines: string[] = [];
  for (const [name, cells] of groups) {
    const where = cells.map((cell) => `[${cell[0]}, ${cell[1]}]`).join("、");
    const note = eventNote(name);
    lines.push(`  Event @ ${where} ${name}${note === "" ? "" : ` ${note}`}`);
  }
  return lines.join("\n");
}

function cellOf(value: readonly unknown[]): Cell | null {
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

/** Python's str() for loose JSON, so a missing field reads "None", not "undefined". */
function pyText(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) return `[${value.map(pyText).join(", ")}]`;
  if (isRecord(value)) {
    const pairs = Object.entries(value).map(([key, item]) => `'${key}': ${pyText(item)}`);
    return `{${pairs.join(", ")}}`;
  }
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** Python json.dumps(..., ensure_ascii=False), with its default ", " and ": " separators. */
function pythonJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (isRecord(value)) {
    const pairs = Object.entries(value).map(
      ([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`,
    );
    return `{${pairs.join(", ")}}`;
  }
  return "null";
}

export function describeItems(items: unknown): string {
  const found = record(items);
  const lines: string[] = [];
  const kinds: readonly (readonly [string, string])[] = [
    ["normal", "道具"],
    ["important", "贵重物品"],
  ];
  for (const [kind, label] of kinds) {
    const names: string[] = [];
    for (const item of list(found[kind])) {
      const entry = record(item);
      const name = pyText(entry.name ?? "")
        .replace(ICON_TAG, "")
        .trim();
      if (name && !PLACEHOLDER_ITEMS.has(name)) names.push(`${name}×${pyText(entry.count)}`);
    }
    lines.push(`${label}:${names.join("、") || "无"}`);
  }
  return lines.join("\n");
}

/** One line per entity: kind, cell, and what it leads to or holds. */
export function describeEntities(found: unknown): string {
  const source = record(found);
  const entities = list(source.entities);
  const lines = [`共 ${pyText(source.total)} 个实体,列出 ${entities.length} 个:`];
  for (const item of entities) {
    const entity = record(item);
    const cell = truthy(entity.cell) ? entity.cell : entity.tile;
    const extra: string[] = [];
    if (Object.hasOwn(entity, "toMap")) extra.push(`通往地图 ${pyText(entity.toMap)}`);
    if (Object.hasOwn(entity, "content")) {
      extra.push(`内容 ${pyText(entity.content)}×${pyText(entity.num)}`);
    }
    if (Object.hasOwn(entity, "npc")) extra.push(`NPC ${pyText(entity.npc)}`);
    const active = Object.hasOwn(entity, "active") ? truthy(entity.active) : true;
    if (!active) extra.push("未激活");
    const name = pyText(truthy(entity.name) ? entity.name : "");
    const line = `  ${pyText(entity.kind)} @ ${pyText(cell)} ${name} ${extra.join(" ")}`;
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

/**
 * Plain and animated entities worth a look: active ones with a name, like the canal's gate
 * doors (トルナ運河の開錠_右扉) or the crystal shards (クリスタルのかけら); the generic props
 * (【汎用】...), speech bubbles and nameless ones are left out.
 */
export function namedObjects(found: unknown): Json {
  const source = record(found);
  const kept = list(source.entities).filter((item) => {
    if (!isRecord(item)) return false;
    const active = Object.hasOwn(item, "active") ? truthy(item.active) : true;
    const name = item.name;
    return (
      active &&
      typeof name === "string" &&
      name.length > 0 &&
      !name.startsWith("【汎用】") &&
      !name.includes("吹き出し")
    );
  });
  return { ...source, total: kept.length, entities: kept };
}

/** JSON records from the tail of a probe file; the first line may be cut off. */
export function parseTail(text: string): unknown[] {
  const records: unknown[] = [];
  for (const line of text.split(/\r\n|\r|\n/).slice(1)) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // A cut-off first line, or a partially written last one, is not a record.
    }
  }
  return records;
}

// The field's moveState (bridge sample): how the party moves now. Walking needs no note.
export const RIDES: ReadonlyMap<string, string> = new Map([
  ["LowFlying", "骑着飞龙(飞不过山;进城镇和迷宫要先降落,walk_to 入口会自动降落再走进去)"],
  ["HighFlying", "乘飞空艇"],
  ["Ship", "坐船"],
  ["Chocobo", "骑陆行鸟"],
]);

/** Status conditions as 「[毒、石化]」 (bridge 0.6.3+ in battle, 0.6.5+ on the field). */
export function marks(unit: unknown): string {
  const names = statuses(unit);
  return names.length > 0 ? `[${names.join("、")}]` : "";
}

function formatCell(cell: readonly unknown[]): string {
  return `${pyText(cell[0])},${pyText(cell[1])}`;
}

export function summarize(sample: unknown, events: readonly unknown[]): string {
  const out: string[] = [];
  if (truthy(sample)) {
    const source = record(sample);
    const scene = record(source.scene);
    const user = record(source.user);
    const field = record(source.field);
    const battle = record(source.battle);
    const areaValue = truthy(user.areaText) ? user.areaText : truthy(user.area) ? user.area : "";
    const area = pyText(areaValue);
    const cell = field.cell;
    const where = Array.isArray(cell) ? `格子 ${formatCell(cell)}` : "不在地图上";
    const rideKey = truthy(field.moveState) ? pyText(field.moveState) : "";
    const ride = RIDES.get(rideKey) ?? "";
    out.push(
      `${pyText(scene.name)}/${pyText(scene.state)} · 地图 ${pyText(user.mapId)} ${area} · ${where}` +
        (ride ? ` · ${ride}` : "") +
        ` · ${truthy(battle.active) ? "战斗中" : "非战斗"} · 金钱 ${pyText(user.gil)}`,
    );
    const dialog = record(source.dialog);
    if (truthy(dialog.open)) {
      const speaker = truthy(dialog.speaker) ? `【${pyText(dialog.speaker)}】` : "";
      const lines = list(dialog.lines).filter(truthy).map(pyText).join(" / ");
      out.push(`对话框打开 ${speaker}${lines}`);
    }
    for (const [kind, value] of Object.entries(record(source.choice))) {
      if (!isRecord(value) || !truthy(value.open)) continue;
      const options = truthy(value.options)
        ? value.options
        : truthy(value.labels)
          ? value.labels
          : [];
      const cursor: unknown = value.cursor;
      const marked = list(options).map((option, index) =>
        index === cursor ? `[${pyText(option)}]` : pyText(option),
      );
      out.push(`选项(${kind}):${marked.join(" / ")}`);
    }
    if (truthy(battle.active)) {
      const sides: readonly (readonly [string, string])[] = [
        ["enemies", "敌人"],
        ["players", "我方"],
      ];
      for (const [side, label] of sides) {
        const text = list(battle[side])
          .map((unit) => {
            const row = record(unit);
            return `${pyText(row.name)} ${pyText(row.hp)}/${pyText(row.maxHp)}${marks(row)}`;
          })
          .join(",");
        out.push(`${label}:${text || "?"}`);
      }
    }
    const party = source.party;
    if (Array.isArray(party) && party.length > 0) {
      const members = party.map((unit) => {
        const row = record(unit);
        return (
          `${pyText(row.name)} Lv${pyText(row.lv)} ` +
          `${pyText(row.hp)}/${pyText(row.maxHp)}${marks(row)}`
        );
      });
      out.push(`队伍 ${members.join(",")}`);
    }
  }
  for (const value of events) {
    if (!isRecord(value)) continue;
    const type = pyText(value.type);
    if (type === "dialog.play") {
      const speaker = truthy(value.speaker) ? `【${pyText(value.speaker)}】` : "";
      const text = list(value.lines).filter(truthy).map(pyText).join(" / ");
      const ids = list(value.ids).map(pyText).join(",").slice(0, 40);
      out.push(`  + 对话 ${ids} ${speaker}${text}`);
    } else if (type === "choice.open") {
      out.push(`  + 选项 ${list(value.options).map(pyText).join(" / ")}`);
    } else if (type === "sysmsg") {
      out.push(`  + 系统消息 ${pyText(value.text)}`);
    } else if (type !== "sample" && type !== "dialog.close" && type !== "hello") {
      const body: Json = {};
      for (const [key, item] of Object.entries(value)) {
        if (!["seq", "t", "frame", "type"].includes(key)) body[key] = item;
      }
      out.push(`  + ${type} ${pythonJson(body)}`);
    }
  }
  return out.join("\n");
}
