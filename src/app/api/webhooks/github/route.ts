import { handleWebhookRequest, methodNotAllowed } from "@/server/webhooks/endpoint";
import { getWebhookDispatch, readConfiguredWebhookSecret } from "@/server/webhooks/service";

/**
 * `POST /api/webhooks/github`: the GitHub App webhook. Every delivery must carry a valid
 * `X-Hub-Signature-256` computed with `GITHUB_WEBHOOK_SECRET` over the raw body. All logic lives in
 * `src/server/webhooks/endpoint.ts`.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return handleWebhookRequest(request, {
    readSecret: () => readConfiguredWebhookSecret(),
    dispatch: (event, payload, deliveryId) => getWebhookDispatch()(event, payload, deliveryId),
  });
}

// Every other method is refused with `Allow: POST`, without reading the request.
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
