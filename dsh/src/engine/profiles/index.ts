/**
 * The per-game profile registry (task 20). `profileFor` is the only way the pages learn which
 * achievement list, one-time places and area goals belong to the game in the bridge's hello.
 */

import { byKey, UnknownGame } from "../games.ts";
import { FF1_PROFILE } from "./ff1.ts";
import { FF2_PROFILE } from "./ff2.ts";
import { FF3_PROFILE } from "./ff3.ts";
import { FF4_PROFILE } from "./ff4.ts";
import { FF5_PROFILE } from "./ff5.ts";
import { FF6_PROFILE } from "./ff6.ts";
import type { GameProfile } from "./types.ts";

const PROFILES: readonly GameProfile[] = [
  FF1_PROFILE,
  FF2_PROFILE,
  FF3_PROFILE,
  FF4_PROFILE,
  FF5_PROFILE,
  FF6_PROFILE,
];

/** The profile of one game key; an unknown key says so in Chinese, as games.ts does. */
export function profileFor(key: string): GameProfile {
  const game = byKey(key);
  const profile = PROFILES.find((item) => item.key === game.key);
  if (profile === undefined) throw new UnknownGame(`没有 ${game.label} 的作品资料`);
  return profile;
}
