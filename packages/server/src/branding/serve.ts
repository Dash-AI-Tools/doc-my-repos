/**
 * Public logo route (org-branding 2.5): `GET /api/branding/logo`. Served without a session
 * (the sign-in page shows it), so it carries no repository data, only the branding bytes.
 * Headers mirror the asset proxy: verified `Content-Type`, `nosniff`, sandbox CSP (SVG
 * additionally allows inline styles), `Cross-Origin-Resource-Policy`, `Referrer-Policy`,
 * a strong `ETag` with 304, and an immutable cache only for a matching versioned URL.
 */

import { CONTENT_TYPES } from "../assets/image-types";
import { assetEtag, etagMatches } from "../assets/serve";
import type { DbSource } from "../db/client";
import { columnLogoStore, logoTypeOf, readBrandingSettings, type LogoStore } from "./index";

const BASE_CSP = "default-src 'none'; sandbox";
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** The one public branding path. Nothing else under `/api/branding/` is public. */
export const LOGO_PATH = "/api/branding/logo";

/**
 * `logo` is the tenant's logo in its blob store (default: the `site_branding` row). Only the logo
 * image types are ever served, whatever the store returns; the version comes from the row.
 */
export async function handleLogoRequest(
  request: Request,
  db: DbSource,
  logo: LogoStore = columnLogoStore(db),
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }
  const blob = await logo.get();
  const type = blob === null ? null : logoTypeOf(blob.contentType);
  if (blob === null || type === null) {
    return new Response("Not found.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const { logoVersion } = await readBrandingSettings(await db());
  const bytes = new Uint8Array(blob.bytes);
  const etag = assetEtag(bytes);
  const versioned = new URL(request.url).searchParams.get("v") === String(logoVersion);
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES[type],
    "content-security-policy": type === "svg" ? SVG_CSP : BASE_CSP,
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
