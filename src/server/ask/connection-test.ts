import type { ProviderCredentials } from "../config/env";
import { ProviderError, createProvider, type ProviderDeps } from "./providers";

/**
 * The admin "Test" button (ask-the-docs design decision 9): one fixed, tiny request through the same
 * adapter real questions use, with the environment credentials. The outcome is one of five fixed
 * words; provider text, URLs and keys never leave this module.
 */

export type ConnectionResult = "ok" | "rejected" | "not_found" | "unavailable" | "timeout";

export const TEST_PROMPT = "Reply with the single word OK.";
export const TEST_MAX_TOKENS = 8;
export const TEST_DEADLINE_MS = 15_000;

export interface ConnectionTestOptions {
  readonly deadlineMs?: number;
  readonly providerDeps?: ProviderDeps;
}

export function connectionResultFor(error: unknown): ConnectionResult {
  if (!(error instanceof ProviderError)) return "unavailable";
  switch (error.kind) {
    case "rejected":
      return "rejected";
    case "not_found":
      return "not_found";
    case "timeout":
      return "timeout";
    default:
      return "unavailable";
  }
}

/** Sends the fixed request and reports whether the provider accepted the model. Never throws. */
export async function testConnection(
  credentials: ProviderCredentials,
  model: string,
  options: ConnectionTestOptions = {},
): Promise<ConnectionResult> {
  try {
    const adapter = createProvider(credentials, model, options.providerDeps);
    await adapter.completeOnce([{ role: "user", content: TEST_PROMPT }], {
      maxTokens: TEST_MAX_TOKENS,
      deadlineMs: options.deadlineMs ?? TEST_DEADLINE_MS,
    });
    return "ok";
  } catch (error) {
    return connectionResultFor(error);
  }
}

/** At most `limit` attempts per `windowMs` in this process (the admin test is not a hot path). */
export class AttemptWindow {
  private readonly times: number[] = [];

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  attempt(): { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number } {
    const now = this.now();
    while (this.times.length > 0 && now - this.times[0]! >= this.windowMs) this.times.shift();
    if (this.times.length >= this.limit) {
      const wait = Math.ceil((this.times[0]! + this.windowMs - now) / 1000);
      return { ok: false, retryAfterSeconds: Math.max(1, wait) };
    }
    this.times.push(now);
    return { ok: true };
  }
}

/** The limiter of this server process: 5 tests per minute. */
export const testAttempts = new AttemptWindow();
