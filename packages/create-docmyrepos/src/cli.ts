import { spawnRunner } from "./docker.js";
import { openInBrowser } from "./browser.js";
import { EXIT } from "./output.js";
import { createTerminalIo } from "./prompts.js";
import { run } from "./run.js";
import { packageVersion } from "./version.js";

/** The part of `process` the signal wiring needs. */
export interface SignalSource {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  removeListener(event: NodeJS.Signals, listener: () => void): unknown;
}

/**
 * Turns SIGINT and SIGTERM into an abort. Everything that holds a resource (the callback server,
 * the file writer) listens to the abort signal and cleans up, so the wizard ends with exit code
 * 130 and no stray files. A second signal ends the process at once.
 */
export function watchSignals(source: SignalSource = process): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onSignal = (): void => {
    if (controller.signal.aborted) process.exit(EXIT.INTERRUPT);
    controller.abort();
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const name of signals) source.on(name, onSignal);
  return {
    signal: controller.signal,
    dispose: () => {
      for (const name of signals) source.removeListener(name, onSignal);
    },
  };
}

/** The real entry: wires the terminal, Docker, the network and the signals to `run`. */
export async function main(argv: readonly string[]): Promise<number> {
  const terminal = createTerminalIo();
  const { signal, dispose } = watchSignals();
  try {
    return await run({
      argv,
      env: process.env,
      cwd: process.cwd(),
      io: terminal,
      stdout: (text) => void process.stdout.write(text),
      stderr: (text) => void process.stderr.write(text),
      runner: spawnRunner,
      fetch: globalThis.fetch,
      openBrowser: openInBrowser,
      signal,
      version: packageVersion(),
      nodeVersion: process.versions.node,
    });
  } finally {
    dispose();
    terminal.close();
  }
}
