import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { wrapClientModule } from "../scripts/bundle-client.mjs";

interface Loaded {
  readonly id: string;
  readonly factory: (require: (name: string) => unknown) => { readonly answer?: number };
}

void test("the browser bundle uses the module-loader envelope and keeps the package id", () => {
  const output = wrapClientModule("@local/ffpr-dsh", "exports.answer = 42;");
  assert.ok(output.includes("window.__ModuleLoader__.load"));
  assert.ok(output.includes('"@local/ffpr-dsh"'));
  assert.ok(output.includes("return module.exports"));
  let loaded: Loaded | undefined;
  const scope = {
    __ModuleLoader__: {
      load: (definition: Loaded) => {
        loaded = definition;
      },
    },
  };
  runInNewContext(output, { window: scope });
  assert.ok(loaded);
  assert.equal(loaded.id, "@local/ffpr-dsh");
  assert.equal(loaded.factory(() => ({})).answer, 42);
});
