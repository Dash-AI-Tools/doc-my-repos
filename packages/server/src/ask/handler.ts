import "server-only";

import { z } from "zod";

import {
  encodeEvent,
  type AskErrorKind,
  type AskEvent,
  type AskReference,
} from "@docmyrepos/core/internal/ask/events";
import { docUrl } from "@docmyrepos/core/internal/routes";

import { type Access, legacyAccess } from "../auth/access";
import type { CurrentUser } from "../auth/current-user";
import {
  providerAvailability,
  providerCredentials,
  type ProviderSettingsInput,
} from "./credentials";
import { type Db, type DbInput, resolveDb } from "../db/client";
import { errorFields, logger, type Logger } from "../log";
import { anchorId, SLUG_ID } from "../markdown/sanitize";
import type { QueryOptions } from "../queries";
import { requireSameOrigin } from "../same-origin";
import { getWorkspace } from "../workspace";
import {
  askGate,
  checkWindows,
  estimateTokens,
  finishUsage,
  startUsage,
  type AskGate,
  type TokenCounts,
  type UsageOutcome,
} from "./limits";
import { buildAnswerMessages, MAX_QUESTION_CHARS, type PromptExcerpt } from "./prompt";
import {
  ProviderError,
  createProvider,
  type ProviderAdapter,
  type ProviderDeps,
  type ProviderMessage,
} from "./providers";
import { retrieve, type Excerpt, type Retriever } from "./retrieve";
import { readAskSettings, resolveAsk } from "./settings";

/**
 * `POST /api/ask` (ask-the-docs design decisions 6 and 7). The route file is a thin wrapper.
 *
 * Check order, each step ending the request with its own status:
 *   1. Ask is ready (404)        2. session (401)         3. same-origin + JSON (403)
 *   4. body, zod strict (400/413)   5. concurrency (429 one at a time, 503 busy, Retry-After)
 *   6. per-user day and ten-minute limits (429, Retry-After)
 * then a `text/event-stream` answer: `status` (searching), retrieval, and either `done` with
 * `no_results` (the model is never called) or `references`, `status` (answering), `delta`s and
 * `done` / `error`. Availability, provider and model are resolved once at the top, so a settings
 * change never switches provider in the middle of an answer.
 *
 * Nothing about the question, answer, excerpts or key is logged or stored: logs and the usage row
 * carry ids, counts and fixed words.
 */

export const MAX_REQUEST_CHARS = 64 * 1024;
const MAX_HISTORY_ANSWER_INPUT = 8000;
/** Total time for the answer call, including the whole stream. */
export const ANSWER_DEADLINE_MS = 60_000;

const Body = z.strictObject({
  question: z
    .string()
    .transform((q) => q.trim())
    .pipe(z.string().min(1).max(MAX_QUESTION_CHARS)),
  history: z
    .array(
      z.strictObject({
        question: z.string().max(MAX_QUESTION_CHARS),
        answer: z.string().max(MAX_HISTORY_ANSWER_INPUT),
      }),
    )
    .max(4)
    .default([]),
  repo: z
    .string()
    .max(201)
    .regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/)
    .nullish(),
});

export interface AskLimitsConfig {
  readonly questionsPerDay: number;
  readonly questionsPerTenMinutes: number;
  readonly maxOutputTokens: number;
  readonly maxConcurrent: number;
}

/** What the handler needs from the workspace: provider settings and the limits. */
export interface AskWorkspace {
  readonly providers: ProviderSettingsInput;
  readonly config: { readonly ask: AskLimitsConfig };
}

export interface AskHandlerDeps {
  /** Whether the tenant is entitled to Ask. Default: always. */
  readonly entitled?: () => Promise<boolean>;
  /** The request's tenant, part of every in-process limit key. Default: the built-in tenant. */
  readonly tenantId?: string;
  readonly db: DbInput;
  /** The current workspace settings. Default `getWorkspace`. */
  readonly workspace?: () => Promise<AskWorkspace>;
  readonly limits?: () => AskLimitsConfig;
  readonly user?: (db: Db) => Promise<CurrentUser>;
  /**
   * Who is asking and what they may do (routes: the request context's `authenticate` and
   * `authorize`). Default: the open-source rules over the session cookie, or over `user`.
   */
  readonly access?: Access;
  readonly log?: Logger;
  readonly options?: QueryOptions;
  readonly gate?: AskGate;
  /** Test seams for the provider adapters (fetch, sleep, Anthropic endpoint). */
  readonly providerDeps?: ProviderDeps;
  readonly retriever?: Retriever;
  readonly answerDeadlineMs?: number;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie, Origin",
} as const;

function json(
  status: number,
  body: Record<string, unknown>,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

const MESSAGES = {
  not_found: "Not found",
  unauthorized: "Unauthorized",
  forbidden: "Cross-site requests are not allowed",
  invalid_json: "The request body must be valid JSON",
  too_large: "The request body is too large",
  rate_limited: "You have asked too many questions. Try again later.",
  user_busy: "Wait for your current question to finish.",
  busy: "Ask is busy right now. Try again in a moment.",
  unavailable: "Ask is temporarily unavailable",
} as const;

function authStatus(error: unknown): 401 | 503 {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: number }).status
      : undefined;
  return status === 401 ? 401 : 503;
}

async function readBody(request: Request): Promise<{ value: unknown } | Response> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_REQUEST_CHARS * 4) {
    return json(413, { error: MESSAGES.too_large, code: "too_large" });
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return json(400, { error: MESSAGES.invalid_json, code: "invalid_json" });
  }
  if (text.length > MAX_REQUEST_CHARS)
    return json(413, { error: MESSAGES.too_large, code: "too_large" });
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return json(400, { error: MESSAGES.invalid_json, code: "invalid_json" });
  }
}

/** Maps a provider failure to the small set of kinds users can be shown. */
export function userErrorKind(error: unknown): AskErrorKind {
  if (!(error instanceof ProviderError)) return "unavailable";
  switch (error.kind) {
    case "timeout":
      return "timeout";
    case "malformed":
      return "malformed";
    case "filtered":
      return "filtered";
    case "rate_limited":
      return "busy";
    default:
      return "unavailable";
  }
}

/**
 * The reference for an excerpt, built from stored data only. The link carries a `#anchor` only when
 * the document page really gives that heading an id (the same rule as search results): a valid
 * slug, and not the depth-1 heading, which is the document's own title.
 */
function toReference(e: Excerpt): AskReference {
  const base = docUrl(e.repo.owner, e.repo.name, e.path, e.repo.docsPath);
  const section = e.heading !== null && e.heading.depth > 1 ? e.heading : null;
  const anchored = section !== null && SLUG_ID.test(section.slug);
  return {
    n: e.n,
    title: e.title,
    repo: `${e.repo.owner}/${e.repo.name}`,
    path: e.path,
    heading: section?.text ?? null,
    href:
      base === null
        ? null
        : anchored
          ? `${base}#${encodeURIComponent(anchorId(section.slug))}`
          : base,
  };
}

function toPromptExcerpt(e: Excerpt): PromptExcerpt {
  return {
    n: e.n,
    repo: `${e.repo.owner}/${e.repo.name}`,
    path: e.path,
    heading: e.heading?.text ?? null,
    text: e.text,
  };
}

const charCount = (messages: readonly ProviderMessage[]) =>
  messages.reduce((n, m) => n + m.content.length, 0);

export async function handleAsk(request: Request, deps: AskHandlerDeps): Promise<Response> {
  const log = deps.log ?? logger;

  // 1. Resolve availability once. Anything but `ready` is a 404, so a disabled Ask is invisible.
  let db: Db;
  let state;
  let workspace: AskWorkspace;
  try {
    db = await resolveDb(deps.db);
    workspace = await (deps.workspace ?? getWorkspace)();
    state = resolveAsk(await readAskSettings(db), providerAvailability(workspace.providers));
    // Not entitled is off, exactly as when an administrator turned Ask off.
    if (state.state !== "off" && deps.entitled && !(await deps.entitled())) {
      state = { state: "off" } as const;
    }
  } catch (error) {
    log.error("ask.request.failed", { stage: "settings", ...errorFields(error) });
    return json(503, { error: MESSAGES.unavailable, code: "unavailable" });
  }
  if (state.state !== "ready") return json(404, { error: MESSAGES.not_found, code: "not_found" });
  const credentials = providerCredentials(workspace.providers, state.provider);
  if (credentials === null) return json(404, { error: MESSAGES.not_found, code: "not_found" });

  // 2. Session.
  let user: CurrentUser;
  let access: Access;
  try {
    const testUser = deps.user;
    access = deps.access ?? legacyAccess(db, testUser ? async () => testUser(db) : undefined);
    user = await access.user();
    // Like a disabled Ask: a user the `authorize` hook does not let ask finds no Ask here.
    if (!(await access.can("ask.use"))) {
      return json(404, { error: MESSAGES.not_found, code: "not_found" });
    }
  } catch (error) {
    return authStatus(error) === 401
      ? json(401, { error: MESSAGES.unauthorized, code: "unauthorized" })
      : json(503, { error: MESSAGES.unavailable, code: "unavailable" });
  }

  // 3. Same origin and JSON.
  const origin = requireSameOrigin(request);
  if (!origin.ok) return json(403, { error: origin.error, code: "bad_origin" });

  // 4. Body.
  const raw = await readBody(request);
  if (raw instanceof Response) return raw;
  const parsed = Body.safeParse(raw.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const first = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path[0];
    const field = typeof first === "string" ? first : "body";
    return json(400, {
      error: `The field "${field}" is not valid`,
      code: "invalid",
      field,
    });
  }
  const body = parsed.data;

  const limits: AskLimitsConfig = deps.limits ? deps.limits() : workspace.config.ask;

  // 5. Concurrency: one answer per user, a cap per process.
  const slot = (deps.gate ?? askGate).tryEnter(user.id, limits.maxConcurrent, deps.tenantId);
  if (!slot.ok) {
    return slot.reason === "user_busy"
      ? json(429, { error: MESSAGES.user_busy, code: "user_busy" }, { "Retry-After": "5" })
      : json(503, { error: MESSAGES.busy, code: "busy" }, { "Retry-After": "5" });
  }

  // 6. Per-user day and ten-minute limits.
  try {
    const decision =
      user.id > 0 ? await checkWindows(db, user.id, limits) : ({ ok: true } as const);
    if (!decision.ok) {
      slot.release();
      return json(
        429,
        {
          error: MESSAGES.rate_limited,
          code: "rate_limited",
          limit: decision.reason,
          retryAfterSeconds: decision.retryAfterSeconds,
        },
        { "Retry-After": String(decision.retryAfterSeconds) },
      );
    }
  } catch (error) {
    slot.release();
    log.error("ask.request.failed", { stage: "limits", ...errorFields(error) });
    return json(503, { error: MESSAGES.unavailable, code: "unavailable" });
  }

  // The answer. Aborts when the reader goes away (request signal) or cancels the stream.
  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  request.signal.addEventListener("abort", onRequestAbort, { once: true });
  if (request.signal.aborted) abort.abort();

  const provider = createProvider(credentials, state.model, deps.providerDeps);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (event: AskEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        } catch {
          open = false;
        }
      };
      void produceAnswer({
        db,
        user,
        access,
        provider,
        providerName: state.provider,
        body,
        limits,
        signal: abort.signal,
        send,
        log,
        options: deps.options,
        retriever: deps.retriever ?? retrieve,
        deadlineMs: deps.answerDeadlineMs ?? ANSWER_DEADLINE_MS,
      })
        .catch((error: unknown) => {
          // Unreachable by design (every step handles its own failure); never leave it unhandled.
          log.error("ask.answer.failed", { stage: "unexpected", ...errorFields(error) });
          send({ event: "error", data: { kind: "unavailable" } });
        })
        .finally(() => {
          slot.release();
          request.signal.removeEventListener("abort", onRequestAbort);
          if (open) {
            open = false;
            try {
              controller.close();
            } catch {
              // already cancelled
            }
          }
        });
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie, Origin",
    },
  });
}

interface AnswerRun {
  readonly db: Db;
  readonly user: CurrentUser;
  /** Records `ask.answered` for the asking user. */
  readonly access: Access;
  readonly provider: ProviderAdapter;
  readonly providerName: string;
  readonly body: z.infer<typeof Body>;
  readonly limits: AskLimitsConfig;
  readonly signal: AbortSignal;
  readonly send: (event: AskEvent) => void;
  readonly log: Logger;
  readonly options: QueryOptions | undefined;
  readonly retriever: Retriever;
  readonly deadlineMs: number;
}

/** Everything after the checks: retrieval, the no-hit shortcut, the model call and the records. */
async function produceAnswer(run: AnswerRun): Promise<void> {
  const { db, user, provider, body, limits, signal, send, log } = run;
  const started = Date.now();
  send({ event: "status", data: { state: "searching" } });

  let excerpts: readonly Excerpt[];
  let queryTokens: TokenCounts | null = null;
  try {
    const result = await run.retriever(
      { db, provider, signal, ...(run.options ? { options: run.options } : {}) },
      { question: body.question, history: body.history, repo: body.repo ?? null },
    );
    excerpts = result.excerpts;
    queryTokens = result.usage;
  } catch (error) {
    if (signal.aborted) return; // the reader left
    log.error("ask.answer.failed", { stage: "retrieve", userId: user.id, ...errorFields(error) });
    send({ event: "error", data: { kind: userErrorKind(error) } });
    return;
  }
  if (signal.aborted) return;

  if (excerpts.length === 0) {
    send({ event: "references", data: { references: [] } });
    send({ event: "done", data: { outcome: "no_results" } });
    log.info("ask.answer.finished", { userId: user.id, outcome: "no_results", excerpts: 0 });
    return;
  }

  const messages = buildAnswerMessages({
    question: body.question,
    history: body.history,
    excerpts: excerpts.map(toPromptExcerpt),
  });

  let usageId: number;
  try {
    usageId = await startUsage(db, {
      userId: user.id > 0 ? user.id : null,
      provider: run.providerName,
      excerptCount: excerpts.length,
      queryTokens,
    });
  } catch (error) {
    log.error("ask.answer.failed", { stage: "usage", userId: user.id, ...errorFields(error) });
    send({ event: "error", data: { kind: "unavailable" } });
    return;
  }

  send({ event: "references", data: { references: excerpts.map(toReference) } });
  send({ event: "status", data: { state: "answering" } });

  let outcome: Exclude<UsageOutcome, "started"> = "ok";
  let reported: TokenCounts | null = null;
  let outputChars = 0;
  try {
    for await (const event of provider.stream(messages, {
      maxTokens: limits.maxOutputTokens,
      signal,
      deadlineMs: run.deadlineMs,
    })) {
      if (event.type === "text") {
        outputChars += event.text.length;
        send({ event: "delta", data: { text: event.text } });
      } else if (event.type === "usage") {
        reported = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
      } else {
        outcome = "cut_off";
      }
    }
    send({ event: "done", data: { outcome: outcome === "cut_off" ? "cut_off" : "ok" } });
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "aborted") outcome = "stopped";
    else if (error instanceof ProviderError) outcome = `error_${error.kind}`;
    else outcome = "error_unavailable";
    if (outcome !== "stopped") {
      log.error("ask.answer.failed", {
        stage: "answer",
        userId: user.id,
        provider: run.providerName,
        ...errorFields(error),
      });
      send({ event: "error", data: { kind: userErrorKind(error) } });
    }
  }

  const tokens = reported ?? {
    inputTokens: estimateTokens(charCount(messages)),
    outputTokens: estimateTokens(outputChars),
  };
  if (outcome === "ok") {
    run.access.emit({
      name: "ask.answered",
      // Every model call of the question, as in its usage row: the query rewrite and the answer.
      payload: {
        provider: run.providerName,
        inputTokens: (queryTokens?.inputTokens ?? 0) + tokens.inputTokens,
        outputTokens: (queryTokens?.outputTokens ?? 0) + tokens.outputTokens,
      },
      actorId: user.id,
    });
  }
  try {
    await finishUsage(db, usageId, { outcome, tokens, estimated: reported === null });
  } catch (error) {
    log.error("ask.usage.failed", { userId: user.id, ...errorFields(error) });
  }
  log.info("ask.answer.finished", {
    userId: user.id,
    provider: run.providerName,
    outcome,
    excerpts: excerpts.length,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    durationMs: Date.now() - started,
  });
}
