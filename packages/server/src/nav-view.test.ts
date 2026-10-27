import { beforeEach, describe, expect, it, vi } from "vitest";

import { NAV_VIEW_COOKIE } from "@docmyrepos/core/internal/reading-prefs";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

const { readNavView } = await import("./nav-view");

describe("readNavView", () => {
  beforeEach(() => jar.clear());

  it("is OKF with no cookie", async () => {
    expect(await readNavView()).toBe("okf");
  });

  it("is Tree with the tree cookie", async () => {
    jar.set(NAV_VIEW_COOKIE, "tree");
    expect(await readNavView()).toBe("tree");
  });

  it.each(["", "TREE", "okf", "garbage", "tree; x=1"])("is OKF for %j", async (value) => {
    jar.set(NAV_VIEW_COOKIE, value);
    expect(await readNavView()).toBe("okf");
  });
});
