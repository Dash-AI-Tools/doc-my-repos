import { spawn, type SpawnOptions } from "node:child_process";

/** Opens an address in the user's browser. Resolves `false` when it could not be launched. */
export type OpenBrowser = (url: string) => Promise<boolean>;

/** The slice of a child process the opener uses; tests provide a fake. */
export interface OpenerChild {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}
export type OpenerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => OpenerChild;

/**
 * Only two fixed shapes are ever opened, so no argument can carry a command: the loopback start
 * address and the GitHub App install page.
 */
const START_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/start\?t=[A-Za-z0-9_-]+$/;
const INSTALL_URL = /^https:\/\/github\.com\/apps\/[A-Za-z0-9-]{1,100}\/installations\/new$/;

export function openerCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (!START_URL.test(url) && !INSTALL_URL.test(url))
    throw new Error("Refusing to open an unexpected address.");
  if (platform === "darwin") return { command: "open", args: [url] };
  // `start` is a cmd.exe builtin; the empty string is its window title argument.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export function createBrowserOpener(
  platform: NodeJS.Platform = process.platform,
  spawnFn: OpenerSpawn = spawn as OpenerSpawn,
): OpenBrowser {
  return (url) =>
    new Promise<boolean>((resolve) => {
      let command: { command: string; args: string[] };
      try {
        command = openerCommand(platform, url);
      } catch {
        resolve(false);
        return;
      }
      try {
        const child = spawnFn(command.command, command.args, {
          shell: false,
          stdio: "ignore",
          detached: true,
          windowsHide: true,
        });
        child.once("error", () => resolve(false));
        child.once("spawn", () => {
          child.unref();
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
}

export const openInBrowser: OpenBrowser = (url) => createBrowserOpener()(url);
