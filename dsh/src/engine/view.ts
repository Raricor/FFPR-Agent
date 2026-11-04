/**
 * Text views of the game state for people and for the model: the probe's newest sample with
 * the events since the last look, items and entities. Ported from ffpr_agent/view.py; the SSH
 * state script and its parser live in state-script.ts (task 02).
 */

import { isRecord, list, num, record, text, truthy } from "./values.ts";
import type { Cell, ObservedMove } from "./nav.ts";
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
  const scripts = new Map<string, Set<number>>();
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
    if (typeof entity.script === "number" && entity.script !== 0) {
      const ids = scripts.get(name) ?? new Set<number>();
      ids.add(Math.trunc(entity.script));
      scripts.set(name, ids);
    }
  }
  const lines: string[] = [];
  for (const [name, cells] of groups) {
    const where = cells.map((cell) => `[${cell[0]}, ${cell[1]}]`).join("、");
    const note = eventNote(name);
    const ids = [...(scripts.get(name) ?? [])];
    const script = ids.length === 0 ? "" : `;script ${ids.join("/")}`;
    lines.push(`  Event @ ${where} ${name}${note === "" ? "" : ` ${note}`}${script}`);
  }
  return lines.join("\n");
}

function cellOf(value: readonly unknown[]): Cell | null {
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return [value[0], value[1]];
}

const LAYER_NAMES: ReadonlyMap<number, string> = new Map([
  [0, "Bottom(第 0 层)"],
  [1, "Ground(第 1 层)"],
  [2, "Upper(第 2 层)"],
]);

/** The layer a ToLayer entity targets, from `layer` or `changeLayer` (bridge 0.13.4). */
function layerNumber(entity: Json): number | null {
  const raw = entity.layer ?? entity.targetLayer;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
    const named = raw.toLowerCase();
    if (named.includes("upper") || named.includes("top")) return 2;
    if (named.includes("ground")) return 1;
    if (named.includes("bottom")) return 0;
  }
  return null;
}

function layerText(layer: number | null): string {
  return layer === null ? "目标层未知" : (LAYER_NAMES.get(layer) ?? `第 ${layer} 层`);
}

function entityItems(found: unknown): Json[] {
  const source = Array.isArray(found) ? found : list(record(found).entities);
  return source.filter(isRecord);
}

function movementText(move: ObservedMove): string {
  const from = `(${move.from[0]}, ${move.from[1]})`;
  const to = `(${move.to[0]}, ${move.to[1]})`;
  const kind = move.kind ?? move.how;
  if (kind.includes("换层") || move.how.includes("换层")) {
    const layer = move.toLayer === undefined ? "" : `第 ${move.toLayer} 层`;
    return `换层格 ${from}${layer === "" ? "" : `→${layer}`}`;
  }
  if (kind.includes("传送带") || move.how.includes("传送带")) {
    return `传送带 ${from}→${to}`;
  }
  if (kind.includes("掉") || move.how.includes("掉")) {
    return `落下点 ${from}→${to}`;
  }
  return `${move.how} ${from}→${to}`;
}

/** Known destinations from walking, for the model to reason about gimmicks. */
export function describeMoves(moves: readonly ObservedMove[]): string {
  const lines = moves
    .filter((move) => move.how !== "走不过去")
    .map((move) => `${movementText(move)}(走过)`);
  return lines.length === 0 ? "" : `  已知去向:${lines.join("、")}`;
}

/** Names the map uses for a hole or a floor that goes away under the party. */
const FALL_WORDS = /(pitfall|fall|hole|drop|time.?switch|落下|穴)/i;

export function isFallEntity(entity: Json): boolean {
  if (entity.kind === "PointIn") return false; // the landing marker itself, not a hole
  const text = [entity.kind, entity.class, entity.name]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return FALL_WORDS.test(text);
}

function areaCells(entity: Json): Cell[] {
  const cells: Cell[] = [];
  const cell = cellOf(list(entity.cell));
  if (cell !== null) cells.push(cell);
  const area = record(entity.gimmickArea);
  const [x, y, width, height] = [num(area.x), num(area.y), num(area.width), num(area.height)];
  if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
    for (let dy = 0; dy < Math.min(Math.max(Math.round(height), 1), 20); dy++) {
      for (let dx = 0; dx < Math.min(Math.max(Math.round(width), 1), 20); dx++) {
        const found: Cell = [Math.round(x) + dx, Math.round(y) + dy];
        if (!cells.some((existing) => existing[0] === found[0] && existing[1] === found[1])) {
          cells.push(found);
        }
      }
    }
  }
  return cells;
}

/** The cells a fall/switch entity covers; for the floor map and for planning. */
export function fallCells(entity: Json): Cell[] {
  return isFallEntity(entity) ? areaCells(entity) : [];
}

/**
 * Fall edges the entities themselves name: a hole/gimmick area whose `linkObjectId` is a
 * PointIn id. A TimeSwitchingGimmickArea is the likely "floor disappears" object; the
 * PointIn is where the party lands. Only pairs actually linked become edges.
 */
export function fallMoves(entities: readonly Json[]): ObservedMove[] {
  const points = new Map<number, Cell>();
  for (const entity of entities) {
    if (entity.kind !== "PointIn" || typeof entity.id !== "number") continue;
    const cell = cellOf(list(entity.cell));
    if (cell !== null) points.set(entity.id, cell);
  }
  const moves: ObservedMove[] = [];
  for (const entity of entities) {
    if (!isFallEntity(entity) || typeof entity.linkObjectId !== "number") continue;
    const to = points.get(entity.linkObjectId);
    if (to === undefined) continue;
    for (const from of fallCells(entity)) {
      if (moves.some((move) => sameCell(move.from, from) && sameCell(move.to, to))) continue;
      moves.push({ from, to, how: "洞口", kind: "fall" });
    }
  }
  return moves;
}

function sameCell(left: Cell, right: Cell): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function fallTarget(items: readonly Json[], id: number): Cell | null {
  for (const item of items) {
    if (item.kind !== "PointIn" || item.id !== id) continue;
    return cellOf(list(item.cell));
  }
  return null;
}

/**
 * Doors, layer-change cells and PointIn/落下点 cells with what is known about them. The
 * game does not open a door with the confirm key: an OpenTrigger is a box the party walks
 * into, and it plays the linked TileAnimRegion's opening animation (11-03, Fire-Powered
 * Ship 261: (10,23) pushed down and Enter did nothing; the trigger at (10,25) is on the
 * far side of the door). Kept apart from describeEvents so that function's grouped output
 * stays as it was.
 */
export function describeMechanisms(found: unknown, moves: readonly ObservedMove[] = []): string {
  const items = entityItems(found);
  const lines: string[] = [];
  const changes = new Map<number | null, Cell[]>();
  for (const entity of items) {
    if (entity.kind !== "ToLayer") continue;
    const cell = cellOf(list(entity.cell));
    if (cell === null) continue;
    const layer = layerNumber(entity);
    const cells = changes.get(layer) ?? [];
    cells.push(cell);
    changes.set(layer, cells);
  }
  for (const [layer, cells] of changes) {
    lines.push(
      `  换层格 @ ${cells.map(tuple).join("、")} → ${layerText(layer)}(踩上去就换,跟方向无关)`,
    );
  }

  const tiles = new Map<number, Cell>();
  for (const entity of items) {
    if (entity.kind !== "TileAnimRegion") continue;
    const cell = cellOf(list(entity.cell));
    if (cell !== null && typeof entity.id === "number") tiles.set(entity.id, cell);
  }
  const linked = new Set<number>();
  for (const entity of items) {
    if (entity.kind !== "OpenTrigger") continue;
    const cell = cellOf(list(entity.cell));
    if (cell === null) continue;
    const link = typeof entity.linkObjectId === "number" ? entity.linkObjectId : null;
    const door = link === null ? null : (tiles.get(link) ?? null);
    if (link !== null && door !== null) linked.add(link);
    const state = truthy(entity.isAlreadyHit) ? ",已经触发过" : "";
    const target = door === null ? "联动门未知" : `→ 门 ${tuple(door)}`;
    const script =
      typeof entity.script === "number" && entity.script !== 0 ? `,script ${entity.script}` : "";
    lines.push(
      `  开门触发器 @ ${tuple(cell)} ${target}` +
        `(走上去或顶到就会开,不用按确认${state}${script})`,
    );
  }
  for (const [id, cell] of tiles) {
    if (linked.has(id)) continue;
    const entity = items.find((item) => item.kind === "TileAnimRegion" && item.id === id);
    const playing = entity !== undefined && truthy(entity.isPlaying) ? ",正在播放" : "";
    const fallHere = items.some(
      (item) =>
        item.kind === "PointIn" &&
        (text(item.name) ?? "").includes("落下点") &&
        sameCell(cellOf(list(item.cell)) ?? [-1, -1], cell),
    );
    lines.push(
      `  动画格 @ ${tuple(cell)}(可能是洞口、传送带或门${playing}${fallHere ? ";与落下点同格" : ""})`,
    );
  }

  const fall = new Map<string, Cell>();
  const arrivals: Cell[] = [];
  for (const entity of items) {
    if (entity.kind !== "PointIn") continue;
    const cell = cellOf(list(entity.cell));
    if (cell === null) continue;
    const name = text(entity.name) ?? "";
    if (name.includes("落下点")) {
      fall.set(`${cell[0]},${cell[1]}`, cell);
    } else {
      arrivals.push(cell);
    }
  }
  const staticFalls = fallMoves(items);
  if (fall.size > 0) {
    const landed = [...moves, ...staticFalls].filter(
      (move) => move.kind === "fall" || move.how.includes("掉"),
    );
    const note = landed.length === 0 ? "从哪掉下来还不知道" : "洞口去向见下面";
    lines.push(`  落下点 @ ${[...fall.values()].map(tuple).join("、")}(${note})`);
  }
  for (const entity of items) {
    if (!isFallEntity(entity)) continue;
    const kind = text(entity.kind) ?? "未识别";
    const cells = fallCells(entity);
    if (cells.length === 0) continue;
    const link = typeof entity.linkObjectId === "number" ? entity.linkObjectId : null;
    const target = link === null ? null : (fallTarget(items, link) ?? null);
    const seconds =
      typeof entity.switchSeconds === "number"
        ? `,每 ${Math.round(entity.switchSeconds * 10) / 10} 秒切换`
        : "";
    const where = cells.map(tuple).join("、");
    const to = target === null ? "落点未知" : `→ 落下点 ${tuple(target)}`;
    lines.push(`  洞口/会塌地板 [${kind}] @ ${where} ${to}${seconds}`);
  }
  if (arrivals.length > 0) {
    lines.push(`  到达点 @ ${arrivals.map(tuple).join("、")}(从别的图进来时落在这些格子)`);
  }
  const known = describeMoves(moves);
  if (known !== "") lines.push(known);
  return lines.join("\n");
}

/** Python's str() for loose JSON, so a missing field reads "None", not "undefined". */
function tuple(cell: Cell): string {
  return `(${cell[0]}, ${cell[1]})`;
}

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
