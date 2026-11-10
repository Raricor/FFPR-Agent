/**
 * Game text puts icon tags in front of item and spell names ("<IC_WMGC>治疗", "<IC_BAG>眼药").
 * The tags name a menu icon, not the thing: model-facing text and the activity log must not
 * carry them, and two names are only the same after the tags are gone (11-10: tool results
 * still said 用了「<IC_WMGC>治疗」 and 买了「<IC_BMGC>冰冻」).
 *
 * Match only the game's <IC_...> markers. A looser /<[^>]+>/ would eat a rule condition such
 * as "self.hp < 50 and self.mp > 3".
 */

const ICON_TAG = /<IC_[A-Z0-9_]+>/g;

/** Every icon tag removed; the rest of the text is left exactly as written. */
export function cleanIconTags(value: string): string {
  return value.replace(ICON_TAG, "");
}

/** A menu or bag name without icon tags and surrounding spaces; "" for a non-string. */
export function cleanName(value: unknown): string {
  return typeof value === "string" ? cleanIconTags(value).trim() : "";
}
