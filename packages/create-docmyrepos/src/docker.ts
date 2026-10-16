import { spawn } from "node:child_process";
import { createServer } from "node:net";

import { redactCredentials } from "./credentials.js";

export interface RunOptions {
  readonly cwd?: string;
  /** Extra environment for the child. Secrets go here, never into `args`. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface RunResult {
  /** Exit code, or `null` when the process was killed or could not start. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Set when the program could not be started, for example `ENOENT`. */
  readonly spawnError?: string;
}

/** Runs a program with an argument array and no shell. Tests inject a fake. */
export type Runner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

const MAX_CAPTURE = 1024 * 1024;

const keepTail = (text: string): string =>
  text.length > MAX_CAPTURE ? text.slice(text.length - MAX_CAPTURE) : text;

export const spawnRunner: Runner = (command, args, options = {}) =>
  new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout = keepTail(stdout + d);
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr = keepTail(stderr + d);
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish({ code: null, stdout, stderr, timedOut, spawnError: error.code ?? "ERROR" }),
    );
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
  });

export const DOCKER_INSTALL_URL = "https://docs.docker.com/get-docker/";
export const COMPOSE_INSTALL_URL = "https://docs.docker.com/compose/install/";
/** Compose releases from this one accept `--wait-timeout`; older v2 releases get the polling path. */
export const COMPOSE_WAIT_TIMEOUT_MIN = [2, 18, 0] as const;
export const DEFAULT_WAIT_SECONDS = 180;
export const LOG_TAIL_LINES = 30;
const CHECK_TIMEOUT_MS = 20_000;

export interface Problem {
  readonly check: "docker" | "compose" | "daemon" | "port";
  readonly message: string;
  readonly fix: string;
}

export type CheckResult<T = undefined> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: Problem };

export function parseVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < minimum.length; i += 1) {
    const a = version[i] ?? 0;
    const b = minimum[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export async function checkDocker(run: Runner): Promise<CheckResult> {
  const result = await run("docker", ["--version"], { timeoutMs: CHECK_TIMEOUT_MS });
  if (result.spawnError !== undefined || result.code !== 0) {
    return {
      ok: false,
      problem: {
        check: "docker",
        message: "Docker is not installed or is not on your PATH.",
        fix: `Install Docker and run this again: ${DOCKER_INSTALL_URL}`,
      },
    };
  }
  return { ok: true, value: undefined };
}

export interface ComposeInfo {
  readonly version: string;
  /** Whether `up --wait --wait-timeout` can be used. */
  readonly waitSupported: boolean;
}

export async function checkCompose(run: Runner): Promise<CheckResult<ComposeInfo>> {
  const result = await run("docker", ["compose", "version", "--short"], {
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  const version = parseVersion(result.stdout);
  if (result.spawnError !== undefined || result.code !== 0 || version === null) {
    return {
      ok: false,
      problem: {
        check: "compose",
        message: "Docker Compose v2 (the `docker compose` command) is missing.",
        fix: `Install the Compose plugin: ${COMPOSE_INSTALL_URL}`,
      },
    };
  }
  if (version[0] < 2) {
    return {
      ok: false,
      problem: {
        check: "compose",
        message: `Docker Compose ${version.join(".")} is too old; version 2 or newer is required.`,
        fix: `Upgrade to Compose v2: ${COMPOSE_INSTALL_URL}`,
      },
    };
  }
  return {
    ok: true,
    value: {
      version: version.join("."),
      waitSupported: atLeast(version, COMPOSE_WAIT_TIMEOUT_MIN),
    },
  };
}

export async function checkDaemon(run: Runner): Promise<CheckResult> {
  const result = await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  if (result.timedOut) {
    return {
      ok: false,
      problem: {
        check: "daemon",
        message: "The Docker daemon did not answer in time.",
        fix: "Restart Docker (Docker Desktop, or `sudo systemctl restart docker`) and try again.",
      },
    };
  }
  if (result.spawnError !== undefined || result.code !== 0) {
    return {
      ok: false,
      problem: {
        check: "daemon",
        message: "Docker is installed but the Docker daemon is not running or not reachable.",
        fix: "Start Docker (open Docker Desktop, or `sudo systemctl start docker`) and try again.",
      },
    };
  }
  return { ok: true, value: undefined };
}

/** Tries to listen on the port on loopback (the only place the compose file publishes it). */
export function checkPortFree(port: number, host = "127.0.0.1"): Promise<CheckResult> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () =>
      resolve({
        ok: false,
        problem: {
          check: "port",
          message: `Port ${port} is already in use on this machine.`,
          fix: "Choose another port, or stop the program that is using it.",
        },
      }),
    );
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve({ ok: true, value: undefined }));
    });
  });
}

export interface Preflight {
  readonly problems: readonly Problem[];
  readonly compose?: ComposeInfo;
}

/**
 * Cheapest first: Docker, Compose, daemon (the later Docker checks are skipped once Docker itself
 * is missing), then the port. Reports every problem found, so the user fixes them in one go.
 */
export async function preflight(
  run: Runner,
  port: number,
  portCheck: (port: number) => Promise<CheckResult> = checkPortFree,
): Promise<Preflight> {
  const problems: Problem[] = [];
  let compose: ComposeInfo | undefined;
  const docker = await checkDocker(run);
  if (!docker.ok) {
    problems.push(docker.problem);
  } else {
    const c = await checkCompose(run);
    if (c.ok) compose = c.value;
    else problems.push(c.problem);
    const d = await checkDaemon(run);
    if (!d.ok) problems.push(d.problem);
  }
  const p = await portCheck(port);
  if (!p.ok) problems.push(p.problem);
  return compose === undefined ? { problems } : { problems, compose };
}

export interface StepOutcome {
  readonly ok: boolean;
  /** Which step failed, for the summary. */
  readonly step: string;
  readonly message?: string;
  readonly logTail?: string;
}

const failure = (step: string, message: string, logTail?: string): StepOutcome =>
  logTail === undefined ? { ok: false, step, message } : { ok: false, step, message, logTail };

export async function composeLogTail(
  run: Runner,
  dir: string,
  lines: number = LOG_TAIL_LINES,
): Promise<string> {
  const result = await run(
    "docker",
    ["compose", "logs", "--no-color", "--tail", String(lines), "app"],
    { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS },
  );
  const text = (result.stdout + result.stderr).trimEnd();
  const tail = text.split("\n").slice(-lines).join("\n");
  return redactCredentials(tail);
}

export const MORE_LOGS_COMMAND = "docker compose logs app";

export async function composePull(run: Runner, dir: string): Promise<StepOutcome> {
  const result = await run("docker", ["compose", "pull"], { cwd: dir, timeoutMs: 15 * 60_000 });
  if (result.code === 0) return { ok: true, step: "pull" };
  return failure(
    "pull",
    result.timedOut
      ? "Pulling the image took too long. Check your connection and run `docker compose pull` again."
      : "Docker could not pull the image. Check your connection and the image tag, then run `docker compose pull`.",
  );
}

export interface FetchLike {
  (url: string, init?: { signal?: AbortSignal }): Promise<{ status: number }>;
}

export interface PollOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Polls `http://127.0.0.1:<port>/api/health` until it answers 200 or the time is up. */
export async function pollHealth(port: number, options: PollOptions = {}): Promise<boolean> {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? DEFAULT_WAIT_SECONDS * 1000);
  const interval = options.intervalMs ?? 2000;
  for (;;) {
    try {
      const response = await doFetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 200) return true;
    } catch {
      // not up yet
    }
    if (now() + interval > deadline) return false;
    await sleep(interval);
  }
}

export interface StartOptions {
  readonly port: number;
  readonly waitSupported: boolean;
  readonly waitSeconds?: number;
  readonly poll?: PollOptions;
}

/**
 * `docker compose up -d --wait`, or `up -d` followed by health polling when `--wait` is not
 * available. On failure the outcome carries the last log lines.
 */
export async function composeUp(
  run: Runner,
  dir: string,
  options: StartOptions,
): Promise<StepOutcome> {
  const seconds = options.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  const timeoutMessage = `The app did not become healthy within ${seconds} seconds.`;

  const viaPolling = async (): Promise<StepOutcome> => {
    const up = await run("docker", ["compose", "up", "-d"], {
      cwd: dir,
      timeoutMs: (seconds + 60) * 1000,
    });
    if (up.code !== 0) {
      return failure(
        "start",
        "Docker Compose could not start the containers.",
        await composeLogTail(run, dir),
      );
    }
    const healthy = await pollHealth(options.port, { timeoutMs: seconds * 1000, ...options.poll });
    if (healthy) return { ok: true, step: "start" };
    return failure("health check", timeoutMessage, await composeLogTail(run, dir));
  };

  if (!options.waitSupported) return viaPolling();

  const result = await run(
    "docker",
    ["compose", "up", "-d", "--wait", "--wait-timeout", String(seconds)],
    { cwd: dir, timeoutMs: (seconds + 60) * 1000 },
  );
  if (result.code === 0) return { ok: true, step: "start" };
  if (!result.timedOut && /unknown (?:shorthand )?flag/i.test(result.stderr)) return viaPolling();
  const message = result.timedOut
    ? timeoutMessage
    : "The containers did not start or did not become healthy.";
  return failure(
    result.timedOut ? "health check" : "start",
    message,
    await composeLogTail(run, dir),
  );
}
