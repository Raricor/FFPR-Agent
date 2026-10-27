/**
 * Where things are on the dev box, ported from ffpr_agent/repo.py and ffpr_common/paths.py.
 * The plugin runs from the FFPR-Agent checkout: the bridge builds in bridge/, the laptop scripts
 * deploy from deploy/laptop, and fetched game files and run logs live in .deps/ (never committed).
 * Only the dev box (Linux) runs this; the Windows branches of paths.py are not needed here.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** src/engine/ and lib/engine/ both sit three levels below the checkout. */
export const REPO = resolve(import.meta.dirname, "..", "..", "..");
export const DEPS = join(REPO, ".deps");

/** $FFPR_CONFIG_DIR, else $XDG_CONFIG_HOME/ffpr-agent, else ~/.config/ffpr-agent. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FFPR_CONFIG_DIR;
  if (override) return override;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ffpr-agent");
}

/** $FFPR_SECRETS, else secrets.env in the config dir. */
export function secretsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.FFPR_SECRETS || join(configDir(env), "secrets.env");
}
