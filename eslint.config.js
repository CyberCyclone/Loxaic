// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * One root flat config for the whole pnpm/turbo monorepo, rather than a
 * per-package config mirroring @loxaic/config-ts's base/node/react split.
 * tsc needs a --project per package; ESLint 9's flat config doesn't — a
 * single file can apply different rules to different packages purely via
 * `files` globs, which is less to maintain than N near-identical configs.
 *
 * Type-aware linting (typescript-eslint's `projectService`) auto-discovers
 * the nearest tsconfig.json per file by walking up from it, so this needs
 * no per-package tsconfig wiring — it reuses whatever `tsconfig.json` each
 * package already has for `tsc --noEmit`. That also means only files each
 * package's own tsconfig `include`s can be type-aware linted; a handful of
 * root-level tooling configs (vitest.config.ts, drizzle.config.ts) sit
 * outside their package's `include` (["src"]) the same way they sit outside
 * `tsc --noEmit`'s coverage, and get a lighter, non-type-checked pass below.
 */

const TS_ROOT = import.meta.dirname;

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "apps/mobile/dist/**",
      "packages/db/drizzle/**", // generated migration SQL + snapshots, not hand-written source
      "apps/mobile/components/ui/**", // gluestack-ui's copy-paste output, not hand-authored app code
      "apps/e2e/artifacts/**", // screenshots + run state from local e2e runs
      "apps/e2e/fixtures/**", // a standalone app the real-model e2e suite seeds into a sandbox and has the agent build — not part of this repo's own project graph
    ],
  },

  // ── Strict, type-aware TypeScript: apps/server ─────────────
  {
    files: ["apps/server/src/**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: TS_ROOT },
      globals: globals.node,
    },
  },

  // ── Strict, type-aware TypeScript: shared packages ─────────
  {
    files: ["packages/*/src/**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: TS_ROOT },
      globals: globals.node,
    },
  },

  // ── Strict, type-aware TypeScript: mobile (+ hooks rules) ──
  {
    files: ["apps/mobile/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: TS_ROOT,
        ecmaFeatures: { jsx: true },
      },
      // RN has no DOM, but shares enough web-shaped globals (fetch, console,
      // timers) that `globals.browser` is a closer fit than `globals.node`;
      // __DEV__ is RN's own build-time global, not in either set.
      globals: { ...globals.browser, __DEV__: "readonly" },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A component created fresh per render (arrow prop, inline JSX) isn't
      // a hook-rules violation — this rule's false-positive rate on that
      // pattern is why even strict React setups keep it at warn, not error.
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // ── Strict, type-aware TypeScript: e2e suites ──────────────
  //    Its tsconfig includes the wdio configs and scripts as well
  //    as src, so everything here has a type-aware project and
  //    none of it needs the lighter tooling pass below.
  {
    files: ["apps/e2e/**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: TS_ROOT },
      globals: { ...globals.node, ...globals.mocha },
    },
  },

  // ── Destructuring a key off an object specifically to spread the
  //    rest (`const { kind: _kind, ...rest } = x`) is how this
  //    codebase omits a discriminant before forwarding the payload —
  //    the discarded binding isn't a mistake, so don't flag it. ──
  {
    files: [
      "apps/server/src/**/*.ts",
      "packages/*/src/**/*.ts",
      "apps/mobile/**/*.{ts,tsx}",
      "apps/e2e/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },

  // ── Lighter pass: config/tooling files outside any tsconfig's
  //    `include` — same reason they're outside `tsc --noEmit`'s
  //    coverage, so no type-aware project exists for them. ──────
  {
    files: ["apps/server/vitest.config.ts", "packages/db/drizzle.config.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },

  // ── Plain JS tooling configs (Metro/Babel) — CommonJS despite
  //    no .cjs extension; Metro loads them via require() regardless
  //    of the package's own "type" field. ──────────────────────
  {
    files: [
      "apps/mobile/app.config.js",
      "apps/mobile/babel.config.js",
      "apps/mobile/fingerprint.config.js",
      "apps/mobile/metro.config.js",
    ],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
  },

  // ── Desktop (Electron): plain JS/CJS, no TypeScript at all here
  //    (confirmed: no tsconfig.json in apps/desktop). ────────────
  {
    files: ["apps/desktop/src/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: "module", globals: globals.node },
  },
  {
    // Includes the packaging config at the app root, which is CommonJS
    // because electron-builder loads it with require().
    files: ["apps/desktop/src/**/*.cjs", "apps/desktop/*.cjs"],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
  },

  // ── This file itself. ──────────────────────────────────────
  {
    files: ["eslint.config.js"],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: "module", globals: globals.node },
  },
);
