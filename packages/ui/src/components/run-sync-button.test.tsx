// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunSyncButton } from "./run-sync-button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<typeof fetch>();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const button = () => screen.getByRole("button", { name: /first sync|Syncing/ });

describe("RunSyncButton", () => {
  it("is disabled until the GitHub settings are saved", () => {
    render(<RunSyncButton canSync={false} />);
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the admin route, reports the count and refreshes", async () => {
    fetchMock.mockResolvedValue(json({ ok: true, repositories: [{}, {}] }));
    render(<RunSyncButton canSync />);
    fireEvent.click(button());
    await waitFor(() =>
      expect(screen.getByTestId("sync-result").textContent).toBe(
        "Sync finished: 2 repositories processed.",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/sync", { method: "POST" });
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the server's message when the sync fails", async () => {
    fetchMock.mockResolvedValue(
      json({ message: "The server is not configured for syncing." }, 500),
    );
    render(<RunSyncButton canSync />);
    fireEvent.click(button());
    await waitFor(() =>
      expect(screen.getByTestId("sync-result").textContent).toBe(
        "The server is not configured for syncing.",
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
