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
  /** A slot for one more call by `tokenId`, or the status to refuse with. */
  acquire(tokenId: number): Acquired;
  /** Calls running now, for tests. */
  readonly inFlight: () => number;
}

export function createLimiter(
  limits: { perToken: number; inProcess: number } = {
    perToken: MAX_PER_TOKEN,
    inProcess: MAX_IN_PROCESS,
  },
): Limiter {
  const perToken = new Map<number, number>();
  let total = 0;
  return {
    acquire(tokenId) {
      if ((perToken.get(tokenId) ?? 0) >= limits.perToken) return { ok: false, status: 429 };
      if (total >= limits.inProcess) return { ok: false, status: 503 };
      perToken.set(tokenId, (perToken.get(tokenId) ?? 0) + 1);
      total += 1;
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          total -= 1;
          const left = (perToken.get(tokenId) ?? 1) - 1;
          if (left <= 0) perToken.delete(tokenId);
          else perToken.set(tokenId, left);
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
