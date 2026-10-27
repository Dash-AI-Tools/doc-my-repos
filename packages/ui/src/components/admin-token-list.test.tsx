// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminTokenRow } from "@docmyrepos/core/internal/agent-access";

import { AdminTokenList } from "./admin-token-list";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const row = (over: Partial<AdminTokenRow> = {}): AdminTokenRow => ({
  id: 1,
  name: "laptop",
  prefix: "abcd1234",
  createdAt: "2026-10-01T10:00:00.000Z",
  expiresAt: "2026-12-30T10:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  status: "active",
  owner: { id: 5, email: "bob@example.com" },
  ...over,
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminTokenList", () => {
  it("shows each token's owner, name, prefix, expiry, last use and status, and no secret", () => {
    const { container } = render(
      <AdminTokenList
        initialTokens={[
          row({ id: 1, name: "laptop", owner: { id: 5, email: "bob@example.com" } }),
          row({
            id: 2,
            name: "ci",
            owner: { id: 6, email: "alice@example.com" },
            status: "expired",
          }),
        ]}
      />,
    );
    const items = screen.getAllByTestId("admin-token-item");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("bob@example.com");
    expect(items[0]!.textContent).toContain("laptop");
    expect(items[0]!.textContent).toContain("dmr_abcd1234…");
    expect(items[0]!.textContent).toContain("Never");
    expect(items[1]!.textContent).toContain("alice@example.com");
    expect(items[1]!.textContent).toContain("Expired");
    expect(container.textContent).not.toMatch(/dmr_[A-Za-z0-9_-]{20}/);
  });

  it("offers Revoke only for active tokens", () => {
    render(
      <AdminTokenList
        initialTokens={[
          row({ id: 1, name: "live" }),
          row({ id: 2, name: "old", status: "expired" }),
          row({ id: 3, name: "gone", status: "revoked", revokedAt: "2026-09-15T00:00:00.000Z" }),
        ]}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^Revoke / })).toHaveLength(1);
  });

  it("asks first, then revokes another user's token through the admin route", async () => {
    render(<AdminTokenList initialTokens={[row({ id: 9, name: "bobs laptop" })]} />);
    fetchMock.mockResolvedValueOnce(json({ revoked: true }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke bobs laptop" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
    await waitFor(() => expect(screen.getByTestId("token-status").textContent).toBe("Revoked"));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/tokens/9");
    expect(init?.method).toBe("DELETE");
    expect(screen.getByTestId("admin-tokens-message").textContent).toContain("bob@example.com");
  });

  it("removes a token the server no longer knows and says so", async () => {
    render(<AdminTokenList initialTokens={[row({ id: 9 })]} />);
    fetchMock.mockResolvedValueOnce(json({ error: "Not found" }, 404));
    fireEvent.click(screen.getByRole("button", { name: /^Revoke / }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
    expect((await screen.findByTestId("admin-tokens-error")).textContent).toMatch(
      /no longer exists/,
    );
    expect(screen.queryByTestId("admin-token-item")).toBeNull();
  });

  it("says when a revoke fails and when the connection does", async () => {
    render(<AdminTokenList initialTokens={[row({ id: 9 })]} />);
    fetchMock.mockResolvedValueOnce(json({ error: "Unavailable" }, 503));
    fireEvent.click(screen.getByRole("button", { name: /^Revoke / }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
    expect((await screen.findByTestId("admin-tokens-error")).textContent).toMatch(
      /could not be revoked/,
    );
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: /^Revoke / }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
    await waitFor(() =>
      expect(screen.getByTestId("admin-tokens-error").textContent).toMatch(/request failed/),
    );
    expect(screen.getByTestId("token-status").textContent).toBe("Active");
  });

  it("says when no token exists", () => {
    render(<AdminTokenList initialTokens={[]} />);
    expect(screen.getByTestId("admin-no-tokens").textContent).toMatch(/No tokens/);
  });
});
