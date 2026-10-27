import "server-only";

import { findAssetRepo } from "../queries/assets";
import type { RequestContext } from "../app/types";
import { repoNameSelection } from "../sync/discovery";
import { requireGitHub } from "../workspace";
import { createAssetCache, type AssetCache } from "./cache";
import { createFetchGate, type FetchGate } from "./fetch-gate";
import type { AssetDeps } from "./serve";

/**
 * Binds the image proxy to the shared runtime (task 7.5). Kept apart from `route.ts` because a
 * Next.js route file may export only route fields, and so tests can replace it.
 */

const CACHE_KEY = Symbol.for("docmyrepos.assetCache");
const GATE_KEY = Symbol.for("docmyrepos.assetFetchGate");
type Cache = { [CACHE_KEY]?: AssetCache; [GATE_KEY]?: FetchGate };

/** The process-wide asset cache (kept on `globalThis` across Next.js dev reloads). */
export function sharedAssetCache(): AssetCache {
  const cache = globalThis as Cache;
  cache[CACHE_KEY] ??= createAssetCache();
  return cache[CACHE_KEY];
}

/** The process-wide limit on concurrent upstream fetches (also kept on `globalThis`). */
export function sharedFetchGate(): FetchGate {
  const holder = globalThis as Cache;
  holder[GATE_KEY] ??= createFetchGate();
  return holder[GATE_KEY];
}

/**
 * The proxy's dependencies over the current workspace: the database (repository lookup through the
 * visibility filter), the current selection, and the request-time GitHub client. Throws
 * `NotConfiguredError` (names only, no values) when the GitHub settings are incomplete.
 */
export async function getAssetDeps(ctx: RequestContext): Promise<AssetDeps> {
  const github = requireGitHub(await ctx.workspace());
  const db = await ctx.db();
  return {
    findRepo: (owner, name) => findAssetRepo(db, owner, name),
    isConfigured: (name) => repoNameSelection(github.sync.config, name) === "selected",
    github: github.assets,
    cache: sharedAssetCache(),
    gate: sharedFetchGate(),
    tenantId: ctx.tenant.id,
  };
}
