// Lint rules that keep the plugin safe inside the dsh process (see CLAUDE.md): every promise
// awaited, no blocking calls in src/, and the engine kept free of dsh imports.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const BLOCKING = [
  { name: "node:child_process", importNames: ["execSync", "execFileSync", "spawnSync"] },
  {
    name: "node:fs",
    importNames: ["readFileSync", "writeFileSync", "appendFileSync", "existsSync", "statSync"],
    message: "src/ runs inside dsh: use node:fs/promises.",
  },
];

export default defineConfig(
  { ignores: ["build/", "lib/", "node_modules/"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // `a || b` on strings and numbers is the faithful port of Python's `a or b` ("" and 0
      // fall back too); `??` stays required for objects.
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true, number: true, boolean: true } },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: { "no-restricted-imports": ["error", { paths: BLOCKING }] },
  },
  {
    files: ["src/client/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "./tsconfig.client.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: Object.fromEntries(
        [
          "AbortController",
          "document",
          "exports",
          "fetch",
          "localStorage",
          "require",
          "window",
        ].map((name) => [name, "readonly"]),
      ),
    },
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["*"], message: "src/client has no imports; use require/ctx." }] },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "ImportDeclaration", message: "src/client has no imports." },
        { selector: "ExportAllDeclaration", message: "src/client only assigns exports." },
        { selector: "ExportDefaultDeclaration", message: "src/client only assigns exports." },
        { selector: "ExportNamedDeclaration", message: "src/client only assigns exports." },
      ],
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["src/engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: BLOCKING,
          patterns: [{ group: ["@deepseek-ai/*"], message: "The engine never imports dsh." }],
        },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: Object.fromEntries(
        ["Buffer", "clearTimeout", "console", "fetch", "process", "setTimeout", "URL"].map(
          (name) => [name, "readonly"],
        ),
      ),
    },
  },
);
