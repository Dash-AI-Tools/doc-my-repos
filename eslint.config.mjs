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
    "packages/*/dist/**",
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
  prettier,
]);
