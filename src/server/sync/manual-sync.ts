import { z } from "zod";

import type { SyncRepoResult } from "../db/schema";
import { verifySyncSecret } from "./auth";
import type { SyncAllResult, SyncOneResult, SyncOneTarget } from "./engine";
import { REPO_BUSY_MESSAGE, describeSyncError, type RunStats, type SyncErrorInfo } from "./runs";

/**
 * The request handling behind `POST /api/sync` (task 6.1), free of Next.js so it can be tested with
 * plain `Request` objects. `src/app/api/sync/route.ts` binds it to the real runtime.
 *
 * Contract:
 * - Auth comes first: the bearer secret is checked before the body is read and before the sync
 *   service (runtime, database, GitHub) is touched. A missing or wrong secret gives the same fixed
 *   401 and nothing is synced.
 * - The body is optional JSON: `{}` or empty syncs everything; `{"repo":"name"}`,
 *   `{"repo":"owner/name"}` or `{"githubId":123}` syncs one repository. Unknown keys are rejected.
 * - Responses carry fixed error codes and the sync's own fixed messages; no secret, token, stack
 *   or database text ever reaches the body or the log.
 *
 * Status codes:
 *   200  run finished with status success or partial (repositories lists every outcome)
 *   400  invalid JSON or body            413  body over 4 KiB
 *   401  missing or wrong secret         404  repository unknown to the installation or not selected
 *   409  the repository is being synced by another run; nothing was done, retry shortly
 *        (task 6.4 will coalesce such requests and may answer 202 instead)
 *   500  server misconfigured or unexpected failure
 *   502  the run failed and a retry will not help by itself (credentials, repository errors)
 *   503  the run failed or could not start but is retryable; `Retry-After` is set when known
 */

export const MAX_BODY_BYTES = 4096;
const MAX_RETRY_AFTER_SECONDS = 3600;

export interface ManualSyncService {
  syncAll(options: { trigger: "manual" }): Promise<SyncAllResult>;
  syncOne(target: SyncOneTarget, options: { trigger: "manual" }): Promise<SyncOneResult>;
}

export interface ManualSyncDeps {
  /** The configured sync secret, or null when it is missing or invalid. Must not touch the DB. */
  readSecret(): string | null;
  /** Builds the service from freshly re-read config. Throws `ConfigError` when it is invalid. */
  getService(): ManualSyncService;
  now?: () => number;
  /** Operator log. Only fixed text and configuration problem names are ever passed. */
  log?: (message: string, ...details: string[]) => void;
}

// ---------------------------------------------------------------------------------------------
// Responses

type Json = Record<string, unknown>;

function json(status: number, body: Json, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

const unauthorized = (): Response =>
  json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });

const notConfigured = (): Response =>
  json(500, { error: "misconfigured", message: "The server is not configured for syncing." });

const internalError = (): Response =>
  json(500, { error: "internal_error", message: "The sync failed unexpectedly." });

const invalidRequest = (): Response =>
  json(400, {
    error: "invalid_request",
    message:
      'The body must be empty, or JSON like {"repo":"name"}, {"repo":"owner/name"} or {"githubId":123}.',
  });

/** Allowed methods on the route, for the `Allow` header of 405 responses. */
export function methodNotAllowed(): Response {
  return json(405, { error: "method_not_allowed" }, { allow: "POST" });
}

// ---------------------------------------------------------------------------------------------
// Body

const REPO_PART = /^[A-Za-z0-9._-]{1,100}$/;

const bodySchema = z
  .strictObject({
    repo: z.string().max(201).optional(),
    githubId: z.number().int().safe().positive().optional(),
  })
  .refine((b) => b.repo === undefined || b.githubId === undefined, "repo and githubId conflict");

/** `"name"` or `"owner/name"` to a target, or null when it is neither. */
function parseRepo(value: string): SyncOneTarget | null {
  const parts = value.split("/");
  if (parts.length > 2 || !parts.every((p) => REPO_PART.test(p) && !/^\.+$/.test(p))) return null;
  const [first, second] = parts as [string, string?];
  return second === undefined ? { name: first } : { owner: first, name: second };
}

type Body = { ok: true; target: SyncOneTarget | null } | { ok: false; response: Response };

async function readText(request: Request): Promise<string | "too_large" | "invalid"> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return "too_large";
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return "invalid";
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return "invalid";
  }
}

async function parseBody(request: Request): Promise<Body> {
  const text = await readText(request);
  if (text === "too_large") {
    return {
      ok: false,
      response: json(413, { error: "payload_too_large", message: "The body is too large." }),
    };
  }
  if (text === "invalid") return { ok: false, response: invalidRequest() };
  if (text.trim() === "") return { ok: true, target: null };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: invalidRequest() };
  }
  const parsed = bodySchema.safeParse(raw, { reportInput: false });
  if (!parsed.success) return { ok: false, response: invalidRequest() };
  const { repo, githubId } = parsed.data;
  if (githubId !== undefined) return { ok: true, target: { githubId } };
  if (repo === undefined) return { ok: true, target: null };
  const target = parseRepo(repo);
  return target === null ? { ok: false, response: invalidRequest() } : { ok: true, target };
}

// ---------------------------------------------------------------------------------------------
// Result mapping

/** The fields of one repository's outcome that are safe and useful to return. */
function repositoryEntry(result: SyncRepoResult): Json {
  return {
    repo: result.repo,
    githubId: result.githubId,
    status: result.status,
    error: result.error,
    errorKind: result.errorKind,
    retryable: result.retryable,
    retryAfter: result.retryAfter,
    added: result.added,
    updated: result.updated,
    identical: result.identical,
    removed: result.removed,
    skipped: result.skipped,
    failedFilesTotal: result.failedFilesTotal,
    warningsTotal: result.warningsTotal,
    ...(result.removalReason === undefined ? {} : { removalReason: result.removalReason }),
  };
}

interface RanSummary {
  runId: number;
  status: "success" | "partial" | "failed";
  durationMs: number | null;
  stats: RunStats;
}

function secondsUntil(epochMs: number, now: number): number {
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil((epochMs - now) / 1000)));
}

/** 503 with the latest known retry time, 503 when retryable, else 502. */
function failureResponse(
  body: Json,
  entries: readonly SyncRepoResult[],
  fatal: SyncErrorInfo | null,
  now: number,
): Response {
  const times: number[] = [];
  if (fatal?.retryAt != null) times.push(fatal.retryAt);
  for (const e of entries) {
    const at = e.retryAfter === null ? Number.NaN : Date.parse(e.retryAfter);
    if (Number.isFinite(at)) times.push(at);
  }
  const retryable = (fatal?.retryable ?? false) || entries.some((e) => e.retryable);
  if (times.length > 0) {
    return json(503, body, { "retry-after": String(secondsUntil(Math.max(...times), now)) });
  }
  return json(retryable ? 503 : 502, body);
}

function runBody(run: RanSummary, entries: readonly SyncRepoResult[], extra: Json = {}): Json {
  return {
    ok: run.status !== "failed",
    run: { id: run.runId, status: run.status, durationMs: run.durationMs, stats: run.stats },
    repositories: entries.map(repositoryEntry),
    ...extra,
  };
}

function couldNotRun(reason: string): Response {
  return json(
    503,
    { ok: false, error: "sync_not_started", reason, message: "The sync could not start; retry." },
    { "retry-after": "5" },
  );
}

function isBusy(entry: SyncRepoResult): boolean {
  return entry.status === "skipped" && entry.error === REPO_BUSY_MESSAGE;
}

function mapAll(result: SyncAllResult, now: number): Response {
  const { run } = result;
  if (!run.ran) return couldNotRun(run.reason);
  const entries = run.value;
  const summary: RanSummary = {
    runId: run.runId,
    status: run.status,
    durationMs: run.durationMs,
    stats: run.stats,
  };
  const fatal = result.fatal;
  const extra: Json = {
    scope: "all",
    ...(fatal === null
      ? {}
      : { error: { kind: fatal.kind, message: fatal.message, retryable: fatal.retryable } }),
  };
  const body = runBody(summary, entries, extra);
  if (run.status === "failed") return failureResponse(body, entries, fatal, now);
  if (entries.length > 0 && entries.every(isBusy)) return json(409, { ...body, ok: false });
  return json(200, body);
}

function mapOne(result: SyncOneResult, now: number): Response {
  switch (result.status) {
    case "not_found":
      return json(404, {
        ok: false,
        error: "repository_not_found",
        message: "No such repository is accessible to the GitHub App.",
      });
    case "not_configured":
      return json(404, {
        ok: false,
        error: "repository_not_configured",
        reason: result.reason,
        message: "That repository is not selected for syncing.",
      });
    case "discovery_failed": {
      const info = result.error;
      const body: Json = {
        ok: false,
        scope: "repo",
        error: { kind: info.kind, message: info.message, retryable: info.retryable },
      };
      return failureResponse(body, [], info, now);
    }
    case "synced": {
      const { run, result: entry } = result;
      if (!run.ran) return couldNotRun(run.reason);
      if (entry === null) return internalError();
      const summary: RanSummary = {
        runId: run.runId,
        status: run.status,
        durationMs: run.durationMs,
        stats: run.stats,
      };
      const body = runBody(summary, [entry], { scope: "repo" });
      if (isBusy(entry)) return json(409, { ...body, ok: false });
      if (entry.status === "error" || entry.status === "skipped" || run.status === "failed") {
        return failureResponse({ ...body, ok: false }, [entry], null, now);
      }
      return json(200, body);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Handler

function isConfigError(error: unknown): error is Error & { problems: readonly string[] } {
  return error instanceof Error && error.name === "ConfigError" && "problems" in error;
}

/**
 * Handles one `POST /api/sync` request. Never throws: every failure becomes a response with a
 * fixed body.
 */
export async function handleManualSync(request: Request, deps: ManualSyncDeps): Promise<Response> {
  const log = deps.log ?? ((message, ...details) => console.error(message, ...details));
  const now = deps.now ?? Date.now;
  try {
    const secret = deps.readSecret();
    if (secret === null) {
      log("sync: SYNC_SECRET is not set or is shorter than the minimum length; /api/sync is off");
      return notConfigured();
    }
    if (!verifySyncSecret(request.headers.get("authorization"), secret)) return unauthorized();

    const body = await parseBody(request);
    if (!body.ok) return body.response;

    let service: ManualSyncService;
    try {
      service = deps.getService();
    } catch (error) {
      if (isConfigError(error)) {
        // `problems` name variables and config fields, never values.
        log("sync: invalid configuration", ...error.problems);
        return notConfigured();
      }
      throw error;
    }

    const result =
      body.target === null
        ? mapAll(await service.syncAll({ trigger: "manual" }), now())
        : mapOne(await service.syncOne(body.target, { trigger: "manual" }), now());
    return result;
  } catch (error) {
    // describeSyncError returns fixed text: raw errors can carry connection strings or tokens.
    log("sync: unexpected failure", describeSyncError(error, now()).message);
    return internalError();
  }
}
