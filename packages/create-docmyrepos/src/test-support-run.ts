/**
 * Harness for end-to-end tests of `run`: a temporary folder, a fake GitHub server, a fake Docker
 * runner and scripted terminal input. Test support only: excluded from the build and the package.
 */
import { createPublicKey } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunDeps } from "./run.js";
import type { RunResult, Runner } from "./docker.js";
import type { PromptIo } from "./prompts.js";
import { rsaPem } from "./test-support.js";
import { startFakeGithub, type FakeGithub } from "./test-support-github.js";

export interface Captured {
  stdout: string;
  stderr: string;
}

export interface RunnerCall {
  command: string;
  args: readonly string[];
  cwd: string | undefined;
}

export type RunnerHandler = (call: RunnerCall) => Partial<RunResult> | undefined;

export interface Harness {
  readonly root: string;
  /** The default target folder (`<root>/install`). */
  readonly target: string;
  readonly github: FakeGithub;
  readonly pem: string;
  readonly keyFile: string;
  readonly captured: Captured;
  readonly calls: RunnerCall[];
  /** Requests the wizard made to the local app (`/api/sync`). */
  readonly syncRequests: { url: string; authorization: string | null; method: string }[];
  readonly opened: string[];
  readonly abort: AbortController;
  readonly lines: string[];
  readonly secrets: string[];
  readonly handler: { current: RunnerHandler | undefined };
  /** Everything printed, both streams. */
  all(): string;
  deps(
    argv: readonly string[],
    extra?: Partial<RunDeps> & { interactive?: boolean; env?: Record<string, string> },
  ): RunDeps;
  readEnvValue(name: string): Promise<string>;
  close(): Promise<void>;
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });

/** Default fake Docker: everything succeeds. */
function defaultRunner(args: readonly string[]): RunResult {
  if (args[0] === "--version") return ok("Docker version 27.0.0");
  if (args[0] === "compose" && args[1] === "version") return ok("2.29.1\n");
  if (args[0] === "info") return ok("27.0.0");
  return ok();
}

export async function createHarness(
  options: { installations?: { id: number; login: string }[]; repositories?: string[] } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "docmyrepos-wizard-"));
  const pem = rsaPem("pkcs1");
  const publicKeyPem = createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();
  const github = await startFakeGithub({
    publicKeyPem,
    manifestResult: { pem, webhook_secret: "fake-webhook-secret-0123456789" },
    installations: options.installations ?? [],
    repositories: options.repositories ?? ["handbook", "api", "web"],
  });
  const keyFile = join(root, "app-key.pem");
  await writeFile(keyFile, pem, { mode: 0o600 });

  const captured: Captured = { stdout: "", stderr: "" };
  const calls: RunnerCall[] = [];
  const syncRequests: Harness["syncRequests"] = [];
  const opened: string[] = [];
  const abort = new AbortController();
  const lines: string[] = [];
  const secrets: string[] = [];
  const handler: Harness["handler"] = { current: undefined };

  const runner: Runner = async (command, args, runOptions) => {
    const call: RunnerCall = { command, args: [...args], cwd: runOptions?.cwd };
    calls.push(call);
    const custom = handler.current?.(call);
    if (custom !== undefined) {
      return { code: 0, stdout: "", stderr: "", timedOut: false, ...custom };
    }
    return defaultRunner(args);
  };

  const target = join(root, "install");

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/sync")) {
      const headers = new Headers(init?.headers);
      syncRequests.push({
        url,
        authorization: headers.get("authorization"),
        method: init?.method ?? "GET",
      });
      return new Response("{}", { status: 202 });
    }
    return fetch(input, init);
  };

  /**
   * A browser that plays GitHub: opening the loopback start page submits the manifest and returns
   * the browser to the callback; opening the install page installs the App on `acme`.
   */
  const openBrowser = async (url: string): Promise<boolean> => {
    opened.push(url);
    if (url.startsWith("http://127.0.0.1")) {
      void (async () => {
        const html = await (await fetch(url)).text();
        const state = /state=([A-Za-z0-9_%-]+)/.exec(html)?.[1];
        const origin = new URL(url).origin;
        await fetch(`${origin}/callback?code=good-code&state=${state ?? ""}`);
      })().catch(() => undefined);
      return true;
    }
    if (url.includes("/installations/new")) {
      if (!github.state.installations.some((i) => i.login === "acme")) {
        github.state.installations.push({ id: 777, login: "acme" });
      }
      return true;
    }
    return false;
  };

  const harness: Harness = {
    root,
    target,
    github,
    pem,
    keyFile,
    captured,
    calls,
    syncRequests,
    opened,
    abort,
    lines,
    secrets,
    handler,
    all: () => captured.stdout + captured.stderr,
    deps(argv, extra = {}) {
      const { interactive = true, env = {}, ...rest } = extra;
      const io: PromptIo = {
        interactive,
        write: (text) => void (captured.stdout += text),
        readLine: async (prompt) => {
          captured.stdout += prompt;
          return lines.shift() ?? null;
        },
        readSecret: async (prompt) => {
          captured.stdout += prompt;
          return secrets.shift() ?? null;
        },
      };
      return {
        argv,
        env: { DOCMYREPOS_GITHUB_API_URL: github.url, ...env },
        cwd: root,
        io,
        stdout: (text) => void (captured.stdout += text),
        stderr: (text) => void (captured.stderr += text),
        runner,
        fetch: fakeFetch,
        openBrowser,
        signal: abort.signal,
        version: "0.1.0",
        nodeVersion: "22.0.0",
        host: { platform: "linux", uid: 1000 },
        portCheck: async () => ({ ok: true, value: undefined }),
        sleep: async () => undefined,
        timing: {
          callbackTimeoutMs: 5000,
          installationTimeoutMs: 200,
          installationIntervalMs: 1,
        },
        ...rest,
      };
    },
    async readEnvValue(name) {
      const text = await readFile(join(target, ".env"), "utf8");
      const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
      if (line === undefined) throw new Error(`no ${name} in .env`);
      return line.slice(name.length + 1).replace(/^'|'$/g, "");
    },
    async close() {
      await github.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return harness;
}

export const EXISTING_ENV = (h: Harness): Record<string, string> => ({
  DOCMYREPOS_ADMIN_PASSWORD: "correct-horse-battery",
  DOCMYREPOS_APP_ID: String(h.github.state.appId),
  DOCMYREPOS_APP_KEY_FILE: h.keyFile,
  DOCMYREPOS_WEBHOOK_SECRET: "existing-webhook-secret-0123456789",
});

export const BASE_FLAGS = (h: Harness): string[] => [
  "--yes",
  "--dir",
  h.target,
  "--org",
  "acme",
  "--admin-email",
  "admin@acme.io",
  "--app",
  "existing",
];
