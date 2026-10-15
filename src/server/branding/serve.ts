/**
 * Public logo route (org-branding 2.5): `GET /api/branding/logo`. Served without a session
 * (the sign-in page shows it), so it carries no repository data, only the branding bytes.
 * Headers mirror the asset proxy: verified `Content-Type`, `nosniff`, sandbox CSP (SVG
 * additionally allows inline styles), `Cross-Origin-Resource-Policy`, `Referrer-Policy`,
 * a strong `ETag` with 304, and an immutable cache only for a matching versioned URL.
 */

import { CONTENT_TYPES } from "../assets/image-types";
import { assetEtag, etagMatches } from "../assets/serve";
import { getDb, type Db } from "../db/client";
import { getLogo } from "./index";

const BASE_CSP = "default-src 'none'; sandbox";
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const LOGO_CONTENT_TYPES = {
  png: CONTENT_TYPES.png,
  jpeg: CONTENT_TYPES.jpeg,
  webp: CONTENT_TYPES.webp,
  svg: CONTENT_TYPES.svg,
} as const;

/** The one public branding path. Nothing else under `/api/branding/` is public. */
export const LOGO_PATH = "/api/branding/logo";

export async function handleLogoRequest(request: Request, db: Db | null = null): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }
  const logo = await getLogo(db ?? getDb().db);
  if (!logo) {
    return new Response("Not found.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const contentType = LOGO_CONTENT_TYPES[logo.type as keyof typeof LOGO_CONTENT_TYPES];
  if (!contentType) {
    return new Response("Not found.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const bytes = new Uint8Array(logo.bytes);
  const etag = assetEtag(bytes);
  const versioned = new URL(request.url).searchParams.get("v") === String(logo.version);
  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-security-policy": logo.type === "svg" ? SVG_CSP : BASE_CSP,
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    etag,
    "cache-control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=300",
  };
  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": headers["cache-control"] ?? "" },
    });
  }
  return new Response(request.method === "HEAD" ? null : bytes, { status: 200, headers });
}
