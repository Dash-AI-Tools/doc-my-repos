import { MIN_SECRET_LENGTH } from "../config/secret";
import { errorFields, logger, type Logger } from "../log";
import { SIGNATURE_HEADER, verifyWebhookSignature } from "./verify";

/**
 * The request handling behind `POST /api/webhooks/github` (task 6.2), free of Next.js so it can be
 * tested with plain `Request` objects. `src/app/api/webhooks/github/route.ts` binds it to the
 * configured secret and the event dispatcher.
 *
 * Order, so that nothing untrusted is parsed and nothing is touched before the signature checks out:
 *   1. The webhook secret is read (environment only, no database). Missing or shorter than
 *      `MIN_SECRET_LENGTH`: 500, before anything else, also for unsigned requests.
 *   2. Headers only: the content type must be `application/json` (415 otherwise).
 *   3. The raw body is read once as bytes, capped at `MAX_WEBHOOK_BODY_BYTES` by `Content-Length`
 *      and again while streaming (413). It is never decoded or re-serialised before step 4.
 *   4. `X-Hub-Signature-256` is verified over those bytes. A missing, malformed or wrong signature
 *      gives the same fixed 401; no JSON is parsed and the dispatcher is not called.
 *   5. Only then are the event headers checked and the body parsed as a JSON object (400).
 *   6. `ping` answers 200. Every other event goes to `dispatch`.
 *
 * Form-encoded deliveries (`application/x-www-form-urlencoded` with a `payload=` field) are refused
 * with 415: a GitHub App always delivers JSON, so only a misconfigured repository or organization
 * hook would send them, and refusing them keeps a single parsing path.
 *
 * Dispatch: `dispatch(event, payload, deliveryId)` returns a promise. The handler waits for it up to
 * `dispatchWaitMs` (default 5 s, well inside GitHub's 10 s delivery timeout). Resolved: 202. Thrown
 * or rejected within the wait: 500, so GitHub records a failed delivery that can be redelivered.
 * Still pending after the wait: 202, and the promise keeps running detached; a later rejection is
 * caught and logged with fixed text, so there is never an unhandled rejection. A dispatcher that
 * starts a long sync should therefore start it and resolve without awaiting it (task 6.3/6.4).
 *
 * Nothing here logs or returns the secret, the signature, the body or an error's message. Log
 * lines (structured, `../log`) carry only the outcome words, the validated event name
 * (`githubEvent`) and the validated delivery id: `webhook.rejected` (with a reason), `webhook.signature` (`rejected`),
 * `webhook.received`, `webhook.dispatch` (`done`, `pending`) or `webhook.dispatch_failed`.
 *
 * Status codes:
 *   200  ping                            202  event accepted (dispatched or still running)
 *   400  bad event headers or body       401  missing, malformed or wrong signature
 *   405  method other than POST          413  body over the cap
 *   415  content type not application/json
 *   500  webhook secret not configured, or the dispatcher failed
 */

/** GitHub caps webhook payloads at 25 MB; 25 MiB leaves a little room above that. */
export const MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;

/** How long the response waits for `dispatch` before answering 202 and leaving it running. */
export const DEFAULT_DISPATCH_WAIT_MS = 5000;

/** A parsed webhook payload: always a JSON object. Its shape is whatever GitHub sent. */
export type WebhookPayload = Readonly<Record<string, unknown>>;

/**
 * Handles one verified, non-ping event. `event` is the `X-GitHub-Event` name (lower case letters,
 * digits and `_`), `deliveryId` the `X-GitHub-Delivery` GUID or null when absent. Task 6.3 provides
 * the router; it must not throw secrets in error messages (they are not logged, but still).
 */
export type WebhookDispatch = (
  event: string,
  payload: WebhookPayload,
  deliveryId: string | null,
) => Promise<void>;

/** The dispatcher until task 6.3: acknowledges every event and does nothing. */
export const acknowledgeOnly: WebhookDispatch = async () => undefined;

export interface WebhookDeps {
  /** The configured webhook secret, or null when it is missing or invalid. Must not touch the DB. */
  readSecret(): string | null;
  /** Called only after the signature is verified. Defaults to `acknowledgeOnly`. */
  dispatch?: WebhookDispatch;
  /** Body cap in bytes. Defaults to `MAX_WEBHOOK_BODY_BYTES`. */
  maxBodyBytes?: number;
  /** See the module comment. Defaults to `DEFAULT_DISPATCH_WAIT_MS`. */
  dispatchWaitMs?: number;
  /** Structured log. Only outcome words, the validated event name and delivery id are passed. */
  log?: Logger;
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

const unauthorized = (): Response => json(401, { error: "unauthorized" });

const notConfigured = (): Response =>
  json(500, { error: "misconfigured", message: "The server is not configured for webhooks." });

const internalError = (): Response =>
  json(500, { error: "internal_error", message: "The webhook could not be processed." });

const invalidRequest = (): Response =>
  json(400, { error: "invalid_request", message: "The webhook request is malformed." });

const payloadTooLarge = (): Response =>
  json(413, { error: "payload_too_large", message: "The body is too large." });

const unsupportedMediaType = (): Response =>
  json(
    415,
    { error: "unsupported_media_type", message: "Webhooks must be sent as application/json." },
    { accept: "application/json" },
  );

/** Every method but POST, without reading the request. */
export function methodNotAllowed(): Response {
  return json(405, { error: "method_not_allowed" }, { allow: "POST" });
}

// ---------------------------------------------------------------------------------------------
// Request parts

/** `application/json`, optionally with parameters such as `; charset=utf-8`. */
function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const essence = value.split(";", 1)[0]?.trim().toLowerCase();
  return essence === "application/json";
}

/** Reads the body as bytes, at most `max` of them. */
async function readRawBody(
  request: Request,
  max: number,
): Promise<Uint8Array | "too_large" | "invalid"> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return "too_large";
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return "invalid";
  }
  return Buffer.concat(chunks, size);
}

// GitHub event names are lower case words joined by `_` (`push`, `installation_repositories`).
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// GitHub sends a GUID; accept any short token of the same alphabet so the value is safe to log.
const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/;

/** A JSON object from the verified bytes, or null when they are not UTF-8 JSON for an object. */
function parsePayload(raw: Uint8Array): WebhookPayload | null {
  let value: unknown;
  try {
    // `fatal` rejects invalid UTF-8; a leading BOM is dropped by the decoder.
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as WebhookPayload;
}

// ---------------------------------------------------------------------------------------------
// Dispatch

type Outcome = "done" | "failed" | "pending";

/**
 * Runs `dispatch` and waits up to `waitMs` for it. The returned promise never rejects, and the
 * dispatch promise always has a rejection handler attached, also when the wait runs out first.
 */
async function runDispatch(
  dispatch: WebhookDispatch,
  event: string,
  payload: WebhookPayload,
  deliveryId: string | null,
  waitMs: number,
  log: Logger,
): Promise<Outcome> {
  const details = { githubEvent: event, deliveryId: deliveryId ?? "none" };
  let settled: Promise<Outcome>;
  try {
    settled = Promise.resolve(dispatch(event, payload, deliveryId)).then(
      (): Outcome => "done",
      (error: unknown): Outcome => {
        // Only safe error fields (name, kind, code): the message may carry tokens or URLs.
        log.error("webhook.dispatch_failed", { ...details, ...errorFields(error) });
        return "failed";
      },
    );
  } catch (error) {
    log.error("webhook.dispatch_failed", { ...details, ...errorFields(error) });
    return "failed";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve("pending"), waitMs);
  });
  try {
    return await Promise.race([settled, wait]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// Handler

/**
 * Handles one `POST /api/webhooks/github` request. Never throws: every failure becomes a response
 * with a fixed body.
 */
export async function handleWebhookRequest(request: Request, deps: WebhookDeps): Promise<Response> {
  const log = deps.log ?? logger;
  try {
    let secret: string | null;
    try {
      secret = deps.readSecret();
    } catch {
      secret = null;
    }
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
      log.error("webhook.not_configured", { variable: "GITHUB_WEBHOOK_SECRET" });
      return notConfigured();
    }
    const rejected = (reason: string, response: Response): Response => {
      log.warn("webhook.rejected", { reason, httpStatus: response.status });
      return response;
    };

    if (!isJsonContentType(request.headers.get("content-type"))) {
      return rejected("unsupported_media_type", unsupportedMediaType());
    }

    const raw = await readRawBody(request, deps.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES);
    if (raw === "too_large") return rejected("too_large", payloadTooLarge());
    if (raw === "invalid") return rejected("unreadable_body", invalidRequest());

    // Only the verdict is logged: never the header, the secret or the body.
    if (!verifyWebhookSignature(raw, request.headers.get(SIGNATURE_HEADER), secret)) {
      log.warn("webhook.signature", { verification: "rejected" });
      return unauthorized();
    }

    // Authenticated from here on.
    const event = request.headers.get("x-github-event");
    if (event === null || !EVENT_NAME.test(event))
      return rejected("invalid_event", invalidRequest());
    const delivery = request.headers.get("x-github-delivery");
    if (delivery !== null && !DELIVERY_ID.test(delivery)) {
      return rejected("invalid_delivery_id", invalidRequest());
    }

    const payload = parsePayload(raw);
    if (payload === null) return rejected("invalid_json", invalidRequest());

    log.info("webhook.received", {
      githubEvent: event,
      deliveryId: delivery ?? "none",
      verification: "accepted",
    });
    if (event === "ping") return json(200, { ok: true, event: "ping" });

    const outcome = await runDispatch(
      deps.dispatch ?? acknowledgeOnly,
      event,
      payload,
      delivery,
      deps.dispatchWaitMs ?? DEFAULT_DISPATCH_WAIT_MS,
      log,
    );
    if (outcome === "failed") return internalError();
    log.info("webhook.dispatch", { githubEvent: event, deliveryId: delivery ?? "none", outcome });
    return json(202, { ok: true });
  } catch (error) {
    log.error("webhook.failed", errorFields(error));
    return internalError();
  }
}
