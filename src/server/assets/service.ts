import "server-only";

import { findAssetRepo } from "../queries/assets";
import { getRuntime } from "../runtime";
import { repoNameSelection } from "../sync/discovery";
import { createAssetCache, type AssetCache } from "./cache";
import type { AssetDeps } from "./serve";

/**
 * Binds the image proxy to the shared runtime (task 7.5). Kept apart from `route.ts` because a
 * Next.js route file may export only route fields, and so tests can replace it.
 */

const CACHE_KEY = Symbol.for("docmyrepos.assetCache");
type Cache = { [CACHE_KEY]?: AssetCache };

/** The process-wide asset cache (kept on `globalThis` across Next.js dev reloads). */
export function sharedAssetCache(): AssetCache {
  const cache = globalThis as Cache;
  cache[CACHE_KEY] ??= createAssetCache();
  return cache[CACHE_KEY];
}

/**
 * The proxy's dependencies over the shared runtime: the database (repository lookup through the
 * visibility filter), the current config selection, and the request-time GitHub client. Throws
 * `ConfigError` (names only, no values) when the runtime cannot be built.
 */
export function getAssetDeps(): AssetDeps {
  const runtime = getRuntime();
  return {
    findRepo: (owner, name) => findAssetRepo(runtime.db.db, owner, name),
    isConfigured: (name) => repoNameSelection(runtime.sync.config, name) === "selected",
    github: runtime.assets,
    cache: sharedAssetCache(),
  };
}
