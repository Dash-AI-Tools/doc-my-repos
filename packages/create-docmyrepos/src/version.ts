import { readFileSync } from "node:fs";

/** The installer's own version, read from the package manifest next to `dist/` (or `src/`). */
export function packageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  ) {
    return manifest.version;
  }
  throw new Error("package.json has no version");
}
