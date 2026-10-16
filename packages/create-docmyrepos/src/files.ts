import { randomBytes } from "node:crypto";
import { lstatSync, renameSync, rmSync } from "node:fs";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { PlannedFile } from "./plan.js";

/** A file that marks an existing installation. */
export const INSTALL_MARKERS = [".env", "docker-compose.yml"] as const;

/** The file system calls the writer uses, injectable for tests. */
export interface FsOps {
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
  chmod: typeof chmod;
  rename: typeof rename;
  rm: typeof rm;
  lstat: typeof lstat;
  /** Synchronous variants, used by the interrupt handler. */
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  lstatSync: typeof lstatSync;
}

const realFs: FsOps = { mkdir, writeFile, chmod, rename, rm, lstat, renameSync, rmSync, lstatSync };

/** The folder already holds an installation and `--force` was not given. */
export class InstallationExistsError extends Error {
  readonly existing: readonly string[];
  constructor(existing: readonly string[]) {
    super(
      `The folder already contains an installation (${existing.join(", ")}). Nothing was changed. ` +
        "Use another folder, or pass --force to back the existing files up and replace them.",
    );
    this.name = "InstallationExistsError";
    this.existing = existing;
  }
}

/** The run was interrupted by a signal while writing; everything it wrote was removed. */
export class WriteInterruptedError extends Error {
  readonly signal: NodeJS.Signals;
  constructor(signal: NodeJS.Signals) {
    super(`Interrupted (${signal}) while writing files; no partial files were left.`);
    this.name = "WriteInterruptedError";
    this.signal = signal;
  }
}

export interface WriteOptions {
  /** Target folder. Created with mode 0700 when missing. */
  dir: string;
  files: readonly PlannedFile[];
  /** Back existing installation files up (timestamped) instead of refusing. */
  force?: boolean;
  now?: () => Date;
  fs?: FsOps;
  /**
   * Called after an interrupt signal was handled (files cleaned up). The default re-raises the
   * signal so the process ends as it would have. Tests pass their own.
   */
  onInterrupt?: (signal: NodeJS.Signals) => void;
  /** Signals to clean up on. */
  signals?: readonly NodeJS.Signals[];
}

export interface WriteResult {
  /** Absolute paths of the files written. */
  written: string[];
  /** Existing files that were moved aside by `force`. */
  backups: { from: string; to: string }[];
  createdDir: boolean;
}

function timestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function exists(fs: FsOps, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Writes the planned files atomically: each goes to a temporary name in the same folder with
 * mode 0600, then every file is renamed into place. Refuses (before touching anything) when `.env`
 * or the compose file exists, unless `force`, which first moves every file it is about to replace
 * to `<name>.bak-<timestamp>`. A failure or an interrupt removes the temporary files, the files
 * this run put in place, and restores the backups. File contents never appear in errors.
 */
export async function writeInstallation(options: WriteOptions): Promise<WriteResult> {
  const fs = options.fs ?? realFs;
  const now = options.now ?? (() => new Date());
  const { dir } = options;

  for (const file of options.files) {
    if (basename(file.path) !== file.path || file.path === "" || file.path.startsWith(".tmp-")) {
      throw new Error("A planned file path must be a plain file name.");
    }
  }

  const existingMarkers: string[] = [];
  for (const marker of INSTALL_MARKERS) {
    if (await exists(fs, join(dir, marker))) existingMarkers.push(marker);
  }
  if (existingMarkers.length > 0 && options.force !== true) {
    throw new InstallationExistsError(existingMarkers);
  }

  const result: WriteResult = { written: [], backups: [], createdDir: false };
  const temps = new Set<string>();
  const placed: string[] = [];
  let interrupted: NodeJS.Signals | null = null;

  /** Removes temp files and placed files, restores backups. Synchronous so a signal handler can use it. */
  const rollback = (): void => {
    for (const temp of temps) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Best effort: nothing more can be done.
      }
    }
    temps.clear();
    for (const path of placed.splice(0)) {
      try {
        fs.rmSync(path, { force: true });
      } catch {
        // Best effort.
      }
    }
    for (const backup of result.backups.splice(0)) {
      try {
        fs.renameSync(backup.to, backup.from);
      } catch {
        // Best effort.
      }
    }
    result.written = [];
    if (result.createdDir) {
      // The folder did not exist before this run, so everything in it is ours.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  };

  const signals = options.signals ?? ["SIGINT", "SIGTERM"];
  const removeListeners = (): void => {
    for (const [s, listener] of listeners) process.removeListener(s, listener);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    interrupted = signal;
    rollback();
    removeListeners();
    (options.onInterrupt ?? ((s: NodeJS.Signals) => process.kill(process.pid, s)))(signal);
  };
  const listeners = signals.map((s) => [s, () => onSignal(s)] as const);
  for (const [s, listener] of listeners) process.on(s, listener);
  const checkInterrupted = (): void => {
    if (interrupted !== null) throw new WriteInterruptedError(interrupted);
  };

  try {
    try {
      await fs.lstat(dir);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700);
      result.createdDir = true;
    }
    checkInterrupted();

    // 1. Stage every file under a temporary name.
    const staged: { file: PlannedFile; temp: string; final: string }[] = [];
    for (const file of options.files) {
      const temp = join(dir, `.tmp-${randomBytes(6).toString("hex")}-${file.path}`);
      const final = join(dir, file.path);
      temps.add(temp);
      await fs.writeFile(temp, file.content, { mode: 0o600, flag: "wx" });
      checkInterrupted();
      await fs.chmod(temp, file.mode);
      checkInterrupted();
      staged.push({ file, temp, final });
    }

    // 2. Move existing files aside (force only).
    const stamp = timestamp(now());
    for (const { final } of staged) {
      if (!(await exists(fs, final))) continue;
      let backup = `${final}.bak-${stamp}`;
      for (let n = 1; await exists(fs, backup); n += 1) backup = `${final}.bak-${stamp}-${n}`;
      await fs.rename(final, backup);
      result.backups.push({ from: final, to: backup });
      checkInterrupted();
    }

    // 3. Put the new files in place.
    for (const { temp, final } of staged) {
      await fs.rename(temp, final);
      temps.delete(temp);
      placed.push(final);
      checkInterrupted();
    }
    result.written = placed.slice();
    return result;
  } catch (error) {
    rollback();
    // An operation that was in flight when the signal arrived fails because its file is gone;
    // report the interrupt, not that side effect.
    if (interrupted !== null) throw new WriteInterruptedError(interrupted);
    throw error;
  } finally {
    removeListeners();
  }
}
