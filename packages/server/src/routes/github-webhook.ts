import type { JsonValue } from "@docmyrepos/core";

import type { RequestContext } from "../app/types";
import { handleWebhookRequest, methodNotAllowed } from "../webhooks/endpoint";
import { readConfiguredWebhookSecret } from "../webhooks/service";
import type { RouteContext } from "./index";

/**
 * `POST /api/webhooks/github`: the GitHub App webhook. The delivery is resolved to a tenant first
 * (`resolveTenant`, on a copy of the request), then verified with that tenant's webhook secret
 * over the raw body, then handed to the `webhook.dispatch` job, which ignores an installation that
 * is not the tenant's. The answer waits up to 5 s for an in-process job and is 202 at once for a
 * queued one. All request handling lives in `packages/server/src/webhooks/endpoint.ts`.
 */
export function POST(
  request: Request,
  _route: RouteContext | undefined,
  ctx: RequestContext,
): Promise<Response> {
  return handleWebhookRequest(request, {
    readSecret: () => readConfiguredWebhookSecret(() => ctx.workspace()),
    log: ctx.log,
    dispatch: async (event, payload, deliveryId) => {
      const { done } = await ctx.adapters.jobs.submit({
        name: "webhook.dispatch",
        // The verified body, parsed from JSON, so it is JSON.
        payload: { tenantId: ctx.tenant.id, event, payload: payload as JsonValue, deliveryId },
      });
      await done;
    },
  });
}

// Every other method is refused with `Allow: POST`, without reading the request.
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
