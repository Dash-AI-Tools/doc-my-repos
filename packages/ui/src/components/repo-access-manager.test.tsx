// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepoAccessManager, type RepoAccessRow } from "./repo-access-manager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const row = (over: Partial<RepoAccessRow> & Pick<RepoAccessRow, "id" | "name">): RepoAccessRow => ({
  owner: "acme",
  visibility: "public",
  isAllowed: true,
  isPublic: false,
  starPosition: null,
  isStarred: false,
  folderId: null,
  syncStatus: "ok",
  ...over,
});

const repos: RepoAccessRow[] = [
  row({ id: 1, name: "api" }),
  row({ id: 2, name: "web", visibility: "private", isAllowed: false, syncStatus: "error" }),
];

/** Starred in the order handbook, guide, charter (not alphabetical). */
const starredRepos: RepoAccessRow[] = [
  row({ id: 10, name: "charter", starPosition: 2, isStarred: true }),
  row({ id: 11, name: "handbook", starPosition: 0, isStarred: true }),
  row({ id: 12, name: "guide", starPosition: 1, isStarred: true, isAllowed: false }),
  row({ id: 13, name: "zeta" }),
];

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number, error: string) => ({
  ok: false,
  status,
  json: async () => ({ error }),
});

/** The names listed in a region, in order. */
function names(region: HTMLElement): string[] {
  return within(region)
    .getAllByRole("listitem")
    .map((li) => li.querySelector("span.font-medium")?.textContent?.replace("acme/", "") ?? "");
}
const starredRegion = () => screen.getByRole("region", { name: /^Starred/ });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockClear();
});

describe("RepoAccessManager public access", () => {
  const conflict = {
    ok: false,
    status: 409,
    json: async () => ({
      error: "This repository is private on GitHub",
      code: "confirm_private",
      privateRepos: 1,
    }),
    clone() {
      return this;
    },
  };

  it("names the switch after the repository and reports its state", () => {
    render(
      <RepoAccessManager
        initialRepos={[repos[0]!, row({ id: 3, name: "open", isPublic: true })]}
      />,
    );
    expect(
      (screen.getByRole("switch", { name: "Public access for acme/api" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      (screen.getByRole("switch", { name: "Public access for acme/open" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("turns a repository public and announces it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        ok({ repo: { isAllowed: true, isPublic: true, starPosition: null, folderId: null } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<RepoAccessManager initialRepos={[repos[0]!]} />);
    fireEvent.click(screen.getByRole("switch", { name: "Public access for acme/api" }));
    await waitFor(() => expect(screen.getByText(/acme\/api is public/)).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      owner: "acme",
      name: "api",
      isPublic: true,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("asks before publishing a GitHub-private repository and sends the confirmation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(conflict)
      .mockResolvedValueOnce(
        ok({ repo: { isAllowed: true, isPublic: true, starPosition: null, folderId: null } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RepoAccessManager initialRepos={[row({ id: 5, name: "secret", visibility: "private" })]} />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Public access for acme/secret" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("private on GitHub");
    fireEvent.click(within(alert).getByRole("button", { name: "Confirm and make public" }));
    await waitFor(() => expect(screen.getByText(/acme\/secret is public/)).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      owner: "acme",
      name: "secret",
      isPublic: true,
      confirmPrivate: true,
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("changes nothing when the confirmation is cancelled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(conflict);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RepoAccessManager initialRepos={[row({ id: 5, name: "secret", visibility: "private" })]} />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Public access for acme/secret" }));
    fireEvent.click(
      within(await screen.findByRole("alert")).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("switch", { name: "Public access for acme/secret" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it("shows a failure and keeps the switch off", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(403, "Forbidden")));
    render(<RepoAccessManager initialRepos={[repos[0]!]} />);
    fireEvent.click(screen.getByRole("switch", { name: "Public access for acme/api" }));
    await waitFor(() => expect(screen.getByText("Forbidden")).toBeTruthy());
    expect(
      (screen.getByRole("switch", { name: "Public access for acme/api" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ok({ repo: { isAllowed: false, starPosition: null } })),
    );
    render(<RepoAccessManager initialRepos={repos} />);
    fireEvent.click(screen.getByRole("button", { name: "Block acme/api" }));
    await waitFor(() => expect(screen.getByText("acme/api is blocked.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Allow acme/api" })).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the server error and keeps state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(400, "Nope")));
    render(<RepoAccessManager initialRepos={repos} />);
    fireEvent.click(screen.getByRole("button", { name: "Block acme/api" }));
    await waitFor(() => expect(screen.getByText("Nope")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Block acme/api" })).toBeTruthy();
  });

  describe("starring", () => {
    it("has no Starred group when nothing is starred, and a pressable Star button per row", () => {
      render(<RepoAccessManager initialRepos={repos} />);
      expect(screen.queryByRole("region", { name: /^Starred/ })).toBeNull();
      const star = screen.getByRole("button", { name: "Star acme/api" });
      expect(star.getAttribute("aria-pressed")).toBe("false");
      expect(star.textContent).toContain("Star");
    });

    it("stars a repo: it joins the Starred group at the place the server gave", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(ok({ repo: { isAllowed: true, starPosition: 0 } }));
      vi.stubGlobal("fetch", fetchMock);
      render(<RepoAccessManager initialRepos={repos} />);
      fireEvent.click(screen.getByRole("button", { name: "Star acme/api" }));
      await waitFor(() => expect(screen.getByText("acme/api is starred.")).toBeTruthy());
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/repos",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ owner: "acme", name: "api", isStarred: true }),
        }),
      );
      expect(names(starredRegion())).toEqual(["api"]);
      expect(
        within(starredRegion())
          .getByRole("button", { name: "Star acme/api" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(refresh).toHaveBeenCalled();
    });

    it("can be activated from the keyboard (a real button: Enter and Space click it)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(ok({ repo: { isAllowed: true, starPosition: 0 } })),
      );
      render(<RepoAccessManager initialRepos={repos} />);
      const star = screen.getByRole("button", { name: "Star acme/api" });
      expect(star.tagName).toBe("BUTTON");
      expect((star as HTMLButtonElement).type).toBe("button");
      star.focus();
      expect(document.activeElement).toBe(star);
      fireEvent.click(star); // what Enter/Space on a focused button dispatches
      await waitFor(() => expect(screen.getByText("acme/api is starred.")).toBeTruthy());
    });

    it("unstars a repo back into the list", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(ok({ repo: { isAllowed: true, starPosition: null } })),
      );
      render(<RepoAccessManager initialRepos={starredRepos} />);
      fireEvent.click(within(starredRegion()).getByRole("button", { name: "Star acme/handbook" }));
      await waitFor(() =>
        expect(screen.getByText("acme/handbook is no longer starred.")).toBeTruthy(),
      );
      expect(names(starredRegion())).toEqual(["guide", "charter"]);
    });

    it("keeps the previous state and shows the error when starring fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(404, "repo not found")));
      render(<RepoAccessManager initialRepos={repos} />);
      fireEvent.click(screen.getByRole("button", { name: "Star acme/api" }));
      await waitFor(() => expect(screen.getByText("repo not found")).toBeTruthy());
      expect(screen.queryByRole("region", { name: /^Starred/ })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Star acme/api" }).getAttribute("aria-pressed"),
      ).toBe("false");
    });

    it("keeps a blocked starred repo in the Starred group, marked blocked", () => {
      render(<RepoAccessManager initialRepos={starredRepos} />);
      expect(names(starredRegion())).toEqual(["handbook", "guide", "charter"]);
      const guide = within(starredRegion()).getAllByRole("listitem")[1] as HTMLElement;
      expect(within(guide).getByText("Blocked")).toBeTruthy();
      // Not in the other list, whatever the filter.
      fireEvent.click(screen.getByRole("button", { name: /Blocked/ }));
      expect(names(starredRegion())).toEqual(["handbook", "guide", "charter"]);
    });
  });

  describe("ordering with Up and Down", () => {
    it("moves a row up, sends the whole list in the new order and keeps it", async () => {
      const fetchMock = vi.fn().mockResolvedValue(ok({ repos: [] }));
      vi.stubGlobal("fetch", fetchMock);
      render(<RepoAccessManager initialRepos={starredRepos} />);
      fireEvent.click(screen.getByRole("button", { name: "Move up acme/guide" }));
      // Optimistic: the order changes at once.
      expect(names(starredRegion())).toEqual(["guide", "handbook", "charter"]);
      await waitFor(() => expect(screen.getByText("Starred order saved.")).toBeTruthy());
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/repos/starred", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repos: [
            { owner: "acme", name: "guide" },
            { owner: "acme", name: "handbook" },
            { owner: "acme", name: "charter" },
          ],
        }),
      });
      expect(names(starredRegion())).toEqual(["guide", "handbook", "charter"]);
      expect(refresh).toHaveBeenCalled();
    });

    it("moves a row down", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ repos: [] })));
      render(<RepoAccessManager initialRepos={starredRepos} />);
      fireEvent.click(screen.getByRole("button", { name: "Move down acme/handbook" }));
      expect(names(starredRegion())).toEqual(["guide", "handbook", "charter"]);
      await waitFor(() => expect(screen.getByText("Starred order saved.")).toBeTruthy());
    });

    it("omits Move up on the first row and Move down on the last", () => {
      render(<RepoAccessManager initialRepos={starredRepos} />);
      expect(screen.queryByRole("button", { name: "Move up acme/handbook" })).toBeNull();
      expect(screen.getByRole("button", { name: "Move down acme/handbook" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Move down acme/charter" })).toBeNull();
      expect(screen.getByRole("button", { name: "Move up acme/charter" })).toBeTruthy();
    });

    it("offers no moves for a single starred repo", () => {
      render(<RepoAccessManager initialRepos={[starredRepos[1] as RepoAccessRow]} />);
      expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    });

    for (const [status, message] of [
      [409, "The starred list changed; reload and try again"],
      [500, "Internal error"],
    ] as const) {
      it(`restores the previous order and shows the error on a ${status}`, async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(status, message)));
        render(<RepoAccessManager initialRepos={starredRepos} />);
        fireEvent.click(screen.getByRole("button", { name: "Move up acme/guide" }));
        await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
        expect(names(starredRegion())).toEqual(["handbook", "guide", "charter"]);
        expect(refresh).not.toHaveBeenCalled();
      });
    }

    it("restores the previous order when the request cannot be made", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
      render(<RepoAccessManager initialRepos={starredRepos} />);
      fireEvent.click(screen.getByRole("button", { name: "Move down acme/handbook" }));
      await waitFor(() => expect(screen.getByText("Could not reach the server.")).toBeTruthy());
      expect(names(starredRegion())).toEqual(["handbook", "guide", "charter"]);
    });

    it("pauses moves while a reorder is in flight", async () => {
      let finish: (value: unknown) => void = () => {};
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((resolve) => (finish = resolve))));
      render(<RepoAccessManager initialRepos={starredRepos} />);
      fireEvent.click(screen.getByRole("button", { name: "Move down acme/handbook" }));
      await waitFor(() =>
        expect(
          (screen.getByRole("button", { name: "Move up acme/charter" }) as HTMLButtonElement)
            .disabled,
        ).toBe(true),
      );
      await act(async () => finish(ok({ repos: [] })));
      await waitFor(() =>
        expect(
          (screen.getByRole("button", { name: "Move up acme/charter" }) as HTMLButtonElement)
            .disabled,
        ).toBe(false),
      );
    });
  });

  it("names every star, handle and move control after its repository", () => {
    render(<RepoAccessManager initialRepos={starredRepos} />);
    const region = starredRegion();
    for (const name of ["handbook", "guide", "charter"]) {
      const label = `acme/${name}`;
      expect(within(region).getByRole("button", { name: `Reorder ${label}` })).toBeTruthy();
      expect(within(region).getByRole("button", { name: `Star ${label}` })).toBeTruthy();
    }
  });

  describe("folder control (optional)", () => {
    const folders = [
      { id: 5, name: "Payments" },
      { id: 6, name: "Ops" },
    ];

    it("shows no folder control when there are no folders", () => {
      render(<RepoAccessManager initialRepos={repos} />);
      expect(screen.queryByLabelText(/^Folder for/)).toBeNull();
    });

    it("offers No folder and each folder, labelled by repo, showing the current one", () => {
      render(
        <RepoAccessManager
          initialRepos={[{ ...repos[0]!, folderId: 6 }, repos[1]!]}
          folders={folders}
        />,
      );
      const select = screen.getByLabelText("Folder for acme/api") as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toEqual([
        "No folder",
        "Payments",
        "Ops",
      ]);
      expect(select.value).toBe("6");
      expect((screen.getByLabelText("Folder for acme/web") as HTMLSelectElement).value).toBe("");
    });

    it("assigns, moves and clears a folder through PATCH, announcing each", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(ok({ repo: { isAllowed: true, starPosition: null, folderId: 5 } }))
        .mockResolvedValueOnce(ok({ repo: { isAllowed: true, starPosition: null, folderId: 6 } }))
        .mockResolvedValueOnce(
          ok({ repo: { isAllowed: true, starPosition: null, folderId: null } }),
        );
      vi.stubGlobal("fetch", fetchMock);
      render(<RepoAccessManager initialRepos={repos} folders={folders} />);
      const select = () => screen.getByLabelText("Folder for acme/api") as HTMLSelectElement;
      fireEvent.change(select(), { target: { value: "5" } });
      await waitFor(() => expect(screen.getByText("acme/api is in Payments.")).toBeTruthy());
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/admin/repos",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ owner: "acme", name: "api", folderId: 5 }),
        }),
      );
      expect(select().value).toBe("5");
      fireEvent.change(select(), { target: { value: "6" } });
      await waitFor(() => expect(select().value).toBe("6"));
      fireEvent.change(select(), { target: { value: "" } });
      await waitFor(() => expect(screen.getByText("acme/api is in no folder.")).toBeTruthy());
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/admin/repos",
        expect.objectContaining({
          body: JSON.stringify({ owner: "acme", name: "api", folderId: null }),
        }),
      );
      expect(select().value).toBe("");
      expect(refresh).toHaveBeenCalledTimes(3);
    });

    it("keeps the old folder and shows the error when the change fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(404, "folder not found")));
      render(
        <RepoAccessManager initialRepos={[{ ...repos[0]!, folderId: 5 }]} folders={folders} />,
      );
      const select = screen.getByLabelText("Folder for acme/api") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "6" } });
      await waitFor(() => expect(screen.getByText("folder not found")).toBeTruthy());
      expect(select.value).toBe("5");
    });

    it("follows the folder list: a folder that is gone shows as No folder, new ones appear", () => {
      const initial = [{ ...repos[0]!, folderId: 5 }];
      const { rerender } = render(<RepoAccessManager initialRepos={initial} folders={folders} />);
      rerender(
        <RepoAccessManager
          initialRepos={initial}
          folders={[folders[1]!, { id: 7, name: "New" }]}
        />,
      );
      const select = screen.getByLabelText("Folder for acme/api") as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toEqual(["No folder", "Ops", "New"]);
      expect(select.value).toBe("");
    });
  });
});
