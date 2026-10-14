import { rmSync } from "node:fs";

import { dropDatabase } from "./db";

/**
 * Playwright global teardown (task 9.2): drops the throwaway databases (with FORCE, so the app
 * servers' open connections do not block it) and removes the temporary key and config directory.
 * Never throws: a cleanup problem is reported but must not fail a run whose tests passed.
 */
export default async function globalTeardown(): Promise<void> {
  // `global-setup.ts` records each database it creates; nothing is recorded under E2E_SKIP_DB=1.
  const created = (process.env.E2E_DATABASES_CREATED ?? "").split(",").filter(Boolean);
  for (const name of created) {
    try {
      await dropDatabase(name);
    } catch {
      console.warn(`[e2e] could not drop the throwaway database ${name}`);
    }
  }
  delete process.env.E2E_DATABASES_CREATED;
  const dir = process.env.E2E_WORK_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
}
