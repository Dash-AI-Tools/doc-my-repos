---
type: Concept
title: Security model
description: Threat model for documents from third-party repositories. The sanitizer, CSP, Mermaid strict mode, the image proxy, webhook and sync authentication, secrets and the visibility filter, plus what is deliberately not covered.
tags: [architecture, security]
status: stable
sources:
  - src/server/markdown/sanitize.ts
  - src/lib/security-headers.ts
  - src/proxy.ts
  - src/server/assets/serve.ts
  - src/server/webhooks/verify.ts
  - src/server/sync/auth.ts
  - src/server/queries/visibility.ts
  - src/server/log.ts
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2999-01-01
---

# Security model

DocMyRepos renders Markdown that comes from repositories you do not fully control: a contributor, a dependency's docs folder, or a compromised account can put anything in a `docs/` file. **Documents are untrusted input.** The portal is behind a login with admin and user roles, but any signed-in user can read every visible repository, so the security work goes into two places: keeping hostile content from running in a reader's browser, and keeping credentials away from readers.

## Threats and controls

| Threat                                            | Control                                                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Script or event handler in a document             | Allow-list sanitizer as the last tree transform; scripts, `on*` attributes and unsafe URL schemes never reach the page            |
| Document executes code at render time             | `.mdx` files are rendered as plain Markdown; there is no MDX evaluation                                                           |
| Injected markup slips past a missed case          | Content-Security-Policy with a per-request nonce; no `unsafe-inline` or `eval` for scripts                                        |
| Diagram source abuses Mermaid                     | `securityLevel: 'strict'`, HTML labels off, a second allow-list over the returned SVG, image shapes refused                       |
| Image proxy used to read arbitrary files or hosts | Path validation, image-only extensions with signature check, only configured and visible repositories, only the default branch    |
| Forged webhook                                    | HMAC-SHA256 signature over the raw body, compared in constant time, before anything is parsed                                     |
| Unauthorized sync trigger                         | `POST /api/sync` needs `Authorization: Bearer <SYNC_SECRET>`, checked before the body is read                                     |
| Credential leak                                   | Secrets only from the environment, wrapped so they print as `[redacted]`, never sent to the browser, redacted again by the logger |
| A hidden repository showing up somewhere          | One visibility filter that every read of repositories, documents, search, facets and assets goes through                          |
| Runaway cost from a huge or hostile document      | Size and count caps at sync time, bounded parsing and rendering, caps on diagrams and highlighted code                            |

## Sanitizer

`src/server/markdown/sanitize.ts` is the XSS boundary. It runs in two steps inside one plugin that the pipeline always runs last: `rehype-sanitize` with a fixed allow-list, then a hardening pass. The processor is frozen after it, so no plugin can run afterwards. Plugin output (highlighting, link rewriting) is treated like document content and must fit the same allow-list.

- Forms, frames, embeds, `svg`, `math`, `style`, `script` and similar elements are dropped with their content.
- `id` is allowed only on headings and footnotes, never `name`, so a document cannot clobber `document.*` names. A heading id that is a sensitive DOM name is renamed with a `user-content-` prefix.
- `style` survives only on code highlighting spans, reduced to hex colors and font keywords.
- Links accept `http`, `https`, `mailto`, relative paths and fragments. External links get `rel="nofollow noopener noreferrer"` and no `target`.
- Images accept `http`, `https` and relative sources, never `data:` or `srcset`; external ones get `referrerpolicy="no-referrer"`.

A suite of about 150 XSS payloads is run through every container element in `src/server/markdown/xss.test.ts`.

## Content-Security-Policy and headers

`src/proxy.ts` makes a fresh nonce for every request and sets the headers from `src/lib/security-headers.ts` on pages and route handlers alike. The values, wrapped here for reading:

```http
Content-Security-Policy: default-src 'none'; script-src 'self' 'nonce-<nonce>' 'strict-dynamic';
  style-src 'self' 'unsafe-inline'; img-src 'self' https:; font-src 'self'; connect-src 'self';
  manifest-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none';
  base-uri 'none'; form-action 'self'
Referrer-Policy: same-origin
X-Content-Type-Options: nosniff
```

Also set: `X-Frame-Options: DENY`, a `Permissions-Policy` that denies everything except clipboard writes, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, and, over HTTPS in production, `Strict-Transport-Security` and `upgrade-insecure-requests`. Because of the nonce, every page is rendered per request and must not be cached by a CDN.

Two allowances are deliberate and worth knowing:

- **Styles allow `unsafe-inline`.** Shiki colors code with `style` attributes and Mermaid builds SVG with its own `<style>` elements in the browser, where a nonce cannot be attached. CSS cannot run script, but injected CSS could restyle a page. The sanitizer keeps documents from adding `<style>` or arbitrary `style` attributes.
- **`img-src` includes `https:`.** A document may embed an image hosted elsewhere. That host then sees the reader's IP address, not the page URL. Change `img-src` to `'self'` in `buildContentSecurityPolicy` to forbid it.

## Mermaid

Diagrams are drawn in the browser from a `<pre>` placeholder. Mermaid runs with `securityLevel: 'strict'`. Beyond that default, HTML labels are off, so label text is shown literally; the SVG that Mermaid returns passes through an allow-list before it is inserted; diagram source that uses image shapes is refused before rendering; and `%%{init}%%` directives cannot reopen these settings. A diagram that fails shows its source and the error. At most 20 diagrams of up to 50 KB each are rendered per document; the rest stay code blocks.

## Image proxy

Rendered documents point their repository images at `GET /api/asset/{owner}/{repo}/{path}`, which fetches the file from GitHub with the installation token, so images of private repositories work and no credential reaches the browser. The proxy checks, in this order. The first three checks look at the URL alone, so a refusal there says nothing about which repositories exist:

1. the method is `GET` or `HEAD`;
2. the path has no traversal, empty, dot-only or encoded-slash segments, and each segment is decoded exactly once;
3. the extension is on the image list (`png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `ico`, `svg`);
4. the repository is synced, visible through the shared filter, and still selected by configuration, otherwise `404`;
5. the downloaded bytes carry the signature of the type the extension claims, otherwise `415`. `Content-Type` comes from that verified type, never from GitHub.

SVG is served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, so opening it directly runs no script in the portal's origin. See the [HTTP API reference](../reference/api.md#get-apiassetownerrepopath) for status codes and caching.

## Authentication of machines

- **Webhooks.** `X-Hub-Signature-256` is verified over the raw request bytes with the webhook secret saved at `/admin/workspace` (stored encrypted, write-only). Only the `sha256=` form with 64 lowercase hex characters is accepted. A wrong or missing signature gets one fixed `401`, and no JSON is parsed before it passes. `node:crypto` is used instead of a library because hashing must see the exact bytes GitHub signed.
- **Manual sync.** `Authorization: Bearer <SYNC_SECRET>` only; the secret is never accepted in a query string or body. The app has no brute-force counter, so rate-limit this path at the reverse proxy.
- Both secrets must be at least 16 characters after trimming. The webhook secret is entered by an admin and stored encrypted; `SYNC_SECRET` stays in the environment.

## Secrets and logs

- The GitHub App is read-only (Contents and Metadata). Installation tokens are short-lived, held in memory and refreshed before they expire. The private key is revealed only when a token request is signed.
- Secrets are wrapped in a `Secret` type that prints as `[redacted]` in logs, JSON and `util.inspect`.
- The logger never serializes an error's message or stack, redacts values under credential-like keys, scrubs PEM blocks, bearer tokens, GitHub token shapes and JWTs from any text, and strips control characters so a value cannot forge a log line. Webhook log lines carry GitHub ids, never repository names, which a sender controls. See [Operations](../reference/operations.md#logs).

## Visibility filter

`visibleRepos` in `src/server/queries/visibility.ts` is the single filter. Every query for repositories, documents, search hits, facet counts and assets joins `repos` and applies it, and a static test fails when other code reads those tables. In the MVP the filter allows everything, because every synced repository is visible to every visitor. Per-viewer access later changes only that file.

## What is not covered

- **No login.** Anyone who can reach the portal can read everything it has synced. For private repositories, deploy privately or put an authenticating proxy in front.
- **No rate limiting in the app.** It only caps concurrent work. Rate-limit `/api/search`, `/api/sync` and `/api/status` at the proxy.
- **Shiki cannot be interrupted.** A pathological regular expression in a highlighted block could stall a render; blocks are capped at 100 KB, 200 per document.
- **Third-party image hosts** learn the reader's IP address, as described above.
