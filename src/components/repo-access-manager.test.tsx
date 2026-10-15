// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepoAccessManager, type RepoAccessRow } from "./repo-access-manager";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const repos: RepoAccessRow[] = [
  { id: 1, owner: "acme", name: "api", visibility: "public", isAllowed: true, syncStatus: "ok" },
  {
    id: 2,
    owner: "acme",
    name: "web",
    visibility: "private",
    isAllowed: false,
    syncStatus: "error",
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockClear();
});

describe("RepoAccessManager", () => {
  it("filters by access and search", () => {
    render(<RepoAccessManager initialRepos={repos} />);
    fireEvent.click(screen.getByRole("button", { name: /Blocked/ }));
    expect(screen.queryByText("api")).toBeNull();
    expect(screen.getByText("web")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^All \d/ }));
    fireEvent.change(screen.getByLabelText("Search repositories"), { target: { value: "api" } });
    expect(screen.queryByText("web")).toBeNull();
  });

  it("blocks a repo and announces it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    render(<RepoAccessManager initialRepos={repos} />);
    fireEvent.click(screen.getByRole("button", { name: "Block acme/api" }));
    await waitFor(() => expect(screen.getByText("acme/api is blocked.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Allow acme/api" })).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the server error and keeps state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "Nope" }) }),
    );
    render(<RepoAccessManager initialRepos={repos} />);
    fireEvent.click(screen.getByRole("button", { name: "Block acme/api" }));
    await waitFor(() => expect(screen.getByText("Nope")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Block acme/api" })).toBeTruthy();
  });
});
