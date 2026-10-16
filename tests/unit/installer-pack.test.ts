import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The pack test (install-wizard task 5.3, release-artifacts "Pack test"): what `npm publish`
 * would upload is the built files, the bin, the README and the license, and nothing else. The
 * installer is compiled into a throwaway copy of the package so the test needs no prior build and
 * does not touch `packages/create-docmyrepos/dist`; `npm pack --dry-run --json` then lists the
 * copy. Made-up trees prove that a stray map, test, environment file or key fails the check.
 */

const PACKAGE = fileURLToPath(new URL("../../packages/create-docmyrepos", import.meta.url));
const CHECK = fileURLToPath(new URL("../../scripts/check-pack.mjs", import.meta.url));
const { checkPackedFiles, checkManifest, checkPackage, packedPaths, REQUIRED_FILES } =
  (await import(pathToFileURL(CHECK).href)) as {
    checkPackedFiles: (paths: string[]) => string[];
    checkManifest: (manifest: Record<string, unknown>) => string[];
    checkPackage: (folder: string) => string[];
    packedPaths: (folder: string) => string[];
    REQUIRED_FILES: string[];
  };

const GOOD_MANIFEST = {
  name: "create-docmyrepos",
  version: "1.0.0",
  bin: { "create-docmyrepos": "bin/create-docmyrepos.js" },
  engines: { node: ">=20" },
  scripts: { build: "tsc" },
};

describe("checkPackedFiles", () => {
  const good = [...REQUIRED_FILES, "dist/args.js"];

  it("accepts the built files, the bin, the README, the license and the manifest", () => {
    expect(checkPackedFiles(good)).toEqual([]);
  });

  it.each([
    ["dist/run.js.map", "source map"],
    ["dist/run.test.js", "test"],
    ["dist/test-support-github.js", "test support"],
    [".env", "environment file"],
    ["bin/.env.local", "environment file"],
    ["dist/key.pem", "key"],
    ["github-app.private-key.pem", "key"],
    ["src/run.ts", "TypeScript"],
    ["dist/run.d.ts", "TypeScript"],
    ["node_modules/x/index.js", "dependency"],
  ])("rejects %s", (path, why) => {
    const problems = checkPackedFiles([...good, path]);
    expect(problems.join("\n")).toContain(path);
    expect(problems.join("\n").toLowerCase()).toContain(why.toLowerCase().split(" ")[0] as string);
  });

  it("rejects a file that is merely not on the list", () => {
    expect(checkPackedFiles([...good, "notes.txt"]).join("\n")).toContain(
      "not on the allowed list",
    );
    expect(checkPackedFiles([...good, "dist/sub/deep.js"]).join("\n")).toContain(
      "dist/sub/deep.js",
    );
  });

  it("reports a required file that is missing", () => {
    expect(checkPackedFiles(good.filter((p) => p !== "LICENSE")).join("\n")).toContain(
      "LICENSE: missing",
    );
    expect(checkPackedFiles(good.filter((p) => p !== "dist/run.js")).join("\n")).toContain(
      "dist/run.js: missing",
    );
  });
});

describe("checkManifest", () => {
  it("accepts the shape of the installer manifest", () => {
    expect(checkManifest(GOOD_MANIFEST)).toEqual([]);
    expect(checkManifest({ ...GOOD_MANIFEST, dependencies: {} })).toEqual([]);
  });

  it.each(["dependencies", "optionalDependencies", "peerDependencies"])("rejects %s", (field) => {
    expect(checkManifest({ ...GOOD_MANIFEST, [field]: { left: "1.0.0" } }).join("\n")).toContain(
      field,
    );
  });

  it("rejects bundled dependencies, install-time scripts, a missing engine, a missing bin and private", () => {
    expect(checkManifest({ ...GOOD_MANIFEST, bundleDependencies: ["x"] })).not.toEqual([]);
    expect(
      checkManifest({ ...GOOD_MANIFEST, scripts: { postinstall: "node x.js" } }).join("\n"),
    ).toContain("postinstall");
    expect(checkManifest({ ...GOOD_MANIFEST, engines: {} }).join("\n")).toContain("engines.node");
    expect(checkManifest({ ...GOOD_MANIFEST, bin: undefined }).join("\n")).toContain("bin");
    expect(checkManifest({ ...GOOD_MANIFEST, private: true }).join("\n")).toContain("private");
  });
});

describe("the installer package as npm would pack it", () => {
  const staged = mkdtempSync(join(tmpdir(), "docmyrepos-pack-"));
  afterAll(() => rmSync(staged, { recursive: true, force: true }));

  beforeAll(() => {
    for (const name of ["package.json", "README.md", "LICENSE", "bin"]) {
      cpSync(join(PACKAGE, name), join(staged, name), { recursive: true });
    }
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    execFileSync(
      process.execPath,
      [tsc, "-p", join(PACKAGE, "tsconfig.json"), "--outDir", join(staged, "dist")],
      { stdio: "pipe" },
    );
  }, 180_000);

  it("holds exactly the allowed files and passes every check", () => {
    expect(checkPackage(staged)).toEqual([]);
    const paths = packedPaths(staged);
    for (const required of REQUIRED_FILES) expect(paths).toContain(required);
    expect(paths.filter((p) => p.startsWith("dist/")).every((p) => p.endsWith(".js"))).toBe(true);
  }, 60_000);

  it("fails when a map, a test, an environment file or a key slips into a published folder", () => {
    const dirty = mkdtempSync(join(tmpdir(), "docmyrepos-pack-dirty-"));
    try {
      cpSync(staged, dirty, { recursive: true });
      writeFileSync(join(dirty, "dist", "run.js.map"), "{}");
      writeFileSync(join(dirty, "dist", "run.test.js"), "");
      writeFileSync(join(dirty, "dist", "key.pem"), "-----BEGIN PRIVATE KEY-----");
      writeFileSync(join(dirty, "bin", ".env"), "SECRET=1");
      const problems = checkPackage(dirty).join("\n");
      for (const path of ["dist/run.js.map", "dist/run.test.js", "dist/key.pem", "bin/.env"]) {
        expect(problems, path).toContain(path);
      }
    } finally {
      rmSync(dirty, { recursive: true, force: true });
    }
  }, 60_000);

  it("the repository manifest declares no dependencies and the Node version it needs", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(checkManifest(manifest)).toEqual([]);
    expect(manifest.dependencies).toBeUndefined();
    expect((manifest.engines as { node: string }).node).toBe(">=20");
    expect(manifest.files).toEqual(["dist", "bin", "README.md", "LICENSE"]);
  });
});
