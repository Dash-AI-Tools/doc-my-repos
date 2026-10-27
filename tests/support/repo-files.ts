import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locations for tests that read the repository's own files (architecture guards, style audits,
 * dogfood checks). The source lives in the app (`src/`) and in the workspace packages, so a guard
 * that should cover "all source" walks every root below.
 */

/** The repository root. */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Every source root, relative to the repository root. */
export const SOURCE_ROOTS = [
  "src",
  "packages/core/src",
  "packages/server/src",
  "packages/ui/src",
] as const;

/** Every file under `dir` (absolute), depth first. */
export function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** Every file under every source root, as repository-relative POSIX paths. */
export function sourceFiles(): string[] {
  return SOURCE_ROOTS.flatMap((root) => walkFiles(join(REPO_ROOT, root))).map((file) =>
    relative(REPO_ROOT, file).split("\\").join("/"),
  );
}
