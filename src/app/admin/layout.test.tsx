import { describe, expect, it, vi } from "vitest";

import AdminLayout from "./layout";

const userState = vi.hoisted(() => ({
  current: null as { email: string; role: "admin" | "user" } | null,
}));
vi.mock("@/server/auth/current-user", () => ({
  getCurrentUser: async () => userState.current,
}));

const redirectMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectMock(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

describe("admin layout", () => {
  it("redirects visitors without a session to /login", async () => {
    userState.current = null;
    redirectMock.mockClear();
    await expect(AdminLayout({ children: <p>child</p> })).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirectMock).toHaveBeenCalledWith("/login");
  });

  it("shows the access-denied panel to viewers", async () => {
    userState.current = { email: "viewer@example.com", role: "user" };
    const tree = (await AdminLayout({ children: <p>child</p> })) as React.ReactElement;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Access denied");
    expect(html).not.toContain("child");
  });

  it("renders the page for admins", async () => {
    userState.current = { email: "admin@example.com", role: "admin" };
    const tree = (await AdminLayout({ children: <p>child</p> })) as React.ReactElement;
    const { renderToStaticMarkup } = await import("react-dom/server");
    expect(renderToStaticMarkup(tree)).toContain("child");
  });
});
