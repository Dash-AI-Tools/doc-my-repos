import { beforeEach, describe, expect, it, vi } from "vitest";

import { NAV_VIEW_COOKIE, PREFERENCE_MAX_AGE } from "@docmyrepos/core/internal/reading-prefs";

const store = {
  set: vi.fn(),
  delete: vi.fn(),
};
const origin: { current: string | null } = { current: "https://docs.example.com" };

vi.mock("next/headers", () => ({
  cookies: async () => store,
  headers: async () => new Headers(origin.current === null ? {} : { origin: origin.current }),
}));

const { setNavView } = await import("./nav-view-action");

function form(view?: string | Blob): FormData {
  const data = new FormData();
  if (view !== undefined) data.set("view", view);
  return data;
}

describe("setNavView", () => {
  beforeEach(() => {
    store.set.mockReset();
    store.delete.mockReset();
    origin.current = "https://docs.example.com";
  });

  it("stores Tree for a year, site-wide, HttpOnly and Secure on https", async () => {
    await setNavView(form("tree"));
    expect(store.delete).not.toHaveBeenCalled();
    expect(store.set).toHaveBeenCalledWith(NAV_VIEW_COOKIE, "tree", {
      path: "/",
      maxAge: PREFERENCE_MAX_AGE,
      sameSite: "lax",
      httpOnly: true,
      secure: true,
    });
  });

  it("is not Secure when posted from an http page or with no origin", async () => {
    origin.current = "http://localhost:3000";
    await setNavView(form("tree"));
    origin.current = null;
    await setNavView(form("tree"));
    expect(store.set.mock.calls.map((call) => call[2].secure)).toEqual([false, false]);
  });

  it("deletes the cookie for OKF, the default", async () => {
    await setNavView(form("okf"));
    expect(store.delete).toHaveBeenCalledWith(NAV_VIEW_COOKIE);
    expect(store.set).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["other case", "Tree"],
    ["garbage", "../../etc"],
    ["file", new Blob(["tree"])],
  ])("treats %s as OKF and deletes the cookie", async (_label, value) => {
    await setNavView(form(value));
    expect(store.delete).toHaveBeenCalledWith(NAV_VIEW_COOKIE);
    expect(store.set).not.toHaveBeenCalled();
  });
});
