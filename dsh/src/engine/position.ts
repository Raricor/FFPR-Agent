/**
 * One-line description of the player's position for the where_am_i tool. The bridge's pos reply
 * is external data, so parsing and rendering stay separate and both have tests.
 */

export interface Position {
  readonly map: number | null;
  readonly state: string | null;
  readonly cell: readonly [number, number] | null;
  readonly dir: string | null;
  readonly moving: boolean;
  readonly dialog: boolean;
  readonly battle: boolean;
  readonly saves: number | null;
}

const DIRECTIONS: Record<string, string> = {
  Up: "上",
  Down: "下",
  Left: "左",
  Right: "右",
};

/** Narrow the bridge's {"ok", "pos"} reply; failures carry a Chinese message for the model. */
export function parsePositionReply(reply: unknown): Position {
  if (!isRecord(reply)) throw new Error("查位置失败:桥插件的回复不是对象");
  if (reply.ok === false) {
    const reason = typeof reply.error === "string" ? reply.error : "桥插件没有说明原因";
    throw new Error(`查位置失败:${reason}`);
  }
  const pos = reply.pos;
  if (!isRecord(pos)) throw new Error("查位置失败:回复里没有 pos");
  return {
    map: numberOrNull(pos.map, "map"),
    state: stringOrNull(pos.state, "state"),
    cell: cellOrNull(pos.cell),
    dir: stringOrNull(pos.dir, "dir"),
    moving: pos.moving === true,
    dialog: pos.dialog === true,
    battle: pos.battle === true,
    saves: numberOrNull(pos.saves, "saves"),
  };
}

export function renderPosition(pos: Position): string {
  const parts = [
    `地图 ${pos.map ?? "?"}`,
    `格子 ${pos.cell ? `(${pos.cell[0]}, ${pos.cell[1]})` : "未知"}`,
    `状态 ${pos.state ?? "未知"}`,
  ];
  if (pos.dir) parts.push(`朝${DIRECTIONS[pos.dir] ?? pos.dir}`);
  if (pos.moving) parts.push("移动中");
  if (pos.dialog) parts.push("对话中");
  if (pos.battle) parts.push("战斗中");
  return parts.join(",");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`查位置失败:pos.${field} 不是数字`);
  }
  return value;
}

function stringOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`查位置失败:pos.${field} 不是字符串`);
  return value;
}

function cellOrNull(value: unknown): readonly [number, number] | null {
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    typeof value[1] !== "number"
  ) {
    throw new Error("查位置失败:pos.cell 不是 [x, y]");
  }
  return [value[0], value[1]];
}
