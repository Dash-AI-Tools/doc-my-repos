import type { RequestContext } from "../app/types";
import { handleAssetRequest } from "../assets/serve";
import type { RouteContext } from "./index";
import { getAssetDeps } from "../assets/service";
import { readerOf } from "../public-access/reader";

/**
 * `GET|HEAD /api/asset/{owner}/{repo}/{path}`: the image proxy (task 7.5). Rendered documents
 * point their repository images here (`packages/server/src/markdown/images.ts`); the image is fetched from
 * GitHub server-side with the installation token, which never reaches the browser.
 *
 * All logic lives in `packages/server/src/assets/serve.ts`. The path is read from `request.url`, not from
 * the route params, so it is percent-decoded exactly once there. Caching is done with response
 * headers and an in-memory cache, never by Next.js.
 */

export function GET(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleAssetRequest(request, async () => getAssetDeps(ctx, await readerOf(ctx)));
}

export const HEAD = GET;

// Every other method is refused with `Allow: GET, HEAD` before anything is looked up.
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
