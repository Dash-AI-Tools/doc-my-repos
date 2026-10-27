import { describe, expect, it } from "vitest";

import { AskGate } from "./ask/limits";
import { assetCacheKey, createAssetCache } from "./assets/cache";
import { createLimiter } from "./mcp/limits";

/**
 * In-process state that holds tenant data or tenant ids is keyed by tenant: user, token and
 * repository ids repeat across tenant databases (tenant-context "In-process state is partitioned
 * by tenant"). Process-wide caps still count every tenant.
 */
describe("in-process state per tenant", () => {
  it("does not refuse the same user id of another tenant as already answering", () => {
    const gate = new AskGate();
    const a = gate.tryEnter(1, 10, "tenant-a");
    expect(a.ok).toBe(true);
    expect(gate.tryEnter(1, 10, "tenant-a")).toEqual({ ok: false, reason: "user_busy" });
    const b = gate.tryEnter(1, 10, "tenant-b");
    expect(b.ok).toBe(true);
    expect(gate.active).toBe(2);
  });

  it("keeps the Ask gate's process-wide cap across tenants", () => {
    const gate = new AskGate();
    expect(gate.tryEnter(1, 1, "tenant-a").ok).toBe(true);
    expect(gate.tryEnter(2, 1, "tenant-b")).toEqual({ ok: false, reason: "server_busy" });
  });

  it("counts MCP calls per token of each tenant, and the process cap over all", () => {
    const limiter = createLimiter({ perToken: 1, inProcess: 2 });
    const a = limiter.acquire(5, "tenant-a");
    expect(a.ok).toBe(true);
    expect(limiter.acquire(5, "tenant-a")).toEqual({ ok: false, status: 429 });
    expect(limiter.acquire(5, "tenant-b").ok).toBe(true);
    expect(limiter.acquire(6, "tenant-c")).toEqual({ ok: false, status: 503 });
    if (a.ok) a.release();
    expect(limiter.acquire(5, "tenant-a").ok).toBe(true);
  });

  it("keeps two cache entries for the same repository path in two tenants", () => {
    const keyA = assetCacheKey("tenant-a", 101, "main", "docs/img.png");
    const keyB = assetCacheKey("tenant-b", 101, "main", "docs/img.png");
    expect(keyA).not.toBe(keyB);
    const cache = createAssetCache();
    const outcome = { kind: "not_found" } as never;
    cache.set(keyA, outcome);
    expect(cache.get(keyA)).toBeDefined();
    expect(cache.get(keyB)).toBeUndefined();
  });
});
