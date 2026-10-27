// Links node_modules/@deepseek-ai to the installed dsh's own packages, so the types we compile
// against and the modules we load in tests are the ones dsh runs. dsh resolves its shipped
// packages from its installation at runtime too; a copy from npm could drift from it.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const bin = execFileSync("sh", ["-c", "command -v dsh"], { encoding: "utf8" }).trim();
// <prefix>/@deepseek-ai/dsh/lib/bin.js → <prefix>/@deepseek-ai/dsh/node_modules/@deepseek-ai
const packages = join(dirname(dirname(realpathSync(bin))), "node_modules", "@deepseek-ai");
if (!existsSync(join(packages, "dsh-tools"))) {
  throw new Error(`no dsh packages under ${packages}`);
}
const link = join(import.meta.dirname, "..", "node_modules", "@deepseek-ai");
mkdirSync(dirname(link), { recursive: true });
if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
  rmSync(link, { recursive: true, force: true });
}
symlinkSync(packages, link, "dir");
console.log(`node_modules/@deepseek-ai → ${packages}`);
