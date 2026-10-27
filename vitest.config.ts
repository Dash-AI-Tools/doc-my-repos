import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStub = fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${srcDir}/` },
      // The marker package throws outside a React server environment; tests are server-side.
      { find: /^server-only$/, replacement: serverOnlyStub },
    ],
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.tsx",
      "tests/unit/**/*.test.ts",
      "tests/contract/**/*.test.ts",
    ],
    // Keeps the structured logger quiet; tests that check log output capture it at `debug`
    // (`captureOutput` in packages/server/src/test-logger.ts) or inject a recording logger.
    env: { LOG_LEVEL: "silent" },
  },
});
