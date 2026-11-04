/**
 * Error helpers shared by the engine. Messages stay in Chinese; the details come from whatever
 * the file system, fetch, or the bridge threw.
 */

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
