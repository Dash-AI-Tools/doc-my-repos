import { DEFAULT_TENANT_ID } from "@docmyrepos/core";

/**
 * Concurrency limits for the MCP endpoint (mcp-agent-access spec `mcp-server`, "Limits and
 * failures"): at most 4 calls running per token and 16 in the process. Held in memory, so with
 * several server instances each enforces its own (rate limiting by client belongs in the reverse
 * proxy, as for search). A call takes a slot after its token is verified and gives it back when it
 * ends, whatever the outcome.
 */

export const MAX_PER_TOKEN = 4;
export const MAX_IN_PROCESS = 16;

export type Acquired =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly status: 429 | 503 };

export interface Limiter {
  /**
   * A slot for one more call by token `tokenId` of tenant `tenantId` (token ids repeat across
   * tenant databases), or the status to refuse with. The in-process cap counts every tenant.
   */
  acquire(tokenId: number, tenantId?: string): Acquired;
  /** Calls running now, for tests. */
  readonly inFlight: () => number;
}

export function createLimiter(
  limits: { perToken: number; inProcess: number } = {
    perToken: MAX_PER_TOKEN,
    inProcess: MAX_IN_PROCESS,
  },
): Limiter {
  const perToken = new Map<string, number>();
  let total = 0;
  return {
    acquire(tokenId, tenantId = DEFAULT_TENANT_ID) {
      const key = `${tenantId}:${tokenId}`;
      if ((perToken.get(key) ?? 0) >= limits.perToken) return { ok: false, status: 429 };
      if (total >= limits.inProcess) return { ok: false, status: 503 };
      perToken.set(key, (perToken.get(key) ?? 0) + 1);
      total += 1;
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          total -= 1;
          const left = (perToken.get(key) ?? 1) - 1;
          if (left <= 0) perToken.delete(key);
          else perToken.set(key, left);
        },
      };
    },
    inFlight: () => total,
  };
}

const KEY = Symbol.for("docmyrepos.mcp.limiter");

/** The process-wide limiter; kept on `globalThis` so a dev-server reload does not reset it. */
export function sharedLimiter(): Limiter {
  const store = globalThis as { [KEY]?: Limiter };
  return (store[KEY] ??= createLimiter());
}
