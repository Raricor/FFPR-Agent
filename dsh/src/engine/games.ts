/**
 * The six Pixel Remaster titles on Steam, ported from ffpr_common/games.py. Achievement counts
 * are what the bridge and the achievement tools use to tell how much of a game is done.
 */

export interface Game {
  readonly key: string;
  readonly appId: number;
  readonly title: string;
  /** Checked against Steam's public achievement list on 2026-10-19. */
  readonly achievementCount: number;
  readonly label: string;
}

function game(key: string, appId: number, title: string, achievementCount: number): Game {
  return { key, appId, title, achievementCount, label: key.toUpperCase() };
}

export const GAMES: readonly Game[] = [
  game("ff1", 1173770, "FINAL FANTASY", 24),
  game("ff2", 1173780, "FINAL FANTASY II", 28),
  game("ff3", 1173790, "FINAL FANTASY III", 31),
  game("ff4", 1173800, "FINAL FANTASY IV", 30),
  game("ff5", 1173810, "FINAL FANTASY V", 39),
  game("ff6", 1173820, "FINAL FANTASY VI", 37),
];

export const TOTAL_ACHIEVEMENTS = GAMES.reduce((total, item) => total + item.achievementCount, 0);

/** The Chinese name the sidebar and total-control card show. */
const TITLES: Readonly<Record<string, string>> = {
  ff1: "最终幻想",
  ff2: "最终幻想II",
  ff3: "最终幻想III",
  ff4: "最终幻想IV",
  ff5: "最终幻想V",
  ff6: "最终幻想VI",
};

export function titleOf(key: string): string {
  return TITLES[key] ?? byKey(key).title;
}

/** "FF5 · 最终幻想V", the one heading every game-scoped panel uses. */
export function gameHeading(key: string): string {
  const game = byKey(key);
  return `${game.label} · ${titleOf(game.key)}`;
}

export class UnknownGame extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownGame";
  }
}

export function byKey(key: string): Game {
  const wanted = key.toLowerCase();
  for (const item of GAMES) {
    if (item.key === wanted) return item;
  }
  const known = GAMES.map((item) => item.key).join(", ");
  throw new UnknownGame(`未知的作品 ${pythonRepr(key)},可选:${known}`);
}

export function byAppId(appId: number): Game {
  for (const item of GAMES) {
    if (item.appId === appId) return item;
  }
  throw new UnknownGame(`未知的 App ID ${appId}`);
}

/** Python's repr for a string, so the unknown-key message is byte-for-byte the Python one. */
function pythonRepr(value: string): string {
  let quoted = "'";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") quoted += "\\\\";
    else if (char === "'") quoted += "\\'";
    else if (char === "\n") quoted += "\\n";
    else if (char === "\r") quoted += "\\r";
    else if (char === "\t") quoted += "\\t";
    else if (code < 0x20 || code === 0x7f) quoted += `\\x${code.toString(16).padStart(2, "0")}`;
    else quoted += char;
  }
  return `${quoted}'`;
}
