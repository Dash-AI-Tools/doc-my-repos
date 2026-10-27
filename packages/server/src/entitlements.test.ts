import { describe, expect, it } from "vitest";

import { commentsEnabled, mcpEnabled, type Workspace } from "./workspace";

/**
 * A feature the tenant is not entitled to (`checkEntitlement`) is off, exactly as when an
 * administrator turned it off; with the entitlement, the setting decides as before. Ask, which
 * also needs provider keys, is covered end to end by the contract suite.
 */
function source(settings: { mcp: boolean; comments: boolean }, entitled: boolean) {
  const workspace = {
    config: { mcp: { enabled: settings.mcp }, comments: { enabled: settings.comments } },
  } as unknown as Workspace;
  return { workspace: async () => workspace, entitled: async () => entitled };
}

describe("feature switches with entitlements", () => {
  it("are off when the tenant is not entitled, even with the setting on", async () => {
    const ctx = source({ mcp: true, comments: true }, false);
    expect(await mcpEnabled(ctx)).toBe(false);
    expect(await commentsEnabled(ctx)).toBe(false);
  });

  it("follow the setting when the tenant is entitled", async () => {
    expect(await mcpEnabled(source({ mcp: true, comments: false }, true))).toBe(true);
    expect(await commentsEnabled(source({ mcp: true, comments: false }, true))).toBe(false);
  });
});
