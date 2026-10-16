import { renderCompose } from "./compose-template.js";
import { normalizePem, pemProblem } from "./pem.js";
import {
  validateAddress,
  validateEmail,
  validateImageTag,
  validateNumericId,
  validatePassword,
  validatePort,
  validateRepositoryNames,
  validateSharedSecret,
} from "./validate.js";

export const COMPOSE_FILE = "docker-compose.yml";
export const ENV_FILE = ".env";
export const CONFIG_FILE = "docmyrepos.config.yml";
export const GITIGNORE_FILE = ".gitignore";
export const KEY_FILE = "github-app.private-key.pem";
/** Where the compose secret appears inside the container. */
export const KEY_CONTAINER_PATH = "/run/secrets/github_app_key";

/** Everything the plan needs. All values are expected to be validated; `plan` checks them again. */
export interface Answers {
  /** The GitHub organization (informational: it ends up in a comment only). */
  readonly org: string;
  /** The portal address, for example `http://localhost:3000`. */
  readonly url: string;
  readonly port: number;
  readonly adminEmail: string;
  readonly adminPassword: string;
  /** `"all"` (everything the App can access) or bare repository names. */
  readonly repos: "all" | readonly string[];
  readonly appId: number;
  readonly installationId: number;
  /** Unencrypted RSA private key in PEM form. */
  readonly privateKeyPem: string;
  readonly webhookSecret: string;
  readonly sessionSecret: string;
  readonly syncSecret: string;
  readonly postgresPassword: string;
  /** Image tag; the installer's own version unless overridden. */
  readonly imageTag: string;
  /** The host the files are for. Defaults to the current process. */
  readonly host?: HostInfo;
}

export interface HostInfo {
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** The user id on POSIX hosts, null where there is none (Windows). */
  readonly uid: number | null;
}

export function currentHost(): HostInfo {
  return { platform: process.platform, uid: process.getuid?.() ?? null };
}

export type KeyLayout = "file" | "inline";

/** The container runs as uid 1000. Decision 7: mount the key file when the host user is 1000 or Docker Desktop maps ownership. */
export function chooseKeyLayout(host: HostInfo): { layout: KeyLayout; reason: string } {
  if (host.platform === "darwin" || host.platform === "win32") {
    return {
      layout: "file",
      reason:
        "Docker Desktop maps file ownership, so the key file is readable inside the container.",
    };
  }
  if (host.uid === 1000) {
    return {
      layout: "file",
      reason: "your user id is 1000, the same as the container user, so it can read the key file.",
    };
  }
  return {
    layout: "inline",
    reason:
      "the container user (uid 1000) could not read a key file owned by another user, so the key is stored in the owner-only .env instead (visible in `docker inspect` to root-equivalent users).",
  };
}

export interface PlannedFile {
  /** Path relative to the target folder. */
  readonly path: string;
  readonly content: string;
  /** File mode for the final file (POSIX; best effort on Windows). */
  readonly mode: number;
  /** Holds secrets: never print the content. */
  readonly secret: boolean;
}

export interface InstallPlan {
  readonly files: readonly PlannedFile[];
  readonly keyLayout: KeyLayout;
  readonly keyLayoutReason: string;
}

/** Raised for an invalid answer. The message never contains the offending value. */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

function valid<T>(label: string, check: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!check.ok) throw new PlanError(`${label}: ${check.reason}`);
  return check.value;
}

/** A value that is safe between single quotes in an env file: no quote, no line break (the key's `\n` escapes are added by the caller). */
function singleQuoted(label: string, value: string): string {
  if (/['\r\n\u0000]/.test(value)) {
    throw new PlanError(`${label}: contains a character that cannot be stored in .env`);
  }
  return `'${value}'`;
}

function envFile(a: Answers, layout: KeyLayout, pem: string): string {
  const keyLine =
    layout === "file"
      ? `GITHUB_APP_PRIVATE_KEY_PATH=${KEY_CONTAINER_PATH}`
      : `GITHUB_APP_PRIVATE_KEY=${singleQuoted("private key", pem.replace(/\r?\n/g, "\\n"))}`;
  return (
    [
      "# Written by create-docmyrepos. This file holds secrets: keep it owner-only and never commit it.",
      `# Portal address: ${a.url}`,
      `APP_PORT=${a.port}`,
      "",
      "# Database (compose builds DATABASE_URL from these).",
      `POSTGRES_PASSWORD=${singleQuoted("database password", a.postgresPassword)}`,
      "",
      "# GitHub App (read-only).",
      `GITHUB_APP_ID=${a.appId}`,
      `GITHUB_APP_INSTALLATION_ID=${a.installationId}`,
      keyLine,
      `GITHUB_WEBHOOK_SECRET=${singleQuoted("webhook secret", a.webhookSecret)}`,
      "",
      "SYNC_SECRET=" + singleQuoted("sync secret", a.syncSecret),
      "SESSION_SECRET=" + singleQuoted("session secret", a.sessionSecret),
      "",
      "# First administrator, created on the first sign-in while there are no users.",
      "# Remove both lines after signing in, then run `docker compose up -d`.",
      `ADMIN_EMAIL=${singleQuoted("admin email", a.adminEmail)}`,
      `ADMIN_PASSWORD=${singleQuoted("admin password", a.adminPassword)}`,
    ].join("\n") + "\n"
  );
}

function configFile(repos: "all" | readonly string[]): string {
  const header = [
    "# DocMyRepos configuration. It only narrows the repositories the GitHub App can access;",
    "# see docmyrepos.config.example.yml in the DocMyRepos repository for every option.",
  ];
  if (repos === "all") {
    return [
      ...header,
      "# All repositories the GitHub App installation can access are synced.",
      "",
    ].join("\n");
  }
  // JSON strings are valid YAML strings, and keep names such as `true` or `1.5` from becoming
  // other types.
  return [...header, "repos:", ...repos.map((name) => `  - ${JSON.stringify(name)}`), ""].join(
    "\n",
  );
}

const GITIGNORE = [".env", ".env.*", "*.pem", "*.bak-*", ""].join("\n");

/**
 * Turns validated answers into the files of an installation. Pure: no I/O, no randomness.
 * Throws `PlanError` (message without values) on an invalid answer.
 */
export function plan(answers: Answers): InstallPlan {
  const a = answers;
  valid("address", validateAddress(a.url));
  valid("port", validatePort(a.port));
  valid("admin email", validateEmail(a.adminEmail));
  valid("admin password", validatePassword(a.adminPassword));
  valid("GitHub App id", validateNumericId(String(a.appId)));
  valid("installation id", validateNumericId(String(a.installationId)));
  valid("webhook secret", validateSharedSecret(a.webhookSecret));
  valid("session secret", validateSharedSecret(a.sessionSecret));
  valid("sync secret", validateSharedSecret(a.syncSecret));
  valid("database password", validateSharedSecret(a.postgresPassword));
  const tag = valid("image tag", validateImageTag(a.imageTag));
  const repos = a.repos === "all" ? "all" : valid("repositories", validateRepositoryNames(a.repos));
  if (a.postgresPassword === "docmyrepos") throw new PlanError("database password: is the default");
  // It is placed in DATABASE_URL without escaping.
  if (!/^[A-Za-z0-9_-]+$/.test(a.postgresPassword)) {
    throw new PlanError("database password: use only letters, digits, '-' and '_'");
  }
  const problem = pemProblem(a.privateKeyPem);
  if (problem !== null) throw new PlanError(`private key: ${problem}`);

  const pem = normalizePem(a.privateKeyPem);
  const { layout, reason } = chooseKeyLayout(a.host ?? currentHost());

  const files: PlannedFile[] = [
    {
      path: COMPOSE_FILE,
      content: renderCompose({ tag, keyAsFile: layout === "file" }),
      mode: 0o644,
      secret: false,
    },
    { path: ENV_FILE, content: envFile(a, layout, pem), mode: 0o600, secret: true },
    { path: CONFIG_FILE, content: configFile(repos), mode: 0o644, secret: false },
    { path: GITIGNORE_FILE, content: GITIGNORE, mode: 0o644, secret: false },
  ];
  if (layout === "file") {
    files.push({ path: KEY_FILE, content: pem + "\n", mode: 0o600, secret: true });
  }
  return { files, keyLayout: layout, keyLayoutReason: reason };
}
