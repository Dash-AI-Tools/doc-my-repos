import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/check-release-versions.sh keeps the tag, package.json, install.sh, package versions,
 * the compose default image tag and the CHANGELOG section in step.
 */

const SCRIPT = fileURLToPath(new URL("../../scripts/check-release-versions.sh", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function writeFixture(
  root: string,
  options: {
    package?: string;
    installer?: string;
    composeTag?: string;
    changelogVersion?: string | null;
    packages?: Record<string, string>;
  },
) {
  const version = options.package ?? "1.2.3";
  const installer = options.installer ?? "1.2.3";
  const composeTag = options.composeTag ?? version;
  writeFileSync(
    join(root, "package.json"),
    `{\n  "name": "x",\n  "version": "${version}",\n  "private": true\n}\n`,
  );
  writeFileSync(join(root, "install.sh"), `#!/bin/sh\nDOCMYREPOS_VERSION="${installer}"\n`);
  writeFileSync(
    join(root, "docker-compose.yml"),
    `services:\n  app:\n    image: \${DOCMYREPOS_IMAGE:-ghcr.io/dash-ai-tools/doc-my-repos:${composeTag}}\n    build: .\n`,
  );
  if (options.changelogVersion !== null) {
    const section = options.changelogVersion ?? version;
    writeFileSync(
      join(root, "CHANGELOG.md"),
      `# Changelog\n\n## [${section}] - 2026-01-01\n\n- something\n`,
    );
  }
  for (const [name, pkgVersion] of Object.entries(options.packages ?? {})) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(
      join(root, "packages", name, "package.json"),
      `{\n  "name": "@docmyrepos/${name}",\n  "version": "${pkgVersion}",\n  "type": "module"\n}\n`,
    );
  }
}

function check(options: {
  tag?: string;
  package?: string;
  installer?: string;
  composeTag?: string;
  changelogVersion?: string | null;
  packages?: Record<string, string>;
  root?: string;
}) {
  let root = options.root;
  if (!root) {
    root = mkdtempSync(join(tmpdir(), "dmr-versions-"));
    roots.push(root);
    writeFixture(root, options);
  }
  const result = spawnSync("sh", [SCRIPT, ...(options.tag ? [options.tag] : [])], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CHECK_ROOT: root, NODE_ENV: "test" },
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("check-release-versions.sh", () => {
  it("checks every package under packages/ against the app's version", () => {
    expect(check({ tag: "v1.2.3", packages: { core: "1.2.3", server: "1.2.3" } }).status).toBe(0);
    const r = check({ tag: "v1.2.3", packages: { core: "1.2.3", server: "1.2.4" } });
    expect(r.status).toBe(1);
    expect(r.err).toContain("packages/server/package.json='1.2.4'");
  });

  it("passes when the tag, package.json and install.sh agree", () => {
    const r = check({ tag: "v1.2.3" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("versions match: 1.2.3");
  });

  it("passes without a tag when package.json and install.sh agree", () => {
    expect(check({}).status).toBe(0);
  });

  it("fails when the compose default image tag differs", () => {
    const r = check({ tag: "v1.2.3", composeTag: "9.9.9" });
    expect(r.status).toBe(1);
    expect(r.err).toContain("docker-compose.yml image tag='9.9.9'");
  });

  it("fails when CHANGELOG.md has no section for the version", () => {
    const r = check({ tag: "v1.2.3", changelogVersion: "9.9.9" });
    expect(r.status).toBe(1);
    expect(r.err).toContain("CHANGELOG.md");
  });

  it("fails when CHANGELOG.md is missing", () => {
    const r = check({ tag: "v1.2.3", changelogVersion: null });
    expect(r.status).toBe(1);
    expect(r.err).toContain("CHANGELOG.md is missing");
  });

  it.each([
    ["the tag differs", { tag: "v1.2.4" }],
    ["package.json differs", { tag: "v1.2.3", package: "1.2.4" }],
    ["install.sh differs", { tag: "v1.2.3", installer: "1.2.4" }],
    ["package.json and install.sh differ without a tag", { package: "1.2.4" }],
  ])("fails when %s and names every version", (_name, options) => {
    const r = check(options);
    expect(r.status).toBe(1);
    expect(r.err).toContain("versions differ");
    expect(r.err).toContain("package.json=");
    expect(r.err).toContain("install.sh=");
  });

  it.each([
    ["a tag without v", { tag: "1.2.3" }],
    ["a pre-release tag", { tag: "v1.2.3-rc.1" }],
    ["a non-version installer value", { installer: "latest" }],
  ])("rejects %s", (_name, options) => {
    expect(check(options).status).toBe(1);
  });

  it("agrees with this repository today", () => {
    expect(check({ root: REPO }).status).toBe(0);
  });
});
