import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { openInBrowser, type OpenBrowser } from "./browser.js";

export const LOOPBACK_HOST = "127.0.0.1";
export const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const GITHUB_ORIGIN = "https://github.com";
/** GitHub's one-time manifest codes are short ASCII tokens; anything else is not one. */
const CODE_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;

export type CallbackFailure = "timeout" | "aborted" | "closed";

/** Why no code arrived. The orchestrator offers a retry or the paste route on `timeout`. */
export class ManifestCallbackError extends Error {
  readonly reason: CallbackFailure;
  constructor(reason: CallbackFailure) {
    super(
      reason === "timeout"
        ? "No answer from GitHub arrived within 10 minutes."
        : reason === "aborted"
          ? "Waiting for GitHub was cancelled."
          : "The local callback page was closed before GitHub answered.",
    );
    this.name = "ManifestCallbackError";
    this.reason = reason;
  }
}

/**
 * What the orchestrator needs from any way of obtaining the manifest code: the loopback
 * server below, or a paste route built on `parsePastedCode`.
 */
export interface ManifestCodeSource {
  /** Address to open (and print as the fallback). */
  readonly startUrl: string;
  /** The `state` value GitHub must echo back. Kept in memory, never logged. */
  readonly state: string;
  readonly result: Promise<{ readonly code: string }>;
  close(): Promise<void>;
}

export interface ManifestCallbackHandle extends ManifestCodeSource {
  /** The `redirect_url` the manifest must carry. */
  readonly callbackUrl: string;
  readonly port: number;
  /** False when the browser could not be launched: print `startUrl` for the user. */
  readonly opened: boolean;
}

export interface ManifestCallbackOptions {
  readonly organization: string;
  /** The manifest, or a function building it once the callback address is known. */
  readonly manifest: object | ((redirectUrl: string) => object);
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Defaults to the platform opener. A failure to open must resolve `false`, not throw. */
  readonly openBrowser?: OpenBrowser;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const token = (): string => randomBytes(32).toString("base64url");

/** Constant-time string comparison; unequal lengths are unequal without comparing bytes. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

const PAGE_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

export const DONE_PAGE = page("All set", "You can close this tab and return to the terminal.");
export const REJECTED_PAGE = page(
  "Not accepted",
  "This request was not accepted. Return to the terminal.",
);

function send(
  res: ServerResponse,
  status: number,
  body: string,
  type = "text/html; charset=utf-8",
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Security-Policy": PAGE_CSP,
    "Content-Type": type,
    ...extra,
  });
  res.end(body);
}

function startPage(
  action: string,
  manifestJson: string,
  nonce: string,
): { html: string; csp: string } {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Continue to GitHub</title></head><body>` +
    `<p>Sending you to GitHub to create the app...</p>` +
    `<form id="f" method="post" action="${escapeHtml(action)}">` +
    `<input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">` +
    `<noscript><button type="submit">Continue to GitHub</button></noscript></form>` +
    `<script nonce="${nonce}">document.getElementById("f").submit();</script></body></html>`;
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${GITHUB_ORIGIN}; frame-ancestors 'none'; base-uri 'none'`;
  return { html, csp };
}

export async function startManifestCallback(
  options: ManifestCallbackOptions,
): Promise<ManifestCallbackHandle> {
  const { signal } = options;
  if (signal?.aborted) throw new ManifestCallbackError("aborted");

  const state = token();
  const startToken = token();
  const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;

  let settle!: {
    resolve: (value: { code: string }) => void;
    reject: (error: ManifestCallbackError) => void;
  };
  const result = new Promise<{ code: string }>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Callers that only call close() must not trigger an unhandled rejection.
  result.catch(() => undefined);

  let finished = false;
  let startServed = false;
  let allowedHosts: readonly string[] = [];
  let startHtml = { html: "", csp: "" };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (finished || !allowedHosts.includes(req.headers.host ?? "")) {
      send(res, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? LOOPBACK_HOST}`);
    } catch {
      send(res, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    if (url.pathname !== "/start" && url.pathname !== "/callback") {
      send(res, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    if (req.method !== "GET") {
      send(res, 405, "Method not allowed", "text/plain; charset=utf-8", { Allow: "GET" });
      return;
    }

    if (url.pathname === "/start") {
      const given = url.searchParams.get("t") ?? "";
      if (startServed || !safeEqual(given, startToken)) {
        send(res, 404, "Not found", "text/plain; charset=utf-8");
        return;
      }
      startServed = true;
      send(res, 200, startHtml.html, "text/html; charset=utf-8", {
        "Content-Security-Policy": startHtml.csp,
      });
      return;
    }

    const givenState = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    if (!safeEqual(givenState, state) || !CODE_PATTERN.test(code)) {
      send(res, 400, REJECTED_PAGE);
      return;
    }
    finished = true;
    res.on("close", () => void shutdown());
    send(res, 200, DONE_PAGE, "text/html; charset=utf-8", { Connection: "close" });
    settle.resolve({ code });
  };

  const server: Server = createServer(handler);
  const timer = setTimeout(() => void fail("timeout"), timeoutMs);
  let closed: Promise<void> | undefined;

  const onAbort = (): void => void fail("aborted");

  function shutdown(): Promise<void> {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    closed ??= new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closed;
  }

  async function fail(reason: CallbackFailure): Promise<void> {
    settle.reject(new ManifestCallbackError(reason));
    await shutdown();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  allowedHosts = [`${LOOPBACK_HOST}:${port}`, `localhost:${port}`];
  const callbackUrl = `http://${LOOPBACK_HOST}:${port}/callback`;
  const startUrl = `http://${LOOPBACK_HOST}:${port}/start?t=${startToken}`;
  const manifest =
    typeof options.manifest === "function" ? options.manifest(callbackUrl) : options.manifest;
  const action = `${GITHUB_ORIGIN}/organizations/${encodeURIComponent(options.organization)}/settings/apps/new?state=${encodeURIComponent(state)}`;
  startHtml = startPage(action, JSON.stringify(manifest), token());

  signal?.addEventListener("abort", onAbort, { once: true });

  let opened = false;
  try {
    opened = await (options.openBrowser ?? openInBrowser)(startUrl);
  } catch {
    opened = false;
  }

  return {
    startUrl,
    callbackUrl,
    port,
    state,
    opened,
    result,
    close: () => {
      settle.reject(new ManifestCallbackError("closed"));
      return shutdown();
    },
  };
}

export type PasteResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: "empty" | "not-a-code" | "no-code" | "state-mismatch" };

/**
 * Fallback route: the user pastes the `code` value, or the whole callback address from the
 * browser bar. When a `state` is present in a pasted address and one is expected, they must
 * match. The input is never echoed in the result.
 */
export function parsePastedCode(input: string, expectedState?: string): PasteResult {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (CODE_PATTERN.test(text)) return { ok: true, code: text };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "not-a-code" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "not-a-code" };
  }
  const code = url.searchParams.get("code");
  if (code === null || !CODE_PATTERN.test(code)) return { ok: false, reason: "no-code" };
  const state = url.searchParams.get("state");
  if (state !== null && expectedState !== undefined && !safeEqual(state, expectedState)) {
    return { ok: false, reason: "state-mismatch" };
  }
  return { ok: true, code };
}
