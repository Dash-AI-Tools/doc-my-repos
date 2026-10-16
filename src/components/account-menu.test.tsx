// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountMenu } from "./account-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({ pathname: "/" }));
const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => route.pathname,
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  push.mockReset();
  refresh.mockReset();
  route.pathname = "/";
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function panel(): HTMLElement {
  return screen.getByTestId("account-menu");
}

describe("AccountMenu", () => {
  it("opens on the email and reports expanded", () => {
    render(<AccountMenu user={{ email: "admin@example.com", role: "admin" }} />);
    const trigger = screen.getByTestId("account-menu-trigger");
    expect(panel().hasAttribute("hidden")).toBe(true);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel().hasAttribute("hidden")).toBe(false);
  });

  it("closes on Escape and returns focus to the email", () => {
    render(<AccountMenu user={{ email: "admin@example.com", role: "admin" }} />);
    const trigger = screen.getByTestId("account-menu-trigger");
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel().hasAttribute("hidden")).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on an outside pointer press", () => {
    render(<AccountMenu user={{ email: "admin@example.com", role: "admin" }} />);
    fireEvent.click(screen.getByTestId("account-menu-trigger"));
    fireEvent.pointerDown(document.body);
    expect(panel().hasAttribute("hidden")).toBe(true);
  });

  it("closes when the route changes", () => {
    const { rerender } = render(
      <AccountMenu user={{ email: "admin@example.com", role: "admin" }} />,
    );
    fireEvent.click(screen.getByTestId("account-menu-trigger"));
    route.pathname = "/admin";
    rerender(<AccountMenu user={{ email: "admin@example.com", role: "admin" }} />);
    expect(panel().hasAttribute("hidden")).toBe(true);
  });

  it("closes when an admin link is activated", () => {
    render(<AccountMenu user={{ email: "admin@example.com", role: "admin" }} />);
    fireEvent.click(screen.getByTestId("account-menu-trigger"));
    fireEvent.click(screen.getByRole("link", { name: "Users" }));
    expect(panel().hasAttribute("hidden")).toBe(true);
  });

  it("tabs through the trigger, the admin links, then Sign out", () => {
    const { container } = render(
      <AccountMenu user={{ email: "admin@example.com", role: "admin" }} />,
    );
    fireEvent.click(screen.getByTestId("account-menu-trigger"));
    // Document order is the Tab order (nothing carries a tabindex).
    expect(
      [...container.querySelectorAll("button, a")].map((el) => el.textContent?.trim()),
    ).toEqual([
      "admin@example.com",
      "Users",
      "Repository access",
      "Ask",
      "GitHub configuration",
      "Branding",
      "Sign out",
    ]);
  });

  it("shows the admin links to an admin and none to a viewer", () => {
    render(<AccountMenu user={{ email: "admin@example.com", role: "admin" }} />);
    fireEvent.click(screen.getByTestId("account-menu-trigger"));
    expect(screen.getByRole("link", { name: "Users" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Repository access" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "GitHub configuration" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ask" }).getAttribute("href")).toBe("/admin/ask");
    expect(screen.getByRole("link", { name: "Branding" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Administration" })).toBeNull();
    cleanup();
    render(<AccountMenu user={{ email: "viewer@example.com", role: "user" }} />);
    fireEvent.click(screen.getByTestId("account-menu-trigger"));
    expect(screen.queryByRole("link", { name: "Branding" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("signs out through the API and lands on the login page", async () => {
    render(<AccountMenu user={{ email: "admin@example.com", role: "admin" }} />);
    fireEvent.click(screen.getByTestId("account-menu-trigger"));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(refresh).toHaveBeenCalled();
  });
});
