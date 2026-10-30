import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The e2e stack (task 9.2): which servers run, on which ports, against which databases.
 *
 * | stack         | port | database                          | purpose                          |
 * | ------------- | ---- | --------------------------------- | -------------------------------- |
 * | `fixtures`    | 3100 | none                              | `/e2e/*` fixture pages (7.8, 8.x)|
 * | `seeded`      | 3101 | `docmyrepos_e2e_<id>_seeded`      | `SEED_REPOS` (seed-data.ts)      |
 * | `empty`       | 3102 | `docmyrepos_e2e_<id>_empty`       | migrated, no rows                |
 * | `unreachable` | 3103 | a port nothing listens on         | database error state             |
 * | `starred`     | 3104 | `docmyrepos_e2e_<id>_starred`     | `SEED_REPOS`, for specs that star|
 * | `comments`    | 3105 | `docmyrepos_e2e_<id>_comments`    | `SEED_REPOS` + users + comments  |
 * | `commentsoff` | 3106 | `docmyrepos_e2e_<id>_commentsoff` | same, `comments.enabled: false`  |
 * | `agent`       | 3109 | `docmyrepos_e2e_<id>_agent`       | users + a repo with guidelines   |
 * | `agentoff`    | 3110 | `docmyrepos_e2e_<id>_agentoff`    | same, `mcp.enabled: false`       |
 * | `folders`     | 3111 | `docmyrepos_e2e_<id>_folders`     | `SEED_REPOS`, for specs that use |
 * |               |      |                                   | folders (create, assign, star)   |
 * | `publicaccess`| 3113 | `docmyrepos_e2e_<id>_publicaccess`| `SEED_REPOS` + Ask data + two    |
 * |               |      |                                   | users with real passwords, and   |
 * |               |      |                                   | NO auth bypass: the real gate    |
 *
 * `playwright.config.ts` starts the servers and `global-setup.ts` creates and seeds the databases;
 * Playwright starts web servers BEFORE it runs the global setup, so nothing in a server needs its
 * database at startup: a server connects on the first request that reads data.
 *
 * Everything here is lazy and free of side effects at import time, except `workDir()` which
 * creates one temporary directory per run (key and config for the servers) the first time it is
 * called. The run id and the directory are kept in `process.env` so Playwright's worker processes,
 * which load the config again, agree with the main process.
 *
 * No real secret is ever used: the private key is generated here, the shared secrets are fixed
 * placeholders, and GitHub is never contacted (pages read Postgres only).
 */

export const STACKS = {
  fixtures: { port: 3100 },
  seeded: { port: 3101 },
  empty: { port: 3102 },
  unreachable: { port: 3103 },
  starred: { port: 3104 },
  comments: { port: 3105 },
  commentsoff: { port: 3106 },
  ask: { port: 3107 },
  settings: { port: 3108 },
  agent: { port: 3109 },
  agentoff: { port: 3110 },
  folders: { port: 3111 },
  publicaccess: { port: 3113 },
} as const;

/** The fake model provider the `ask` server talks to (see `e2e/support/fake-provider-server.ts`). */
export const FAKE_PROVIDER_PORT = 3190;
export const fakeProviderUrl = `http://127.0.0.1:${FAKE_PROVIDER_PORT}`;

/** The fake GitHub API the `settings` server talks to (see `e2e/support/fake-github-server.ts`). */
export const FAKE_GITHUB_PORT = 3191;
export const fakeGithubUrl = `http://127.0.0.1:${FAKE_GITHUB_PORT}`;

/**
 * The key that encrypts stored secrets on every e2e server: a fixed value, because the databases
 * are throwaway. It is a test value and protects nothing.
 */
export const E2E_ENCRYPTION_KEY = Buffer.from("docmyrepos-e2e-encryption-key-0123456789").toString(
  "base64",
);

/** Preloaded into the `settings` server so its GitHub calls reach the fake instead of github.com. */
const REDIRECT_GITHUB_MODULE = resolve(__dirname, "redirect-github.cjs");

export type StackName = keyof typeof STACKS;
export type DatabaseKind =
  | "seeded"
  | "empty"
  | "starred"
  | "comments"
  | "commentsoff"
  | "ask"
  | "settings"
  | "agent"
  | "agentoff"
  | "folders"
  | "publicaccess";

export function stackUrl(name: StackName): string {
  return `http://127.0.0.1:${STACKS[name].port}`;
}

/** `E2E_SKIP_DB=1`: no Postgres available; database-backed specs are skipped. */
export const SKIP_DB = process.env.E2E_SKIP_DB === "1";

export const SKIP_DB_REASON =
  "E2E_SKIP_DB=1: no Postgres for the seeded and empty-database e2e servers (unset it, and run `docker compose --env-file .env.example up -d --wait db`, to run these specs)";

/** Same credentials and port as `docker compose --env-file .env.example up -d db`. */
export const DEFAULT_ADMIN_URL = "postgres://docmyrepos:docmyrepos@127.0.0.1:5432/docmyrepos";

export const START_DB_COMMAND = "docker compose --env-file .env.example up -d --wait db";

/** The Postgres server the throwaway databases are created on. */
export function adminDatabaseUrl(): string {
  return process.env.DATABASE_URL_E2E?.trim() || DEFAULT_ADMIN_URL;
}

/** Random per run; shared with the workers through the environment. */
export function runId(): string {
  process.env.E2E_RUN_ID ||= randomBytes(4).toString("hex");
  return process.env.E2E_RUN_ID;
}

export function databaseName(kind: DatabaseKind): string {
  return `docmyrepos_e2e_${runId()}_${kind}`;
}

/** The admin URL with another database name. Throws a message without the URL when it is invalid. */
export function withDatabase(url: string, database: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL_E2E must be a postgres:// URL with a host.");
  }
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

export function databaseUrl(kind: DatabaseKind): string {
  return withDatabase(adminDatabaseUrl(), databaseName(kind));
}

/** Nothing listens on port 1 (tcpmux): connecting is refused at once. */
const UNREACHABLE_DATABASE_URL = "postgres://docmyrepos:docmyrepos@127.0.0.1:1/docmyrepos";

export interface WorkDir {
  readonly dir: string;
}

/**
 * The per-run temporary directory. Created on first use and reused by later calls and by worker
 * processes. Removed by `global-teardown.ts`. (Settings live in the databases now, so it holds no
 * key or config file.)
 */
export function workDir(): WorkDir {
  let dir = process.env.E2E_WORK_DIR;
  if (!dir || !existsSync(dir)) {
    dir = mkdtempSync(join(tmpdir(), "docmyrepos-e2e-"));
    process.env.E2E_WORK_DIR = dir;
  }
  return { dir };
}

/**
 * Environment of an app server. Every variable the server needs is set explicitly, so a developer's
 * own `.env` or shell never leaks in. GitHub, provider and sync-scope settings are not environment
 * any more: they are saved in each database (`e2e/support/settings-seed.ts`).
 *
 * `fixtures` is database-free like `unreachable`: the fixture pages read no data, and the layout
 * falls back to the default branding when the database is down. Both point at the dead port, so
 * no spec can see the branding (or anything else) of a developer's database.
 */
export function serverEnv(name: StackName): Record<string, string> {
  const readsDatabase =
    name === "seeded" ||
    name === "empty" ||
    name === "starred" ||
    name === "comments" ||
    name === "commentsoff" ||
    name === "ask" ||
    name === "settings" ||
    name === "agent" ||
    name === "agentoff" ||
    name === "folders" ||
    name === "publicaccess";
  return {
    ...(name === "fixtures" ? { E2E_FIXTURES: "1" } : {}),
    DATABASE_URL: readsDatabase ? databaseUrl(name) : UNREACHABLE_DATABASE_URL,
    SETTINGS_ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
    SYNC_SECRET: "e2e-sync-secret-not-a-real-secret",
    SESSION_SECRET: "e2e-session-secret-not-a-real-secret",
    // `publicaccess` has no bypass: its specs sign in with a real session (or send no cookie at all),
    // so the proxy and the page guards run exactly as in production.
    ...(name === "publicaccess" ? {} : { E2E_AUTH_BYPASS: "1" }),
    SYNC_SCHEDULER: "0",
    ...(name === "settings"
      ? {
          NODE_OPTIONS: `--require ${REDIRECT_GITHUB_MODULE}`,
          E2E_GITHUB_API_URL: fakeGithubUrl,
        }
      : {}),
  };
}
