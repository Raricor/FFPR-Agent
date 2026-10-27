/**
 * Wrap the compiled browser panel in dsh's module-loader envelope (task 14). The function is
 * exported so the test can execute the same wrapper without writing files.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function indent(code, spaces) {
  const prefix = " ".repeat(spaces);
  return code
    .split("\n")
    .map((line) => (line === "" ? "" : prefix + line))
    .join("\n");
}

/** The exact browser envelope inspector uses: register a factory, not run the module yet. */
export function wrapClientModule(id, code) {
  return (
    "window.__ModuleLoader__.load({\n" +
    `  id: ${JSON.stringify(id)},\n` +
    "  factory: (require) => {\n" +
    "    var module = { exports: {} };\n" +
    "    var exports = module.exports;\n" +
    `${indent(code.trimEnd(), 4)}\n` +
    "    return module.exports;\n" +
    "  },\n" +
    "});\n"
  );
}

/** Read build/client/index.js, wrap it, and write lib/client.js. */
export async function bundleClient() {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const code = await readFile(join(ROOT, "build", "client", "index.js"), "utf8");
  const output = wrapClientModule(packageJson.name, code);
  await mkdir(join(ROOT, "lib"), { recursive: true });
  await writeFile(join(ROOT, "lib", "client.js"), output, "utf8");
  return { id: packageJson.name, output };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await bundleClient();
  console.log(`wrote lib/client.js for ${result.id}`);
}
