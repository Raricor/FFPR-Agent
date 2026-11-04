/**
 * Reading the loosely shaped JSON the bridge and the pilot agent send, with Python's semantics
 * where a faithful port depends on them. The Python code reads replies as `reply.get("x") or {}`;
 * an empty list or dict is falsy there but truthy in JavaScript, and round() and // differ too.
 * Use these instead of re-deriving the rules in each module.
 */

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python truthiness: None, False, 0, "", [] and {} are false. */
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** `value or {}` for a dict: the object itself, or an empty one for anything else. */
export function record(value: unknown): Json {
  return isRecord(value) ? value : {};
}

/** `value or []` for a list: the array itself, or an empty one for anything else. */
export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A list of dicts; entries that are not objects are left out. */
export function records(value: unknown): Json[] {
  return list(value).filter(isRecord);
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Python's round(): halves go to the even neighbour (round(2.5) == 2, round(0.125, 2) == 0.12). */
export function pyRound(value: number, digits = 0): number {
  const scale = 10 ** digits;
  const scaled = value * scale;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  // Compare with a tolerance: 0.125 * 100 is 12.500000000000002 in binary floating point.
  const EPSILON = 1e-9;
  let rounded: number;
  if (Math.abs(diff - 0.5) < EPSILON) rounded = floor % 2 === 0 ? floor : floor + 1;
  else rounded = Math.round(scaled);
  return rounded / scale;
}

/** Python's a // b (floors toward negative infinity). */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Python's a % b (takes the sign of b). */
export function floorMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}
