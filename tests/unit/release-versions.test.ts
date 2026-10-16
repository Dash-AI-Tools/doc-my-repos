import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

/**
 * The release gate (install-wizard task 5.2): the tag, the root package version and the installer
 * version must be one number. The script is plain Node so the release workflow can run it before
 * anything is installed; its pure function and its command line are both tested here.
 */

const SCRIPT = fileURLToPath(new URL("../../scripts/check-release-versions.mjs", import.meta.url));

interface Result {
  ok: boolean;
  version: string | null;
  npmTag: string;
  errors: string[];
}
const { checkVersions } = (await import(pathToFileURL(SCRIPT).href)) as {
  checkVersions: (input: {
    tag: string | undefined;
    rootVersion: unknown;
    packageVersion: unknown;
  }) => Result;
};

describe("checkVersions", () => {
  it("passes when the tag and both versions are equal", () => {
    const result = checkVersions({ tag: "v1.2.0", rootVersion: "1.2.0", packageVersion: "1.2.0" });
    expect(result).toEqual({ ok: true, version: "1.2.0", npmTag: "latest", errors: [] });
  });

  it("publishes a pre-release under the next tag, not latest", () => {
    const result = checkVersions({
      tag: "v1.3.0-rc.1",
      rootVersion: "1.3.0-rc.1",
      packageVersion: "1.3.0-rc.1",
    });
    expect(result.ok).toBe(true);
    expect(result.npmTag).toBe("next");
  });

  it("fails when the installer version differs from the tag", () => {
    const result = checkVersions({ tag: "v1.2.0", rootVersion: "1.2.0", packageVersion: "1.1.0" });
    expect(result.ok).toBe(false);
    expect(result.version).toBeNull();
    expect(result.errors.join("\n")).toContain("packages/create-docmyrepos/package.json is 1.1.0");
  });

  it("fails when the root version differs from the tag", () => {
    const result = checkVersions({ tag: "v1.2.0", rootVersion: "1.1.9", packageVersion: "1.2.0" });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("root package.json is 1.1.9");
  });

  it("fails and says so when the two packages differ from each other", () => {
    const result = checkVersions({ tag: "v2.0.0", rootVersion: "1.0.0", packageVersion: "1.0.1" });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("differ");
  });

  it.each(["1.2.0", "v1.2", "vx.y.z", "v01", "release-1.2.0", "", "v1.2.0 "])(
    "refuses the tag %j",
    (tag) => {
      const result = checkVersions({ tag, rootVersion: "1.2.0", packageVersion: "1.2.0" });
      expect(result.ok).toBe(false);
    },
  );

  it("refuses a missing tag and versions that are not versions", () => {
    expect(
      checkVersions({ tag: undefined, rootVersion: "1.0.0", packageVersion: "1.0.0" }).ok,
    ).toBe(false);
    expect(
      checkVersions({ tag: "v1.0.0", rootVersion: undefined, packageVersion: "1.0.0" }).ok,
    ).toBe(false);
    expect(
      checkVersions({ tag: "v1.0.0", rootVersion: "1.0.0", packageVersion: "latest" }).ok,
    ).toBe(false);
  });
});

describe("check-release-versions.mjs command line", () => {
  const folders: string[] = [];
  afterAll(() => {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  });

  function project(rootVersion: string, packageVersion: string): string {
    const folder = mkdtempSync(join(tmpdir(), "docmyrepos-release-"));
    folders.push(folder);
    mkdirSync(join(folder, "packages", "create-docmyrepos"), { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({ version: rootVersion }));
    writeFileSync(
      join(folder, "packages", "create-docmyrepos", "package.json"),
      JSON.stringify({ version: packageVersion }),
    );
    return folder;
  }

  /** The caller's environment without the variables the script reads, so CI cannot leak into a case. */
  function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = { ...process.env };
    delete base.GITHUB_OUTPUT;
    delete base.GITHUB_REF_NAME;
    return { ...base, ...extra };
  }

  function run(args: string[], env: Record<string, string> = {}) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: cleanEnv(env),
    });
    return { code: result.status, out: result.stdout, err: result.stderr };
  }

  it("exits 0 and writes the version and npm tag to GITHUB_OUTPUT when all agree", () => {
    const folder = project("1.2.0", "1.2.0");
    const output = join(folder, "github-output");
    const result = run(["v1.2.0", "--root", folder], { GITHUB_OUTPUT: output });
    expect(result.code).toBe(0);
    expect(result.out).toContain("Release 1.2.0");
    expect(readFileSync(output, "utf8")).toBe("version=1.2.0\nnpm_tag=latest\n");
  });

  it("reads the tag from GITHUB_REF_NAME when no argument is given", () => {
    const folder = project("0.4.1", "0.4.1");
    const result = run(["--root", folder], { GITHUB_REF_NAME: "v0.4.1" });
    expect(result.code).toBe(0);
  });

  it("exits 1 and lists every mismatch when they differ, writing no output", () => {
    const folder = project("1.2.0", "1.1.0");
    const output = join(folder, "github-output");
    const result = run(["v1.3.0", "--root", folder], { GITHUB_OUTPUT: output });
    expect(result.code).toBe(1);
    expect(result.err).toContain("root package.json is 1.2.0 but the tag is v1.3.0");
    expect(result.err).toContain("packages/create-docmyrepos/package.json is 1.1.0");
    expect(() => readFileSync(output, "utf8")).toThrow();
  });

  it("exits 1 for a tag that is not a version and for a missing tag", () => {
    const folder = project("1.2.0", "1.2.0");
    expect(run(["latest", "--root", folder]).code).toBe(1);
    expect(run(["--root", folder]).code).toBe(1);
  });

  it("exits 1 when a package.json cannot be read", () => {
    const folder = mkdtempSync(join(tmpdir(), "docmyrepos-release-"));
    folders.push(folder);
    expect(run(["v1.0.0", "--root", folder]).code).toBe(1);
  });

  it("agrees with the repository as it is: root and installer versions are equal", () => {
    const rootVersion = (
      JSON.parse(
        readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
      ) as {
        version: string;
      }
    ).version;
    const result = run([`v${rootVersion}`]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
  });
});
