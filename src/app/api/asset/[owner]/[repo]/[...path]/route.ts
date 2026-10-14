import { handleAssetRequest } from "@/server/assets/serve";
import { getAssetDeps } from "@/server/assets/service";

/**
 * `GET|HEAD /api/asset/{owner}/{repo}/{path}`: the image proxy (task 7.5). Rendered documents
 * point their repository images here (`src/server/markdown/images.ts`); the image is fetched from
 * GitHub server-side with the installation token, which never reaches the browser.
 *
 * All logic lives in `src/server/assets/serve.ts`. The path is read from `request.url`, not from
 * the route params, so it is percent-decoded exactly once there. Caching is done with response
 * headers and an in-memory cache, never by Next.js.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return handleAssetRequest(request, getAssetDeps);
}

export const HEAD = GET;

// Every other method is refused with `Allow: GET, HEAD` before anything is looked up.
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
