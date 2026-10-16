import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ENV_FILE } from "./plan.js";

const BOOTSTRAP_LINE = /^\s*ADMIN_(?:EMAIL|PASSWORD)\s*=/;

/** The two lines the user removes by hand when the cleanup is declined. */
export const BOOTSTRAP_LINES = ["ADMIN_EMAIL", "ADMIN_PASSWORD"] as const;
export const RESTART_COMMAND = "docker compose up -d";

/**
 * Removes the `ADMIN_EMAIL` and `ADMIN_PASSWORD` lines from `.env`. The file is rewritten through
 * a temporary file with mode 0600 and renamed over the original, so it is never half written.
 * Returns how many lines were removed. File contents never appear in errors.
 */
export async function removeBootstrapCredentials(dir: string): Promise<number> {
  const target = join(dir, ENV_FILE);
  const text = await readFile(target, "utf8");
  const kept: string[] = [];
  let removed = 0;
  for (const line of text.split("\n")) {
    if (BOOTSTRAP_LINE.test(line)) removed += 1;
    else kept.push(line);
  }
  if (removed === 0) return 0;
  const temp = join(dir, `.tmp-${randomBytes(6).toString("hex")}-${ENV_FILE}`);
  try {
    await writeFile(temp, kept.join("\n"), { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return removed;
}
