import { safeQuote } from "./credentials.js";
import { isLoopbackHost, type Check } from "./validate.js";
import { packageVersion } from "./version.js";

export const DEFAULT_GITHUB_API_URL = "https://api.github.com";
/** Test-only override. Honored only for a loopback host. */
export const API_URL_ENV = "DOCMYREPOS_GITHUB_API_URL";
export const MAX_REPOSITORIES = 1000;
const PAGE_SIZE = 100;
const MAX_INSTALLATION_PAGES = 10;

/**
 * The GitHub API base to use. `https://api.github.com` unless `DOCMYREPOS_GITHUB_API_URL` is set to
 * a loopback address (for the fake server); any other host is refused, so the override can never
 * send credentials anywhere else.
 */
export function resolveGithubApiUrl(
  env: Readonly<Record<string, string | undefined>>,
): Check<string> {
  const raw = env[API_URL_ENV];
  if (raw === undefined || raw.trim() === "") return { ok: true, value: DEFAULT_GITHUB_API_URL };
  return checkOverride(raw.trim());
}

function checkOverride(raw: string): Check<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `${API_URL_ENV} is not a valid address.` };
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      reason: `${API_URL_ENV} is a test-only setting and is accepted only for a loopback host such as http://127.0.0.1:PORT.`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: `${API_URL_ENV} must not contain a user name or password.` };
  }
  return { ok: true, value: `${url.protocol}//${url.host}` };
}

export type GithubErrorKind =
  | "offline"
  | "rate_limit"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "manifest_rejected"
  | "unexpected";

/** An error whose message is fixed text plus, at most, a credential-free quote from GitHub. */
export class GithubError extends Error {
  readonly kind: GithubErrorKind;
  readonly step: string;
  readonly status: number | undefined;
  constructor(kind: GithubErrorKind, step: string, message: string, status?: number) {
    super(message);
    this.name = "GithubError";
    this.kind = kind;
    this.step = step;
    this.status = status;
  }
}

const MESSAGES: Record<GithubErrorKind, (step: string) => string> = {
  offline: (s) => `Could not reach GitHub while ${s}. Check your network connection and try again.`,
  rate_limit: (s) =>
    `GitHub's rate limit was reached while ${s}. Wait a few minutes and try again.`,
  unauthorized: (s) =>
    `GitHub did not accept the credentials while ${s}. Check that the App id and the private key belong to the same App and that this computer's clock is correct.`,
  forbidden: (s) =>
    `GitHub refused the request while ${s}. The App may be suspended or may lack access to the organization.`,
  not_found: (s) =>
    `GitHub could not find what was asked for while ${s}. Check the App id, the organization name and that the App is installed.`,
  manifest_rejected: (s) =>
    `GitHub rejected the App manifest while ${s}. Create the App by hand instead (see docs/github-app-setup.md, section 5a) and enter its values.`,
  unexpected: (s) => `GitHub answered in a way the installer did not expect while ${s}.`,
};

export function describeGithubError(kind: GithubErrorKind, step: string, quote?: string): string {
  const base = MESSAGES[kind](step);
  return quote === undefined ? base : `${base} GitHub said: "${quote}"`;
}

export interface Installation {
  readonly id: number;
  readonly login: string;
  readonly accountType: string;
}

export interface AppInfo {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly permissions: Readonly<Record<string, string>>;
  readonly events: readonly string[];
}

/** What the manifest conversion returns. These are secrets: keep them in memory only. */
export interface ConvertedApp {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly pem: string;
  readonly webhookSecret: string;
}

export interface RepositoryList {
  /** Bare repository names, sorted, at most `MAX_REPOSITORIES`. */
  readonly names: readonly string[];
  readonly total: number;
  readonly truncated: boolean;
}

export type InstallationLookup =
  | { readonly status: "found"; readonly id: number; readonly login: string }
  | { readonly status: "wrong_account"; readonly accounts: readonly string[] }
  | { readonly status: "none" };

export type WaitResult =
  | { readonly status: "found"; readonly id: number; readonly login: string }
  | { readonly status: "timeout"; readonly accounts: readonly string[] }
  | { readonly status: "aborted"; readonly accounts: readonly string[] };

export interface WaitOptions {
  readonly organization: string;
  /** Called for every poll, so the wizard can tell the user about a wrong account. */
  readonly onPoll?: (lookup: InstallationLookup) => void;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface GithubClientOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
}

export interface GithubClient {
  /** `POST /app-manifests/{code}/conversions` (no authentication). */
  convertManifest(code: string): Promise<ConvertedApp>;
  /** `GET /app`, authenticated as the App. */
  getApp(jwt: string): Promise<AppInfo>;
  /** `GET /app/installations`, all pages. */
  listInstallations(jwt: string): Promise<readonly Installation[]>;
  /** Polls until the organization has an installation. `jwt` is called per poll (it expires). */
  waitForInstallation(jwt: () => string, options: WaitOptions): Promise<WaitResult>;
  /** `POST /app/installations/{id}/access_tokens`. The token is a secret. */
  createInstallationToken(jwt: string, installationId: number): Promise<string>;
  /** `GET /installation/repositories`, paginated, capped at 1,000. */
  listRepositories(installationToken: string): Promise<RepositoryList>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const unexpected = (step: string): GithubError =>
  new GithubError("unexpected", step, describeGithubError("unexpected", step));

/** Case-insensitive match of the installation account against the chosen organization. */
export function findInstallation(
  installations: readonly Installation[],
  organization: string,
): InstallationLookup {
  const wanted = organization.toLowerCase();
  const match = installations.find((i) => i.login.toLowerCase() === wanted);
  if (match !== undefined) return { status: "found", id: match.id, login: match.login };
  if (installations.length === 0) return { status: "none" };
  return { status: "wrong_account", accounts: installations.map((i) => i.login) };
}

const EXPECTED_PERMISSIONS: Readonly<Record<string, string>> = {
  contents: "read",
  metadata: "read",
};

/**
 * Warnings for an existing App. Any permission other than `contents: read` and `metadata: read`
 * (a write level, or an extra permission) is excess; a missing one means syncing cannot work.
 */
export function detectPermissionWarnings(permissions: Readonly<Record<string, string>>): string[] {
  const warnings: string[] = [];
  for (const [name, access] of Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b))) {
    if (EXPECTED_PERMISSIONS[name] === access) continue;
    warnings.push(
      name in EXPECTED_PERMISSIONS
        ? `The App has ${access} access to ${name}; DocMyRepos only needs read access.`
        : `The App has ${access} access to ${name}, which DocMyRepos does not need.`,
    );
  }
  for (const name of Object.keys(EXPECTED_PERMISSIONS)) {
    if (permissions[name] === undefined) {
      warnings.push(`The App has no ${name} read access, which DocMyRepos needs.`);
    }
  }
  return warnings;
}

export function createGithubClient(options: GithubClientOptions = {}): GithubClient {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  let base = DEFAULT_GITHUB_API_URL;
  if (options.baseUrl !== undefined && options.baseUrl !== DEFAULT_GITHUB_API_URL) {
    const checked = checkOverride(options.baseUrl);
    if (!checked.ok) throw new Error(checked.reason);
    base = checked.value;
  }
  const userAgent = `create-docmyrepos/${packageVersion()}`;

  async function request(
    step: string,
    method: "GET" | "POST",
    path: string,
    auth?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
          ...(auth === undefined ? {} : { Authorization: `Bearer ${auth}` }),
        },
      });
    } catch {
      throw new GithubError("offline", step, describeGithubError("offline", step));
    }

    let text = "";
    try {
      text = await response.text();
    } catch {
      throw new GithubError("offline", step, describeGithubError("offline", step));
    }
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }

    if (response.status >= 200 && response.status < 300) {
      if (body === undefined) throw unexpected(step);
      return body;
    }
    throw mapFailure(step, response, body);
  }

  function mapFailure(step: string, response: Response, body: unknown): GithubError {
    const status = response.status;
    const rawMessage = isRecord(body) && typeof body.message === "string" ? body.message : "";
    const quote = rawMessage === "" ? undefined : (safeQuote(rawMessage) ?? undefined);
    const rateLimited =
      status === 429 ||
      (status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.get("retry-after") !== null ||
          /rate limit/i.test(rawMessage)));
    let kind: GithubErrorKind;
    if (rateLimited) kind = "rate_limit";
    else if (status === 401) kind = "unauthorized";
    else if (status === 403) kind = "forbidden";
    else if (status === 404) kind = "not_found";
    else if (status === 422 && step === CONVERT_STEP) kind = "manifest_rejected";
    else kind = "unexpected";
    const useQuote = kind === "unexpected" || kind === "manifest_rejected" || kind === "forbidden";
    return new GithubError(
      kind,
      step,
      describeGithubError(kind, step, useQuote ? quote : undefined),
      status,
    );
  }

  const CONVERT_STEP = "creating the App from the manifest";
  const APP_STEP = "checking the App";
  const INSTALLATIONS_STEP = "looking for the installation";
  const TOKEN_STEP = "requesting an installation token";
  const REPOS_STEP = "listing the repositories";

  return {
    async convertManifest(code) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) {
        throw new GithubError(
          "not_found",
          CONVERT_STEP,
          "The code from GitHub looks wrong. Start the App creation again.",
        );
      }
      const body = await request(CONVERT_STEP, "POST", `/app-manifests/${code}/conversions`);
      if (
        !isRecord(body) ||
        typeof body.id !== "number" ||
        typeof body.slug !== "string" ||
        typeof body.pem !== "string" ||
        typeof body.webhook_secret !== "string"
      ) {
        throw unexpected(CONVERT_STEP);
      }
      return {
        id: body.id,
        slug: body.slug,
        name: typeof body.name === "string" ? body.name : body.slug,
        pem: body.pem,
        webhookSecret: body.webhook_secret,
      };
    },

    async getApp(jwt) {
      const body = await request(APP_STEP, "GET", "/app", jwt);
      if (!isRecord(body) || typeof body.id !== "number" || typeof body.slug !== "string") {
        throw unexpected(APP_STEP);
      }
      const permissions: Record<string, string> = {};
      if (isRecord(body.permissions)) {
        for (const [key, value] of Object.entries(body.permissions)) {
          if (typeof value === "string") permissions[key] = value;
        }
      }
      return {
        id: body.id,
        slug: body.slug,
        name: typeof body.name === "string" ? body.name : body.slug,
        permissions,
        events: Array.isArray(body.events)
          ? body.events.filter((e): e is string => typeof e === "string")
          : [],
      };
    },

    async listInstallations(jwt) {
      const found: Installation[] = [];
      for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
        const body = await request(
          INSTALLATIONS_STEP,
          "GET",
          `/app/installations?per_page=${PAGE_SIZE}&page=${page}`,
          jwt,
        );
        if (!Array.isArray(body)) throw unexpected(INSTALLATIONS_STEP);
        for (const item of body) {
          if (
            isRecord(item) &&
            typeof item.id === "number" &&
            isRecord(item.account) &&
            typeof item.account.login === "string"
          ) {
            found.push({
              id: item.id,
              login: item.account.login,
              accountType: typeof item.account.type === "string" ? item.account.type : "",
            });
          }
        }
        if (body.length < PAGE_SIZE) break;
      }
      return found;
    },

    async waitForInstallation(jwt, wait) {
      const timeoutMs = wait.timeoutMs ?? 10 * 60_000;
      const intervalMs = wait.intervalMs ?? 3000;
      const deadline = now() + timeoutMs;
      let accounts: readonly string[] = [];
      for (;;) {
        if (wait.signal?.aborted === true) return { status: "aborted", accounts };
        const installations = await this.listInstallations(jwt());
        const lookup = findInstallation(installations, wait.organization);
        wait.onPoll?.(lookup);
        if (lookup.status === "found") return lookup;
        accounts = lookup.status === "wrong_account" ? lookup.accounts : [];
        if (now() + intervalMs > deadline) return { status: "timeout", accounts };
        await sleep(intervalMs);
      }
    },

    async createInstallationToken(jwt, installationId) {
      if (!Number.isSafeInteger(installationId) || installationId <= 0) {
        throw new GithubError(
          "not_found",
          TOKEN_STEP,
          describeGithubError("not_found", TOKEN_STEP),
        );
      }
      const body = await request(
        TOKEN_STEP,
        "POST",
        `/app/installations/${installationId}/access_tokens`,
        jwt,
      );
      if (!isRecord(body) || typeof body.token !== "string" || body.token === "") {
        throw unexpected(TOKEN_STEP);
      }
      return body.token;
    },

    async listRepositories(token) {
      const names: string[] = [];
      let total = 0;
      for (let page = 1; names.length < MAX_REPOSITORIES; page += 1) {
        const body = await request(
          REPOS_STEP,
          "GET",
          `/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`,
          token,
        );
        if (!isRecord(body) || !Array.isArray(body.repositories)) throw unexpected(REPOS_STEP);
        if (typeof body.total_count === "number") total = body.total_count;
        for (const repo of body.repositories) {
          if (isRecord(repo) && typeof repo.name === "string" && names.length < MAX_REPOSITORIES) {
            names.push(repo.name);
          }
        }
        if (body.repositories.length < PAGE_SIZE) break;
      }
      names.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }) || a.localeCompare(b));
      return {
        names,
        total: Math.max(total, names.length),
        truncated: total > names.length,
      };
    },
  };
}
