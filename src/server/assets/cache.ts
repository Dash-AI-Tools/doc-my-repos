import type { ImageType } from "./image-types";

/**
 * In-memory cache of recent image proxy outcomes (task 7.5), so a page view or a popular image
 * does not cost a GitHub request each time. Per process, bounded, and short-lived:
 *
 * - Keyed by GitHub repository id, default branch and exact path (`assetCacheKey`). The id is
 *   GitHub's, never the requested owner/name spelling, so two repositories can never share an
 *   entry, and a renamed repository keeps its entries.
 * - Images live `ttlMs` (default 5 minutes, equal to the browser `max-age`); refusals that only
 *   change when the repository changes (missing file, not an image, too large) live
 *   `negativeTtlMs` (default 1 minute). Upstream failures (rate limit, 5xx, network) are never
 *   cached.
 * - Total image bytes are capped (`maxBytes`, default 32 MiB) and entries are capped
 *   (`maxEntries`); the least recently used entry is evicted first.
 * - Removal: the proxy looks the repository up in the database (through the visibility filter)
 *   before reading the cache, so a removed, excluded or hidden repository is refused at once; a
 *   file deleted upstream keeps being served until its entry expires (at most `ttlMs`). Nothing
 *   else invalidates entries.
 */

export type AssetOutcome =
  | {
      readonly kind: "image";
      readonly type: ImageType;
      readonly bytes: Uint8Array<ArrayBuffer>;
      /** Our strong ETag, quoted. */
      readonly etag: string;
    }
  | { readonly kind: "refused"; readonly status: 404 | 413 | 415 };

export interface AssetCache {
  get(key: string): AssetOutcome | undefined;
  set(key: string, outcome: AssetOutcome): void;
  clear(): void;
  /** Entries and image bytes currently held. */
  stats(): { entries: number; bytes: number };
}

export interface AssetCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
  ttlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
}

export const DEFAULT_ASSET_CACHE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_ASSET_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_ASSET_NEGATIVE_TTL_MS = 60 * 1000;
export const DEFAULT_ASSET_CACHE_ENTRIES = 4096;

export function assetCacheKey(githubId: number, branch: string, path: string): string {
  return `${githubId}\u0000${branch}\u0000${path}`;
}

interface Entry {
  readonly outcome: AssetOutcome;
  readonly expiresAt: number;
  readonly size: number;
}

const sizeOf = (outcome: AssetOutcome): number =>
  outcome.kind === "image" ? outcome.bytes.byteLength : 0;

export function createAssetCache(options: AssetCacheOptions = {}): AssetCache {
  const maxBytes = options.maxBytes ?? DEFAULT_ASSET_CACHE_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_ASSET_CACHE_ENTRIES;
  const ttlMs = options.ttlMs ?? DEFAULT_ASSET_CACHE_TTL_MS;
  const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_ASSET_NEGATIVE_TTL_MS;
  const now = options.now ?? Date.now;
  // A Map iterates in insertion order: re-inserting on use keeps the oldest first.
  const entries = new Map<string, Entry>();
  let bytes = 0;

  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    bytes -= entry.size;
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now()) {
        remove(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.outcome;
    },
    set(key, outcome) {
      const size = sizeOf(outcome);
      remove(key);
      if (size > maxBytes || maxEntries <= 0) return;
      const ttl = outcome.kind === "image" ? ttlMs : negativeTtlMs;
      entries.set(key, { outcome, expiresAt: now() + ttl, size });
      bytes += size;
      for (const oldest of entries.keys()) {
        if (bytes <= maxBytes && entries.size <= maxEntries) break;
        remove(oldest);
      }
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    stats: () => ({ entries: entries.size, bytes }),
  };
}
