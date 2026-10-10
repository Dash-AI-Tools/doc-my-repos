/**
 * Security headers and the Content-Security-Policy (task 12.1). Pure builders: no React, no
 * database, no Next.js imports, so `src/proxy.ts`, `next.config.ts` and the tests share them.
 *
 * Where each header is set:
 *
 * - `src/proxy.ts` runs on every request except `/_next/static/*`. It makes a fresh nonce,
 *   passes it to the app (`x-nonce` request header, plus the CSP request header that Next.js
 *   reads to put the nonce on its own scripts) and sets `responseSecurityHeaders()` on the
 *   response: pages, route handlers, not-found pages and redirects alike.
 * - `next.config.ts` `headers()` sets `STATIC_ASSET_HEADERS` on `/_next/static/*`, which the
 *   proxy skips (immutable build files: no nonce needed, and the proxy would only cost time).
 *
 * Precedence: headers set by the proxy (or `next.config.ts`) are already on the outgoing response
 * when a route handler returns, and Next.js does not overwrite a header that is already present
 * (`next/dist/server/send-response.js`). So the proxy leaves out the headers that a route sets
 * for itself (`ROUTE_OWNED_HEADERS`): the image proxy's sandbox CSP must win for asset
 * responses.
 *
 * Third parties: none. No analytics, no font or script CDN. To load something from another
 * origin, add that origin to the one directive that needs it (for example a font CDN to
 * `font-src`, never to `default-src` or `script-src`), see README "Security headers and CSP".
 */

/** Request header carrying the per-request nonce from the proxy to the root layout. */
export const NONCE_HEADER = "x-nonce";

/** 128 random bits, base64: 22 characters and `==`. */
const NONCE_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

/** A fresh nonce: 128 bits from the platform CSPRNG (Web Crypto), base64-encoded. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Whether `value` has the shape `generateNonce()` produces. The layout only trusts a nonce of
 * that shape, so a malformed header can never break out of the `nonce` attribute or the policy.
 */
export function isValidNonce(value: string | null | undefined): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

export interface CspOptions {
  /** Per-request nonce from `generateNonce()`. */
  readonly nonce: string;
  /**
   * `next dev` only: React rebuilds server error stacks in the browser with `eval`. Never true
   * in a production build (`NODE_ENV=production`).
   */
  readonly dev?: boolean;
  /**
   * The page was served over HTTPS (directly or behind a TLS-terminating reverse proxy). Adds
   * `upgrade-insecure-requests`; off on plain `http://localhost` so local runs and e2e work.
   */
  readonly https?: boolean;
  /**
   * Seam for violation reports. No endpoint exists today, so nothing passes it. Must be a
   * same-origin path or an absolute https URL; it is emitted as `report-uri`.
   */
  readonly reportUri?: string;
}

/**
 * The page Content-Security-Policy, directive by directive. `default-src 'none'` denies every
 * fetch type that is not listed, so each allowance below is deliberate.
 */
export function buildContentSecurityPolicy(options: CspOptions): string {
  if (!isValidNonce(options.nonce)) throw new Error("CSP nonce must come from generateNonce().");
  const directives: string[] = [
    // Deny by default: media, workers, frames, prefetch and anything new browsers add.
    "default-src 'none'",
    // Scripts: only those carrying this request's nonce. Next.js puts the nonce on its framework
    // scripts and inline RSC payload scripts; next-themes' pre-paint script gets it from the
    // layout. 'strict-dynamic' lets those trusted scripts load further chunks (Mermaid's lazy
    // import), so no host list is needed; 'self' is only a fallback for browsers without CSP3.
    // No 'unsafe-inline': an injected inline script or event handler attribute never runs.
    // 'unsafe-eval' only in `next dev` (React's dev error overlay); production has no eval.
    `script-src 'self' 'nonce-${options.nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ""}`,
    // Styles: 'unsafe-inline' is required and a nonce would not help. Shiki colours code with
    // `style` attributes (CSS variables per token, set server-side, sanitizer-restricted), and
    // Mermaid builds an SVG with its own <style> element and style attributes in the browser and
    // inserts it as markup, where our nonce cannot be attached. Hashes cannot cover per-document
    // content. A nonce must NOT be added here: browsers ignore 'unsafe-inline' when a nonce or
    // hash is present, which would break both. CSS cannot run script; see README for the risk.
    "style-src 'self' 'unsafe-inline'",
    // Images: same-origin (the /api/asset proxy for repository images, our own files) and any
    // https: image a document links directly (badges, diagrams hosted elsewhere). External
    // images are not proxied (design decision 6); they load with referrerpolicy=no-referrer.
    // Plain http: and data: images are refused (the sanitizer drops data: sources anyway).
    "img-src 'self' https:",
    // Fonts: the app ships none from elsewhere; same-origin only.
    "font-src 'self'",
    // fetch/XHR: the command palette calls /api/search, Next.js fetches RSC payloads; all
    // same-origin. (In `next dev`, 'self' also covers the same-origin HMR websocket.)
    "connect-src 'self'",
    "manifest-src 'self'",
    // No frames in, no frames out, no plugins.
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    // An injected <base href> could redirect every relative URL (scripts included).
    "base-uri 'none'",
    // The search form is a GET to /search; nothing posts anywhere else.
    "form-action 'self'",
  ];
  if (options.https) directives.push("upgrade-insecure-requests");
  if (options.reportUri !== undefined) {
    if (!/^(?:\/(?!\/)|https:\/\/)[^\s;,]+$/.test(options.reportUri)) {
      throw new Error("CSP reportUri must be a same-origin path or an https URL.");
    }
    directives.push(`report-uri ${options.reportUri}`);
  }
  return directives.join("; ");
}

/**
 * HSTS: two years, subdomains included (the app's own host is expected to be HTTPS-only).
 * `preload` is left out on purpose: preload list membership is hard to undo and is a decision
 * for whoever owns the domain, not for the app. Sent only over HTTPS in production; browsers
 * ignore it on plain HTTP anyway.
 */
export const HSTS_VALUE = "max-age=63072000; includeSubDomains";

/**
 * Powerful browser features the portal never uses are denied for the page and any frame.
 * `clipboard-write=(self)` keeps the code copy button working. Only features Chromium knows are
 * listed: an unknown one is reported in the console (`web-share` is, on desktop Chromium), and the
 * e2e CSP watcher fails on that.
 */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "clipboard-read=()",
  "clipboard-write=(self)",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

/**
 * `same-origin`: full Referer inside the portal, none to other sites. Portal URLs name private
 * repositories and documents (`/acme/internal-tools/docs/...`), and not every outbound link is
 * document content with `rel=noreferrer` (GitHub links in headers, code owner profiles), so the
 * default `strict-origin-when-cross-origin` would still leak the portal's host. This removes it.
 */
export const REFERRER_POLICY = "same-origin";

/** Headers every response gets, static files included. No CSP and no HSTS here. */
export const BASELINE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  // Never guess a content type: a document served as text must not be sniffed into HTML/script.
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", REFERRER_POLICY],
  ["Permissions-Policy", PERMISSIONS_POLICY],
  // Legacy twin of frame-ancestors 'none' for old browsers.
  ["X-Frame-Options", "DENY"],
  // A cross-origin window opened from the portal (or that opened it) gets no handle to it.
  ["Cross-Origin-Opener-Policy", "same-origin"],
  // Our responses are not embeddable by other sites (images included: /api/asset is ours only).
  ["Cross-Origin-Resource-Policy", "same-origin"],
  // Do not pre-resolve the hosts of external links in documents (privacy).
  ["X-DNS-Prefetch-Control", "off"],
  // No Flash/PDF cross-domain policy files.
  ["X-Permitted-Cross-Domain-Policies", "none"],
];

/** `next.config.ts` headers for `/_next/static/*` (the proxy does not run there). */
export const STATIC_ASSET_HEADERS = BASELINE_HEADERS.map(([key, value]) => ({ key, value }));

/**
 * Headers a route sets for itself, so the proxy must not set them first (the first value wins).
 * The image proxy (`src/server/assets/serve.ts`) sends a sandbox CSP, `no-referrer`, `nosniff`
 * and CORP `same-origin` on every response, errors included.
 */
export const ROUTE_OWNED_HEADERS: ReadonlyArray<{
  readonly prefix: string;
  readonly headers: ReadonlySet<string>;
}> = [
  {
    prefix: "/api/asset/",
    headers: new Set([
      "content-security-policy",
      "referrer-policy",
      "x-content-type-options",
      "cross-origin-resource-policy",
    ]),
  },
];

export interface ResponseHeaderOptions {
  readonly pathname: string;
  readonly csp: string;
  readonly production: boolean;
  readonly https: boolean;
}

/** The headers the proxy sets on a response, minus those the matched route owns. */
export function responseSecurityHeaders(options: ResponseHeaderOptions): Array<[string, string]> {
  const all: Array<[string, string]> = [
    ["Content-Security-Policy", options.csp],
    ...BASELINE_HEADERS.map(([key, value]): [string, string] => [key, value]),
  ];
  if (options.production && options.https) all.push(["Strict-Transport-Security", HSTS_VALUE]);
  const owned = ROUTE_OWNED_HEADERS.find((route) => options.pathname.startsWith(route.prefix));
  return owned ? all.filter(([key]) => !owned.headers.has(key.toLowerCase())) : all;
}

/**
 * Whether the request arrived over HTTPS: the URL scheme, or the first `X-Forwarded-Proto` value
 * from a TLS-terminating reverse proxy. A client faking the header only changes its own response
 * (HSTS over plain HTTP is ignored by browsers), so trusting it is harmless.
 */
export function isHttpsRequest(protocol: string, forwardedProto: string | null): boolean {
  if (protocol === "https:") return true;
  const first = forwardedProto?.split(",")[0]?.trim().toLowerCase();
  return first === "https";
}

/**
 * Whether a raw (still percent-encoded) path has an escape that does not decode: a `%` not
 * followed by two hex digits, or bytes that are not UTF-8 (`/acme/%E0%A4%A`). Next.js answers
 * those with a bare 500 before any page code runs; the proxy turns them into a 400.
 */
export function hasMalformedPercentEncoding(rawPath: string): boolean {
  if (!rawPath.includes("%")) return false;
  try {
    decodeURIComponent(rawPath);
    return false;
  } catch {
    return true;
  }
}
