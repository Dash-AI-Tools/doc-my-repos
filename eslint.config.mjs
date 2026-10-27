// Toolchain pins to revisit on upgrades:
// - `typescript` is held at ^6 in package.json. typescript-eslint 8.x declares the peer
//   range `>=4.8.4 <6.1.0` and cannot load on TypeScript 7. Move back to ^7 once
//   typescript-eslint supports it, then re-run `pnpm install && pnpm lint`.
// - ESLint is on 10. Some plugins bundled by eslint-config-next declare peers only up to
//   ESLint 9; lint rules from them still apply, but re-check on upgrades.
import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

// The code lives in the workspace packages (`packages/core`, `packages/server`, `packages/ui`).
// The old `@/server`, `@/lib` and `@/components` paths are gone; the app imports the packages. Every
// `no-restricted-imports` entry below repeats this pattern, because a later entry for the same
// rule replaces an earlier one instead of adding to it.
const LEGACY_LAYER_PATHS = {
  group: ["@/server", "@/server/*", "@/lib", "@/lib/*", "@/components", "@/components/*"],
  message: "Import from the packages: @docmyrepos/core, @docmyrepos/server or @docmyrepos/ui.",
};

export default defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "dist/**",
    "**/dist/**",
    "build/**",
    "node_modules/**",
    "next-env.d.ts",
    "openspec/**",
    ".claude/**",
    "drizzle/**",
    "playwright-report/**",
    "test-results/**",
  ]),
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [LEGACY_LAYER_PATHS] }],
    },
  },
  // Server code logs through the structured logger (`packages/server/src/log.ts`), which redacts
  // credentials; a stray console call would bypass that. Tests, test support and the logger
  // itself may use the console. Client components report through error boundaries instead.
  {
    files: [
      "src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "packages/*/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
    ],
    ignores: [
      "packages/server/src/log.ts",
      "**/*.test.{ts,tsx}",
      "packages/server/src/db/test-db.ts",
      "packages/server/src/test-logger.ts",
    ],
    rules: {
      "no-console": "error",
    },
  },
  // Architecture rules from CLAUDE.md. Components never touch the database, and server modules stay
  // free of React except `cache`, which memoizes a read per request.
  {
    files: ["packages/ui/src/components/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            LEGACY_LAYER_PATHS,
            {
              group: [
                "@docmyrepos/server/internal/db",
                "@docmyrepos/server/internal/db/*",
                "**/server/db",
                "**/server/db/*",
              ],
              message: "Components do not access the database; read through the server package.",
            },
          ],
          paths: [
            { name: "drizzle-orm", message: "Components do not access the database." },
            { name: "pg", message: "Components do not access the database." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/server/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [LEGACY_LAYER_PATHS],
          paths: [
            {
              name: "react",
              allowImportNames: ["cache"],
              message: "The server package stays free of React; only `cache` is allowed.",
            },
            { name: "react-dom", message: "The server package stays free of React." },
          ],
        },
      ],
    },
  },
  // The UI package's page bodies are App Router files that the app's route files re-export, so the
  // App Router rules apply to them (the root layout and global error page render `<head>`).
  {
    files: ["packages/ui/src/pages/**/*.tsx"],
    rules: {
      "@next/next/no-head-element": "off",
    },
  },
  prettier,
]);
