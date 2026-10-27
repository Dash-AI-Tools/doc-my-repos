import type { APIRequestContext } from "@playwright/test";

import { fakeProviderUrl } from "./stack";

/**
 * Client of the fake model provider's control API (see `packages/server/src/ask/testing/fake-provider.ts`),
 * for the Ask e2e specs. The provider is one process shared by all specs, so a spec that scripts
 * it runs serially.
 */

export type Behavior =
  | { kind: "text"; chunks: readonly string[]; usage?: { input: number; output: number } }
  | { kind: "slow"; chunks: readonly string[]; delayMs: number }
  | { kind: "stall"; chunks?: readonly string[] }
  | { kind: "status"; status: number; body?: string }
  | { kind: "cut_off"; chunks: readonly string[] };

export interface ProviderRequest {
  readonly protocol: "anthropic" | "openai";
  readonly path: string;
  readonly stream: boolean;
  readonly aborted: boolean;
  readonly body: {
    readonly model?: string;
    readonly messages?: readonly { role: string; content: string }[];
  };
  readonly hasAuthorization: boolean;
}

/** The reply to the search-query call: a JSON array of keyword queries. */
export const queries = (...q: string[]): Behavior => ({
  kind: "text",
  chunks: [JSON.stringify(q)],
});

export async function resetProvider(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${fakeProviderUrl}/__control/reset`);
  if (!response.ok()) throw new Error(`fake provider reset failed (${response.status()})`);
}

/** What the next requests get: `query` for the non-streaming search-query call, `answer` for the stream. */
export async function script(
  request: APIRequestContext,
  phases: { query?: Behavior; answer?: Behavior },
): Promise<void> {
  const response = await request.post(`${fakeProviderUrl}/__control/phases`, { data: phases });
  if (!response.ok()) throw new Error(`fake provider script failed (${response.status()})`);
}

export async function providerRequests(request: APIRequestContext): Promise<ProviderRequest[]> {
  const response = await request.get(`${fakeProviderUrl}/__control/requests`);
  return (await response.json()) as ProviderRequest[];
}
