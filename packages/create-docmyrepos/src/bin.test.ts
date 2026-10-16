import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { FLAGS } from "./args.js";
import { watchSignals, type SignalSource } from "./cli.js";
import { packageVersion } from "./version.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const bin = join(packageDir, "bin", "create-docmyrepos.js");
const built = existsSync(join(packageDir, "dist", "index.js"));
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docmyrepos-bin-"));
  dirs.push(dir);
  return dir;
}

describe("bin entry", () => {
  it("is plain JavaScript with a shebang, executable, and imports nothing before the check", () => {
    const source = readFileSync(bin, "utf8");
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
    // No static import or require anywhere: only a dynamic import after the version check.
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/require\(/);
    expect(source.indexOf("process.exit(1)")).toBeLessThan(source.indexOf("await import("));
    if (process.platform !== "win32") expect(statSync(bin).mode & 0o111).not.toBe(0);
  });

  it("is declared in the package bin field and files allowlist", () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      bin: Record<string, string>;
      files: string[];
      dependencies?: unknown;
    };
    expect(manifest.bin).toEqual({ "create-docmyrepos": "bin/create-docmyrepos.js" });
    expect([...manifest.files].sort()).toEqual(["LICENSE", "README.md", "bin", "dist"]);
    expect(manifest.dependencies).toBeUndefined();
  });

  it("refuses Node 18 without side effects", async () => {
    const dir = await scratch();
    const work = join(dir, "cwd");
    await import("node:fs/promises").then((fs) => fs.mkdir(work));
    const preload = join(dir, "node18.cjs");
    // Makes the script see an old Node, as it would on one. Nothing else changes.
    await writeFile(
      preload,
      'Object.defineProperty(process.versions, "node", { value: "18.19.0" });\n',
    );
    const result = spawnSync(process.execPath, ["--require", preload, bin, "--org", "x"], {
      cwd: work,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("needs Node.js 20 or newer");
    expect(result.stderr).toContain("18.19.0");
    expect(result.stderr).toContain("Nothing was changed");
    // It stopped before loading the installer (which may not even be built) and wrote nothing.
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find/);
    expect(await readdir(work)).toEqual([]);
  });

  it.skipIf(!built)("prints help listing every flag, and the version", () => {
    const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    for (const flag of FLAGS) expect(help.stdout).toContain(`--${flag.name}`);
    const version = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
    expect(version.status).toBe(0);
    expect(version.stdout).toBe(`${packageVersion()}\n`);
  });

  it.skipIf(!built)("exits 2 for an unknown option and 2 without a terminal or --yes", async () => {
    const cwd = await scratch();
    const unknown = spawnSync(process.execPath, [bin, "--nope"], { encoding: "utf8", cwd });
    expect(unknown.status).toBe(2);
    const piped = spawnSync(process.execPath, [bin], { encoding: "utf8", cwd, input: "" });
    expect(piped.status).toBe(2);
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe("signal handling", () => {
  function fakeSource(): SignalSource & {
    listeners: Map<string, () => void>;
    emit: (s: string) => void;
  } {
    const listeners = new Map<string, () => void>();
    return {
      listeners,
      on: (event, listener) => void listeners.set(event, listener),
      removeListener: (event) => void listeners.delete(event),
      emit: (event) => listeners.get(event)?.(),
    };
  }

  it("aborts the signal on SIGINT and on SIGTERM, and removes its listeners on dispose", () => {
    for (const name of ["SIGINT", "SIGTERM"]) {
      const source = fakeSource();
      const { signal, dispose } = watchSignals(source);
      expect(signal.aborted).toBe(false);
      source.emit(name);
      expect(signal.aborted).toBe(true);
      dispose();
      expect(source.listeners.size).toBe(0);
    }
  });
});
