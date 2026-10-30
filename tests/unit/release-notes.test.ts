import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/** scripts/release-notes.sh cuts the CHANGELOG section used as the GitHub Release body. */

const SCRIPT = fileURLToPath(new URL("../../scripts/release-notes.sh", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function notes(changelog: string, version: string, options: { output?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dmr-notes-"));
  roots.push(root);
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  const outPath = options.output ? join(root, "out.md") : undefined;
  const args = [SCRIPT, version, ...(outPath ? ["--output", outPath] : [])];
  const result = spawnSync("sh", args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CHECK_ROOT: root, NODE_ENV: "test" },
  });
  return {
    status: result.status,
    out: result.stdout,
    err: result.stderr,
    file: outPath && result.status === 0 ? readFileSync(outPath, "utf8") : undefined,
  };
}

describe("release-notes.sh", () => {
  const sample = `# Changelog

## [0.2.0] - 2026-11-01

### Added

- newer thing

## [0.1.0] - 2026-10-29

### Added

- first thing

## [0.0.1] - 2026-01-01

- seed
`;

  it("writes the matching section and a link to the full changelog", () => {
    const r = notes(sample, "0.1.0");
    expect(r.status).toBe(0);
    expect(r.out).toContain("# [0.1.0] - 2026-10-29");
    expect(r.out).toContain("- first thing");
    expect(r.out).not.toContain("newer thing");
    expect(r.out).not.toContain("seed");
    expect(r.out).toContain(
      "https://github.com/Dash-AI-Tools/doc-my-repos/blob/v0.1.0/CHANGELOG.md",
    );
  });

  it("can write to a file instead of stdout", () => {
    const r = notes(sample, "0.2.0", { output: true });
    expect(r.status).toBe(0);
    expect(r.out).toBe("");
    expect(r.file).toContain("# [0.2.0] - 2026-11-01");
    expect(r.file).toContain("- newer thing");
  });

  it("fails when the section is missing", () => {
    const r = notes(sample, "9.9.9");
    expect(r.status).toBe(1);
    expect(r.err).toContain("CHANGELOG.md");
  });

  it("extracts the current repository version", () => {
    const version = (
      JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }
    ).version;
    const result = spawnSync("sh", [SCRIPT, version], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CHECK_ROOT: REPO, NODE_ENV: "test" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(version);
  });
});
