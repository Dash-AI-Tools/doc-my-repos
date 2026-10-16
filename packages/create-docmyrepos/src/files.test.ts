import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { rename as realRename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type FsOps,
  InstallationExistsError,
  writeInstallation,
  WriteInterruptedError,
} from "./files.js";
import type { PlannedFile } from "./plan.js";

const posix = process.platform !== "win32";

const FILES: PlannedFile[] = [
  { path: "docker-compose.yml", content: "services: {}\n", mode: 0o644, secret: false },
  { path: ".env", content: "SYNC_SECRET='x'\n", mode: 0o600, secret: true },
  { path: "key.pem", content: "KEY\n", mode: 0o600, secret: true },
];

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docmyrepos-files-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

/** A file system whose Nth rename fails (sync variants stay real). */
async function realFs(): Promise<FsOps> {
  const fs = await import("node:fs/promises");
  const sync = await import("node:fs");
  return {
    mkdir: fs.mkdir,
    writeFile: fs.writeFile,
    chmod: fs.chmod,
    rename: fs.rename,
    rm: fs.rm,
    lstat: fs.lstat,
    renameSync: sync.renameSync,
    rmSync: sync.rmSync,
    lstatSync: sync.lstatSync,
  };
}

describe("writeInstallation", () => {
  it.skipIf(!posix)("creates the folder 0700 and files with their modes", async () => {
    const dir = join(root, "install");
    const result = await writeInstallation({ dir, files: FILES });
    expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(join(dir, ".env"))).toBe(0o600);
    expect(await modeOf(join(dir, "key.pem"))).toBe(0o600);
    expect(await modeOf(join(dir, "docker-compose.yml"))).toBe(0o644);
    expect(result.written).toHaveLength(3);
    expect(result.createdDir).toBe(true);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("SYNC_SECRET='x'\n");
    expect((await readdir(dir)).sort()).toEqual([".env", "docker-compose.yml", "key.pem"]);
  });

  it("uses an existing empty folder as is", async () => {
    const result = await writeInstallation({ dir: root, files: FILES });
    expect(result.createdDir).toBe(false);
    expect((await readdir(root)).length).toBe(3);
  });

  it.each([".env", "docker-compose.yml"])(
    "refuses when %s exists, changing nothing",
    async (name) => {
      await writeFile(join(root, name), "old");
      await expect(writeInstallation({ dir: root, files: FILES })).rejects.toBeInstanceOf(
        InstallationExistsError,
      );
      expect(await readdir(root)).toEqual([name]);
      expect(await readFile(join(root, name), "utf8")).toBe("old");
    },
  );

  it.skipIf(!posix)("force backs up with a timestamp and the same mode", async () => {
    await writeFile(join(root, ".env"), "OLD_SECRET", { mode: 0o600 });
    const result = await writeInstallation({
      dir: root,
      files: FILES,
      force: true,
      now: () => new Date("2026-10-15T12:34:56.789Z"),
    });
    const backup = join(root, ".env.bak-20261015T123456Z");
    expect(result.backups).toEqual([{ from: join(root, ".env"), to: backup }]);
    expect(await readFile(backup, "utf8")).toBe("OLD_SECRET");
    expect(await modeOf(backup)).toBe(0o600);
    expect(await readFile(join(root, ".env"), "utf8")).toBe("SYNC_SECRET='x'\n");
  });

  it("force never overwrites an earlier backup", async () => {
    await writeFile(join(root, ".env"), "ONE");
    const now = () => new Date("2026-10-15T12:34:56Z");
    await writeInstallation({ dir: root, files: FILES, force: true, now });
    await writeFile(join(root, ".env"), "TWO");
    await writeInstallation({ dir: root, files: FILES, force: true, now });
    expect(await readFile(join(root, ".env.bak-20261015T123456Z"), "utf8")).toBe("ONE");
    expect(await readFile(join(root, ".env.bak-20261015T123456Z-1"), "utf8")).toBe("TWO");
  });

  it("a failure mid-write leaves nothing partial and keeps the old install", async () => {
    await writeFile(join(root, ".env"), "OLD");
    let renames = 0;
    const fs = await realFs();
    fs.rename = (async (from: string, to: string) => {
      renames += 1;
      // 1 backup rename, then the second placement fails.
      if (renames === 3) throw new Error("disk exploded");
      return realRename(from, to);
    }) as FsOps["rename"];
    await expect(writeInstallation({ dir: root, files: FILES, force: true, fs })).rejects.toThrow(
      "disk exploded",
    );
    expect(await readdir(root)).toEqual([".env"]);
    expect(await readFile(join(root, ".env"), "utf8")).toBe("OLD");
  });

  it("a failure while staging leaves nothing in a new folder", async () => {
    const dir = join(root, "fresh");
    const fs = await realFs();
    let writes = 0;
    fs.writeFile = (async (...args: Parameters<FsOps["writeFile"]>) => {
      writes += 1;
      if (writes === 2) throw new Error("no space");
      return (await import("node:fs/promises")).writeFile(...args);
    }) as FsOps["writeFile"];
    await expect(writeInstallation({ dir, files: FILES, fs })).rejects.toThrow("no space");
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("an interrupt signal removes temp and placed files and reports it", async () => {
    await mkdir(join(root, "t"));
    const dir = join(root, "t");
    const fs = await realFs();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let renames = 0;
    fs.rename = (async (from: string, to: string) => {
      renames += 1;
      if (renames === 2) await gate; // pause with one file placed and one temp pending
      return realRename(from, to);
    }) as FsOps["rename"];

    const interrupts: string[] = [];
    const pending = writeInstallation({
      dir,
      files: FILES,
      fs,
      signals: ["SIGUSR2"],
      onInterrupt: (s) => interrupts.push(s),
    });
    const outcome = pending.then(
      () => "ok",
      (e: unknown) => e,
    );
    while (renames < 2) await new Promise((r) => setTimeout(r, 5));
    process.emit("SIGUSR2");
    expect(await readdir(dir)).toEqual([]); // cleaned synchronously by the handler
    release();
    expect(await outcome).toBeInstanceOf(WriteInterruptedError);
    expect(interrupts).toEqual(["SIGUSR2"]);
    expect(await readdir(dir)).toEqual([]);
    expect(process.listenerCount("SIGUSR2")).toBe(0);
  });

  it("removes its signal handlers after a normal run", async () => {
    const before = process.listenerCount("SIGINT");
    await writeInstallation({ dir: root, files: FILES });
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("rejects a path that is not a plain file name", async () => {
    await expect(
      writeInstallation({
        dir: root,
        files: [{ path: "../evil", content: "x", mode: 0o600, secret: true }],
      }),
    ).rejects.toThrow(/plain file name/);
  });
});
