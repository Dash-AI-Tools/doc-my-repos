// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TokenRow } from "@docmyrepos/core/internal/agent-access";

import { AgentAccess } from "./agent-access";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<typeof fetch>();
const writeText = vi.fn<(text: string) => Promise<void>>();
const TOKEN = `dmr_${"Zq8".repeat(14)}Zq`;

const row = (over: Partial<TokenRow> = {}): TokenRow => ({
  id: 1,
  name: "laptop",
  prefix: "abcd1234",
  createdAt: "2026-10-01T10:00:00.000Z",
  expiresAt: "2026-12-30T10:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  status: "active",
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const view = (tokens: TokenRow[] = []) =>
  render(<AgentAccess initialTokens={tokens} maxActive={10} />);
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create token" }));

async function createToken(name = "laptop") {
  fetchMock.mockResolvedValueOnce(
    json({ token: TOKEN, view: row({ id: 7, name, prefix: TOKEN.slice(4, 12) }) }, 201),
  );
  type(screen.getByLabelText("Token name"), name);
  submit();
  await screen.findByTestId("new-token");
}

describe("AgentAccess: connection help", () => {
  it("shows the MCP address from the page's origin and copyable snippets with a placeholder", () => {
    const { container } = view();
    expect(screen.getByTestId("mcp-address").textContent).toBe(`${window.location.origin}/api/mcp`);
    const text = container.textContent ?? "";
    expect(text).toContain("claude mcp add --transport http docmyrepos");
    expect(text).toContain('"mcpServers"');
    expect(text).toContain("Bearer YOUR_TOKEN");
    expect(text).not.toMatch(/dmr_[A-Za-z0-9_-]{20}/);
    expect(screen.getByRole("button", { name: "Copy address" })).toBeDefined();
  });

  it("copies the address and says so", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/api/mcp`),
    );
    await screen.findByText("Copied.");
  });
});

describe("AgentAccess: creating a token", () => {
  it("sends the name and the chosen expiry", async () => {
    view();
    type(screen.getByLabelText("Token name"), "ci agent");
    type(screen.getByLabelText("Expires after"), "30");
    fetchMock.mockResolvedValueOnce(json({ token: TOKEN, view: row() }, 201));
    submit();
    await screen.findByTestId("new-token");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/account/tokens");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "ci agent", expiryDays: 30 });
  });

  it("defaults to 90 days and offers 30 days, 90 days and 1 year", () => {
    view();
    const select = screen.getByLabelText("Expires after") as HTMLSelectElement;
    expect(select.value).toBe("90");
    expect(Array.from(select.options).map((o) => o.text)).toEqual(["30 days", "90 days", "1 year"]);
  });

  it("shows the full token once, with a warning, a copy control and snippets that carry it", async () => {
    view();
    await createToken("my laptop");
    const panel = screen.getByTestId("new-token");
    expect((within(panel).getByLabelText("Token") as HTMLInputElement).value).toBe(TOKEN);
    expect(within(panel).getByRole("alert").textContent).toMatch(/only time it is shown/);
    expect(panel.textContent).toContain(`Bearer ${TOKEN}`);
    // The generic snippets elsewhere on the page still carry the placeholder.
    expect(screen.getAllByText(/Bearer YOUR_TOKEN/).length).toBeGreaterThan(0);

    fireEvent.click(within(panel).getByRole("button", { name: "Copy token" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TOKEN));
  });

  it("lists the new token without its secret and empties the name field", async () => {
    view();
    await createToken("my laptop");
    const items = screen.getAllByTestId("token-item");
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("my laptop");
    expect(items[0]!.textContent).toContain(`dmr_${TOKEN.slice(4, 12)}…`);
    expect(items[0]!.textContent).not.toContain(TOKEN);
    expect((screen.getByLabelText("Token name") as HTMLInputElement).value).toBe("");
  });

  it("drops the token for good when the user says it is saved", async () => {
    const { container } = view();
    await createToken();
    expect(container.innerHTML).toContain(TOKEN);
    fireEvent.click(screen.getByRole("button", { name: "I have saved the token" }));
    expect(screen.queryByTestId("new-token")).toBeNull();
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(container.textContent).not.toMatch(/Bearer dmr_/);
  });

  it("never shows the token again after a reload: a fresh render holds only token rows", async () => {
    const first = view();
    await createToken("laptop");
    first.unmount();
    // What the page sends after a reload: the rows from the server, with no secret in them.
    const { container } = view([row({ id: 7, name: "laptop", prefix: TOKEN.slice(4, 12) })]);
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(screen.queryByTestId("new-token")).toBeNull();
    expect(container.textContent).toContain("Bearer YOUR_TOKEN");
  });

  it("keeps the token out of the URL, local storage and session storage", async () => {
    const before = window.location.href;
    view();
    await createToken();
    expect(window.location.href).toBe(before);
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
    expect((screen.getByLabelText("Token") as HTMLInputElement).autocomplete).toBe("off");
  });

  it("moves focus to the new token for keyboard and screen reader users", async () => {
    view();
    await createToken();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("new-token")));
  });

  it("names the problem when the server refuses the input, and shows no token", async () => {
    const { container } = view();
    fetchMock.mockResolvedValueOnce(
      json({ error: "name: must be 1 to 60 plain-text characters" }, 400),
    );
    submit();
    const alert = await screen.findByTestId("agent-access-error");
    expect(alert.textContent).toBe("name: must be 1 to 60 plain-text characters");
    expect(screen.queryByTestId("new-token")).toBeNull();
    expect(container.innerHTML).not.toMatch(/dmr_[A-Za-z0-9_-]{20}/);
  });

  it("shows the limit message when ten tokens are active", async () => {
    view();
    fetchMock.mockResolvedValueOnce(
      json({ error: "limit: at most 10 active tokens; revoke one first" }, 409),
    );
    type(screen.getByLabelText("Token name"), "one more");
    submit();
    expect((await screen.findByTestId("agent-access-error")).textContent).toMatch(/limit/);
  });

  it("says when the request fails and lets the user try again", async () => {
    view();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    type(screen.getByLabelText("Token name"), "x");
    submit();
    expect((await screen.findByTestId("agent-access-error")).textContent).toMatch(/request failed/);
    expect(
      (screen.getByRole("button", { name: "Create token" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("limits the name field to 60 characters", () => {
    view();
    expect((screen.getByLabelText("Token name") as HTMLInputElement).maxLength).toBe(60);
  });
});

describe("AgentAccess: the list", () => {
  it("shows name, prefix, expiry, last use and status for each token", () => {
    view([
      row({ id: 1, name: "laptop", lastUsedAt: "2026-10-10T08:00:00.000Z" }),
      row({ id: 2, name: "old", status: "expired", expiresAt: "2026-09-01T00:00:00.000Z" }),
      row({ id: 3, name: "gone", status: "revoked", revokedAt: "2026-09-15T00:00:00.000Z" }),
    ]);
    const items = screen.getAllByTestId("token-item");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain("dmr_abcd1234…");
    expect(items[0]!.textContent).toContain("30 Dec 2026, 10:00 UTC");
    expect(items[0]!.textContent).toContain("10 Oct 2026, 08:00 UTC");
    expect(items[0]!.textContent).toContain("Active");
    expect(items[1]!.textContent).toContain("Expired");
    expect(items[1]!.textContent).toContain("Never");
    expect(items[2]!.textContent).toContain("Revoked");
    expect(screen.getByText(/1 of 10 active/)).toBeDefined();
  });

  it("offers Revoke only for an active token", () => {
    view([
      row({ id: 1, name: "live" }),
      row({ id: 2, name: "old", status: "expired" }),
      row({ id: 3, name: "gone", status: "revoked", revokedAt: "2026-09-15T00:00:00.000Z" }),
    ]);
    expect(screen.getAllByRole("button", { name: /^Revoke / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Revoke live" })).toBeDefined();
  });

  it("says when there are no tokens", () => {
    view();
    expect(screen.getByTestId("no-tokens").textContent).toMatch(/no tokens yet/);
  });
});

describe("AgentAccess: revoking", () => {
  it("asks first, and Cancel changes nothing and sends nothing", () => {
    view([row({ id: 4, name: "laptop" })]);
    fireEvent.click(screen.getByRole("button", { name: "Revoke laptop" }));
    expect(screen.getByRole("group", { name: "Confirm revoking laptop" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Revoke laptop" })).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("token-status").textContent).toBe("Active");
  });

  it("revokes after confirming: sends DELETE, shows Revoked and a notice, drops the button", async () => {
    view([row({ id: 4, name: "laptop" })]);
    fetchMock.mockResolvedValueOnce(json({ revoked: true }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke laptop" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
    await waitFor(() => expect(screen.getByTestId("token-status").textContent).toBe("Revoked"));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/account/tokens/4");
    expect(init?.method).toBe("DELETE");
    expect(screen.getByTestId("agent-access-message").textContent).toMatch(/Revoked “laptop”/);
    expect(screen.queryByRole("button", { name: /^Revoke / })).toBeNull();
    expect(screen.getByText(/0 of 10 active/)).toBeDefined();
  });

  it("removes a token the server no longer knows and says so", async () => {
    view([row({ id: 4, name: "laptop" })]);
    fetchMock.mockResolvedValueOnce(json({ error: "Not found" }, 404));
    fireEvent.click(screen.getByRole("button", { name: "Revoke laptop" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
    expect((await screen.findByTestId("agent-access-error")).textContent).toMatch(
      /no longer exists/,
    );
    expect(screen.queryByTestId("token-item")).toBeNull();
  });

  it("keeps the token active and says so when revoking fails", async () => {
    view([row({ id: 4, name: "laptop" })]);
    fetchMock.mockResolvedValueOnce(json({ error: "Unavailable" }, 503));
    fireEvent.click(screen.getByRole("button", { name: "Revoke laptop" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, revoke" }));
    expect((await screen.findByTestId("agent-access-error")).textContent).toMatch(
      /could not be revoked/,
    );
    expect(screen.getByTestId("token-status").textContent).toBe("Active");
  });

  it("never uses a browser dialog", () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    view([row({ id: 4, name: "laptop" })]);
    fireEvent.click(screen.getByRole("button", { name: "Revoke laptop" }));
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("AgentAccess: structure", () => {
  it("labels every control and uses native elements", () => {
    view([row()]);
    for (const control of [...screen.getAllByRole("textbox"), ...screen.getAllByRole("combobox")]) {
      expect(control.id, "control has an id for its label").not.toBe("");
      expect(document.querySelector(`label[for="${control.id}"]`)).not.toBeNull();
    }
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(
      expect.arrayContaining(["Connect an agent", "Create a token", "Your tokens"]),
    );
  });
});
