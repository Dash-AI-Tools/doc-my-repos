// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModerationActions, type ModerationActionsProps } from "./moderation-actions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

let reply = { status: 200, json: {} as unknown };
const fetchMock = vi.fn();

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify(reply.json), { status: reply.status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  reply = { status: 200, json: {} };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function view(over: Partial<ModerationActionsProps> = {}) {
  return render(
    <ModerationActions
      action={{ kind: "purge-document", githubRepoId: 9, path: "docs/gone.md" }}
      buttonLabel="Remove all 3 comments of this document"
      subject="docs/gone.md"
      count={3}
      filters={{ state: null, githubRepoId: null, cursor: null }}
      {...over}
    />,
  );
}

describe("ModerationActions", () => {
  it("states the count before removing and sends nothing until confirmed", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /Remove all 3 comments/ }));
    expect(screen.getByText(/Permanently remove 3 comments/)).toBeTruthy();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels with the button and with Escape, returning focus", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /Remove all/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /Remove all/ })),
    );
    fireEvent.click(screen.getByRole("button", { name: /Remove all/ }));
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(screen.queryByRole("group")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("purges a document with a JSON write and goes to the page showing the count", async () => {
    reply = { status: 200, json: { removed: 3 } };
    view();
    fireEvent.click(screen.getByRole("button", { name: /Remove all/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove 3 comments" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/comments?removed=3"));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/comments/purge");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ githubRepoId: 9, path: "docs/gone.md" });
    expect(refresh).toHaveBeenCalled();
  });

  it("purges by ids", async () => {
    reply = { status: 200, json: { removed: 1 } };
    view({ action: { kind: "purge-ids", ids: [4] }, count: 1, buttonLabel: "Remove permanently" });
    fireEvent.click(screen.getByRole("button", { name: /Remove permanently/ }));
    expect(screen.getByText(/Permanently remove 1 comment /)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove 1 comment" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(
      JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string),
    ).toEqual({
      ids: [4],
    });
  });

  it("deletes with DELETE and reports a delete", async () => {
    view({
      action: { kind: "delete", id: 12 },
      buttonLabel: "Delete",
      subject: "ana",
      count: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete: ana" }));
    expect(screen.getByText(/Delete the comment by ana\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/comments?deleted=1"));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/comments/12");
    expect(init.method).toBe("DELETE");
  });

  it("shows a refusal and stays put", async () => {
    reply = { status: 409, json: { error: "not purgeable" } };
    view();
    fireEvent.click(screen.getByRole("button", { name: /Remove all/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove 3 comments" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/still live/);
    expect(push).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "Remove 3 comments" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    view();
    fireEvent.click(screen.getByRole("button", { name: /Remove all/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove 3 comments" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be sent/);
  });
});
