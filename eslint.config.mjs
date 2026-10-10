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
    "build/**",
    "node_modules/**",
    "next-env.d.ts",
    "openspec/**",
    ".claude/**",
  ]),
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  prettier,
]);
