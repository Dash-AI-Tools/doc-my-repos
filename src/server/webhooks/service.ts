import "server-only";

import { readWebhookSecret, type EnvSource } from "../config/env";
import { acknowledgeOnly, type WebhookDispatch } from "./endpoint";

/**
 * Binds the webhook handler to the environment and the event dispatcher (task 6.2). Kept apart
 * from `route.ts` because a Next.js route file may export only route fields, and so tests can
 * replace it.
 */

/** The configured webhook secret from the environment, or null. Reads no file and opens no connection. */
export function readConfiguredWebhookSecret(env: EnvSource = process.env): string | null {
  return readWebhookSecret(env)?.reveal() ?? null;
}

/**
 * The dispatcher for verified events. Until the event router (task 6.3) lands, every event is
 * acknowledged and ignored. It is called only after the signature is verified, so it may build
 * the runtime (`getRuntime()`) lazily.
 */
export function getWebhookDispatch(): WebhookDispatch {
  return acknowledgeOnly;
}
