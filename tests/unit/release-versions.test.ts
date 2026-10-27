import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/** scripts/check-release-versions.sh keeps the tag, package.json and install.sh in step. */

const SCRIPT = fileURLToPath(new URL("../../scripts/check-release-versions.sh", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function check(options: {
  tag?: string;
  package?: string;
  installer?: string;
  packages?: Record<string, string>;
  root?: string;
}) {
  let root = options.root;
  if (!root) {
    root = mkdtempSync(join(tmpdir(), "dmr-versions-"));
    roots.push(root);
    writeFileSync(
      join(root, "package.json"),
      `{\n  "name": "x",\n  "version": "${options.package ?? "1.2.3"}",\n  "private": true\n}\n`,
    );
    writeFileSync(
      join(root, "install.sh"),
      `#!/bin/sh\nDOCMYREPOS_VERSION="${options.installer ?? "1.2.3"}"\n`,
    );
    for (const [name, version] of Object.entries(options.packages ?? {})) {
      mkdirSync(join(root, "packages", name), { recursive: true });
      writeFileSync(
        join(root, "packages", name, "package.json"),
        `{\n  "name": "@docmyrepos/${name}",\n  "version": "${version}",\n  "type": "module"\n}\n`,
      );
    }
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
