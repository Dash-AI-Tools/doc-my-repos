import { describe, expect, it, vi } from "vitest";

import { DEFAULT_TENANT, EXTENSION_API_VERSION } from "@docmyrepos/core";

import type { Plugin, RequestContext } from "../app/types";
import { recordingLogger } from "../test-logger";
import { coreSlotItems, resolveSlot } from "./slots";

const ALL = { askEnabled: true, agentAccess: true };
const NONE = { askEnabled: false, agentAccess: false };

describe("the core's slot items", () => {
  it("are today's header navigation", () => {
    expect(coreSlotItems("header.nav", NONE)).toEqual([{ href: "/", label: "Repositories" }]);
    expect(coreSlotItems("header.nav", ALL)).toEqual([
      { href: "/", label: "Repositories" },
      { href: "/ask", label: "Ask" },
    ]);
  });

  it("are today's account menu: the admin pages, then the agent pages while MCP is on", () => {
    expect(coreSlotItems("account.menu", NONE)).toEqual([
      { href: "/admin/users", label: "Users", adminOnly: true },
      { href: "/admin/workspace", label: "Workspace configuration", adminOnly: true },
      { href: "/admin/branding", label: "Branding", adminOnly: true },
    ]);
    expect(coreSlotItems("account.menu", ALL).map((item) => item.href)).toEqual([
      "/admin/users",
      "/admin/workspace",
      "/admin/branding",
      "/admin/tokens",
      "/account/agent-access",
    ]);
  });

  it("are today's admin home sections, in order", () => {
    expect(coreSlotItems("admin.sections", ALL).map((item) => item.label)).toEqual([
      "Users",
      "Repository access",
      "Comments",
      "AI agent tokens",
      "Workspace configuration",
      "Branding",
    ]);
    expect(coreSlotItems("admin.sections", NONE).map((item) => item.label)).not.toContain(
      "AI agent tokens",
    );
  });

  it("are today's footer link, and nothing for tabs and banners", () => {
    expect(coreSlotItems("footer.links", NONE)).toEqual([
      { href: "/status", label: "Sync status" },
    ]);
    expect(coreSlotItems("admin.workspace.tabs", ALL)).toEqual([]);
    expect(coreSlotItems("layout.banner", ALL)).toEqual([]);
  });
});

describe("resolveSlot", () => {
  const rec = recordingLogger();
  const ctx = { tenant: DEFAULT_TENANT, log: rec.log } as unknown as RequestContext;
  const plugin = (id: string, slots: Plugin["slots"]): Plugin => ({
    id,
    apiVersion: EXTENSION_API_VERSION,
    slots,
  });

  it("puts the core's items first, then each plugin's in order, and drops a throwing one", async () => {
    const plugins = [
      plugin("billing", { "header.nav": () => ({ href: "/-/billing", label: "Billing" }) }),
      plugin("broken", {
        "header.nav": () => {
          throw new Error("contribution failed sk_live_1");
        },
      }),
      plugin("none", { "header.nav": async () => null }),
      plugin("docs", { "header.nav": async () => [{ href: "/-/docs/a", label: "A" }] }),
    ];
    const items = await resolveSlot({ plugins }, "header.nav", ctx, NONE);
    expect(items.map((item) => item.label)).toEqual(["Repositories", "Billing", "A"]);
    expect(rec.find("plugin.failed")).toEqual([
      expect.objectContaining({ plugin: "broken", slot: "header.nav" }),
    ]);
    expect(rec.lines.join("")).not.toContain("sk_live_1");
  });

  it("asks each contribution with the request context", async () => {
    const contribution = vi.fn(() => null);
    await resolveSlot(
      { plugins: [plugin("x", { "layout.banner": contribution })] },
      "layout.banner",
      ctx,
      NONE,
    );
    expect(contribution).toHaveBeenCalledWith(ctx);
  });
});
