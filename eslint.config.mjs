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

export default defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "dist/**",
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
  // Server code logs through the structured logger (`src/server/log.ts`), which redacts
  // credentials; a stray console call would bypass that. Tests, test support and the logger
  // itself may use the console. Client components report through error boundaries instead.
  {
    files: ["src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    ignores: [
      "src/server/log.ts",
      "src/**/*.test.{ts,tsx}",
      "src/server/db/test-db.ts",
      "src/server/test-logger.ts",
    ],
    rules: {
      "no-console": "error",
    },
  },
  // Architecture rules from CLAUDE.md. Components never touch the database, and server modules stay
  // free of React except `cache`, which memoizes a read per request.
  {
    files: ["src/components/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/db", "@/server/db/*", "**/server/db", "**/server/db/*"],
              message: "Components do not access the database; read through src/server.",
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
    files: ["src/server/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              allowImportNames: ["cache"],
              message: "src/server stays free of React; only `cache` is allowed.",
            },
            { name: "react-dom", message: "src/server stays free of React." },
          ],
        },
      ],
    },
  },
  prettier,
]);
