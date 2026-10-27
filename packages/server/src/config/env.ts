import { createPrivateKey } from "node:crypto";

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { LOG_THRESHOLDS, parseLogLevel } from "../log";
import { MIN_SECRET_LENGTH, Secret } from "./secret";

/** Environment variables as read from `process.env` (or a test double). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Validated settings from the environment. Every secret is wrapped so it cannot leak by accident. */
export interface EnvConfig {
  readonly databaseUrl: Secret<string>;
  readonly syncSecret: Secret<string>;
  readonly sessionSecret: Secret<string>;
  /** Bootstrap admin (first-login creation when `users` is empty). Null when unset. */
  readonly adminEmail: string | null;
  readonly adminPassword: Secret<string> | null;
}

/** Treats unset, empty and whitespace-only values the same; trims the rest. */
function blankToUndefined(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Messages are fixed strings: never interpolate the value, which may be a secret.
const requiredString = () => z.preprocess(blankToUndefined, z.string({ error: "is not set" }));

// A shared secret: trimmed like every value, then at least MIN_SECRET_LENGTH characters. The message
// is fixed and never includes the value.
// `.env.example` ships `replace-with-...` placeholders that are long enough to pass the length check
// and are public, so a deployment that forgot to change one would be guarded by a known secret
// (forgeable webhooks, open /api/sync). They are rejected by name; the message never echoes the value.
const PLACEHOLDER_SECRET = /^replace-with-/i;

const sharedSecret = () =>
  requiredString().pipe(
    z
      .string()
      .min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters`)
      .refine(
        (value) => !PLACEHOLDER_SECRET.test(value),
        "is still the placeholder from .env.example; generate your own (for example `openssl rand -hex 32`)",
      ),
  );

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    // The URL error carries the input; drop it.
    return null;
  }
}

/** Credentials followed directly by the path: `scheme://user:pw@/db`, an empty host. */
const CREDENTIALS_WITHOUT_HOST = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@)\//;

function isPostgresUrl(value: string): boolean {
  let url = parseUrl(value);
  let hostless = false;
  if (url === null && CREDENTIALS_WITHOUT_HOST.test(value)) {
    // node-postgres accepts `postgres://user:pw@/db?host=/cloudsql/...` (the usual Cloud SQL
    // socket form) although WHATWG URL rejects credentials without a host. Parse it with a
    // placeholder host, as node-postgres does, and treat the host as empty.
    url = parseUrl(value.replace(CREDENTIALS_WITHOUT_HOST, "$1placeholder.invalid/"));
    hostless = true;
  }
  if (url === null) return false;
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return false;
  const hostname = hostless ? "" : url.hostname;
  return hostname !== "" || (url.searchParams.get("host") ?? "") !== "";
}

export const DATABASE_URL_VAR = "DATABASE_URL";

const databaseUrlSchema = requiredString().refine(
  isPostgresUrl,
  "must be a postgres:// or postgresql:// URL with a host",
);

// Optional. The logger itself falls back to `info` on an unknown value; startup rejects it so a
// typo is noticed. The message lists the accepted words, never the value.
const logLevel = () =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .refine((v) => parseLogLevel(v) !== null, `must be one of ${LOG_THRESHOLDS.join(", ")}`)
      .optional(),
  );

const envSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
  LOG_LEVEL: logLevel(),
  SYNC_SECRET: sharedSecret(),
  SESSION_SECRET: sharedSecret(),
  ADMIN_EMAIL: z
    .preprocess(blankToUndefined, z.string().email("must be a valid email").optional())
    .optional(),
  ADMIN_PASSWORD: z
    .preprocess(blankToUndefined, z.string().min(12, "must be at least 12 characters").optional())
    .optional(),
});

/**
 * The sync secret from `env`, validated like `parseEnv` does (trimmed, not blank, long enough),
 * or `null` when it is unusable. Lets `POST /api/sync` authenticate before it loads the rest of
 * the configuration or touches the database. Never throws and never reports the value.
 */
export function readSyncSecret(env: EnvSource): Secret<string> | null {
  const parsed = envSchema.shape.SYNC_SECRET.safeParse(env.SYNC_SECRET, { reportInput: false });
  return parsed.success ? new Secret(parsed.data) : null;
}

const PEM_PATTERN =
  /^-----BEGIN ([A-Z0-9 ]+)-----\r?\n([A-Za-z0-9+/=\r\n:, -]+?)\r?\n-----END \1-----$/;
const ACCEPTED_LABELS = new Set(["RSA PRIVATE KEY", "PRIVATE KEY"]);

/**
 * Checks that `pem` is an unencrypted RSA private key (GitHub App keys are RSA) and returns a
 * problem description, or `null` when it is usable. Descriptions never include any part of the key.
 * Also used by the GitHub token provider to fail fast on a key that did not come through `parseEnv`.
 */
export function pemProblem(pem: string): string | null {
  const match = PEM_PATTERN.exec(pem);
  if (!match) {
    return "is not a PEM private key (expected a -----BEGIN ... PRIVATE KEY----- block)";
  }
  const label = match[1] ?? "";
  if (label === "ENCRYPTED PRIVATE KEY" || /^Proc-Type:.*ENCRYPTED/m.test(match[2] ?? "")) {
    return "is an encrypted private key; provide the unencrypted key GitHub issued";
  }
  if (!ACCEPTED_LABELS.has(label)) {
    return "is not a PEM private key (expected RSA PRIVATE KEY or PRIVATE KEY)";
  }
  let keyType: string | undefined;
  try {
    keyType = createPrivateKey({ key: pem, format: "pem" }).asymmetricKeyType;
  } catch {
    // The crypto error is dropped on purpose: only a fixed message leaves this function.
    return "is not a valid PEM private key (the key data could not be parsed)";
  }
  if (keyType !== "rsa") return "is not an RSA private key (GitHub App keys are RSA)";
  return null;
}

export type DatabaseUrlResult =
  { url: Secret<string>; problems: [] } | { url: null; problems: string[] };

/**
 * Validates only `DATABASE_URL`, for tools that run without the GitHub App settings (the
 * migration job). Same rules as `parseEnv`; problem text never contains the URL.
 */
export function parseDatabaseUrl(env: EnvSource): DatabaseUrlResult {
  const parsed = databaseUrlSchema.safeParse(env[DATABASE_URL_VAR], { reportInput: false });
  if (!parsed.success) {
    return {
      url: null,
      problems: parsed.error.issues.map((issue) => `${DATABASE_URL_VAR}: ${issue.message}`),
    };
  }
  return { url: new Secret(parsed.data), problems: [] };
}

export type EnvResult = { env: EnvConfig; problems: [] } | { env: null; problems: string[] };

/**
 * Validates the environment variables that remain after GitHub, provider and sync-scope settings
 * moved to the database (workspace-settings). Returns every problem found, each naming the
 * variable; problem text never contains a variable's value.
 */
export function parseEnv(env: EnvSource): EnvResult {
  const parsed = envSchema.safeParse(env, { reportInput: false });
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`);
  // Bootstrap admin must be all-or-nothing; check on raw input so it surfaces alongside others.
  const adminEmail = typeof env.ADMIN_EMAIL === "string" && env.ADMIN_EMAIL.trim() !== "";
  const adminPassword = typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.trim() !== "";
  if (adminEmail !== adminPassword) {
    problems.push("ADMIN_EMAIL, ADMIN_PASSWORD: set both or neither (bootstrap admin)");
  }

  if (!parsed.success || problems.length > 0) return { env: null, problems };
  const v = parsed.data;
  return {
    env: Object.freeze({
      databaseUrl: new Secret(v.DATABASE_URL),
      syncSecret: new Secret(v.SYNC_SECRET),
      sessionSecret: new Secret(v.SESSION_SECRET),
      adminEmail: v.ADMIN_EMAIL?.toLowerCase() ?? null,
      adminPassword: v.ADMIN_PASSWORD ? new Secret(v.ADMIN_PASSWORD) : null,
    }),
    problems: [],
  };
}

/**
 * Names of retired settings still present in the environment or on disk (workspace-settings design
 * decision 10). They are no longer read; the server says so once. Names only, never values.
 */
export const RETIRED_ENV_VARS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_WEBHOOK_SECRET",
  "CONFIG_PATH",
  "AI_ANTHROPIC_API_KEY",
  "AI_OPENAI_BASE_URL",
  "AI_OPENAI_API_KEY",
] as const;

export function retiredEnvVars(env: EnvSource): string[] {
  return RETIRED_ENV_VARS.filter((name) => (env[name] ?? "").trim() !== "");
}

/** The config file that used to hold the repository scope and limits; it is no longer read. */
export const RETIRED_CONFIG_FILE = "docmyrepos.config.yml";

/**
 * Everything retired that is still present: environment variables, and the default config file in
 * `cwd`. Names only. `exists` is a test seam; the default checks the disk.
 */
export function retiredSources(
  env: EnvSource,
  cwd: string = process.cwd(),
  exists: (path: string) => boolean = existsSync,
): string[] {
  const found = retiredEnvVars(env);
  if (exists(resolve(cwd, RETIRED_CONFIG_FILE))) found.push(RETIRED_CONFIG_FILE);
  return found;
}
