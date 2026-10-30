// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FolderManager, type FolderRow } from "./folder-manager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number, error: string) => ({
  ok: false,
  status,
  json: async () => ({ error }),
});

const folder = (over: Partial<FolderRow> & Pick<FolderRow, "id" | "name">): FolderRow => ({
  description: null,
  starPosition: null,
  isStarred: false,
  isPublic: false,
  ...over,
});

const alpha = folder({ id: 1, name: "Alpha", description: "First <b>one</b>" });
const beta = folder({ id: 2, name: "Beta" });
const starredA = folder({ id: 3, name: "Pay", starPosition: 0, isStarred: true });
const starredB = folder({ id: 4, name: "Ops", starPosition: 1, isStarred: true });

const items = () => screen.getAllByRole("listitem");
/** Folder names in list order (the first text node of each row's name line). */
const order = () => items().map((li) => li.querySelector("p")?.firstChild?.textContent?.trim());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockClear();
});

describe("FolderManager public access", () => {
  const conflict = (privateRepos: number) => ({
    ok: false,
    status: 409,
    json: async () => ({
      error: `This folder holds ${privateRepos} repositories that are private on GitHub`,
      code: "confirm_private",
      privateRepos,
    }),
    clone() {
      return this;
    },
  });

  it("names the switch after the folder and reports its state", () => {
    render(
      <FolderManager
        initialFolders={[alpha, folder({ id: 9, name: "Open", isPublic: true })]}
        counts={{}}
      />,
    );
    expect(
      (screen.getByRole("switch", { name: "Public access for Alpha" }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByRole("switch", { name: "Public access for Open" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("turns a folder public and announces it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ folder: { ...alpha, isPublic: true } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FolderManager initialFolders={[alpha]} counts={{}} />);
    fireEvent.click(screen.getByRole("switch", { name: "Public access for Alpha" }));
    await waitFor(() => expect(screen.getByText(/Alpha is public/)).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ isPublic: true });
    expect(
      (screen.getByRole("switch", { name: "Public access for Alpha" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(refresh).toHaveBeenCalled();
  });

  it("asks before publishing GitHub-private repositories, and sends the confirmation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(conflict(2))
      .mockResolvedValueOnce(ok({ folder: { ...alpha, isPublic: true } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FolderManager initialFolders={[alpha]} counts={{}} />);
    fireEvent.click(screen.getByRole("switch", { name: "Public access for Alpha" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("2 repositories that are private on GitHub");
    expect(
      (screen.getByRole("switch", { name: "Public access for Alpha" }) as HTMLInputElement).checked,
    ).toBe(false);
    fireEvent.click(within(alert).getByRole("button", { name: "Confirm and make public" }));
    await waitFor(() => expect(screen.getByText(/Alpha is public/)).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      isPublic: true,
      confirmPrivate: true,
    });
  });

  it("changes nothing when the confirmation is cancelled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(conflict(1));
    vi.stubGlobal("fetch", fetchMock);
    render(<FolderManager initialFolders={[alpha]} counts={{}} />);
    fireEvent.click(screen.getByRole("switch", { name: "Public access for Alpha" }));
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a standing note while a public folder holds GitHub-private repositories", () => {
    render(
      <FolderManager
        initialFolders={[
          folder({ id: 9, name: "Open", isPublic: true, privateRepoCount: 2 }),
          folder({ id: 10, name: "Closed", privateRepoCount: 3 }),
        ]}
        counts={{}}
      />,
    );
    expect(screen.getAllByText(/private on\s+GitHub, readable by anyone/)).toHaveLength(1);
  });

  it("shows a failure and keeps the folder as it was", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(403, "Forbidden")));
    render(<FolderManager initialFolders={[alpha]} counts={{}} />);
    fireEvent.click(screen.getByRole("switch", { name: "Public access for Alpha" }));
    await waitFor(() => expect(screen.getByText("Forbidden")).toBeTruthy());
    expect(
      (screen.getByRole("switch", { name: "Public access for Alpha" }) as HTMLInputElement).checked,
    ).toBe(false);
  });
});

describe("FolderManager", () => {
  it("says folders are optional and shows an empty state with a create form", () => {
    render(<FolderManager initialFolders={[]} counts={{}} />);
    expect(screen.getByText(/Folders are optional/)).toBeTruthy();
    expect(screen.getByText("No folders yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create folder" })).toBeTruthy();
  });

  it("lists folders with counts, description as text, starred first in tab order", () => {
    render(
      <FolderManager initialFolders={[alpha, beta, starredB, starredA]} counts={{ 1: 2, 3: 1 }} />,
    );
    expect(order()).toEqual(["Pay", "Ops", "Alpha", "Beta"]);
    expect(screen.getByText("First <b>one</b>")).toBeTruthy();
    expect(within(items()[2]!).getByText("2 repositories")).toBeTruthy();
    expect(within(items()[0]!).getByText("1 repository")).toBeTruthy();
    expect(within(items()[3]!).getByText("0 repositories")).toBeTruthy();
  });

  it("creates a folder and clears the form", async () => {
    const created = folder({ id: 9, name: "New", description: "d" });
    const fetchMock = vi.fn().mockResolvedValue(ok({ folder: created }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FolderManager initialFolders={[]} counts={{}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "d" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(screen.getByText("Created New.")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/folders",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "New", description: "d" }),
      }),
    );
    expect(screen.getByText("New")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows a duplicate-name error and keeps the form and list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fail(409, "A folder with that name already exists")),
    );
    render(<FolderManager initialFolders={[alpha]} counts={{}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(screen.getByText(/already exists/)).toBeTruthy());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("alpha");
    expect(items()).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("edits a folder inline and cancels without a request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(ok({ folder: { ...alpha, name: "Alpha 2", description: null } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FolderManager initialFolders={[alpha]} counts={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit Alpha" }));
    const form = screen.getByRole("button", { name: "Save" }).closest("form")!;
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Alpha 2" } });
    fireEvent.change(within(form).getByLabelText(/Description/), { target: { value: "" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved Alpha 2.")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/folders/1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "Alpha 2", description: "" }),
      }),
    );
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("stars and unstars with aria-pressed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ folder: { ...alpha, isStarred: true, starPosition: 0 } }))
      .mockResolvedValueOnce(ok({ folder: { ...alpha, isStarred: false, starPosition: null } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FolderManager initialFolders={[alpha]} counts={{}} />);
    const star = () => screen.getByRole("button", { name: "Star Alpha" });
    expect(star().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(star());
    await waitFor(() => expect(star().getAttribute("aria-pressed")).toBe("true"));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/admin/folders/1",
      expect.objectContaining({ body: JSON.stringify({ isStarred: true }) }),
    );
    fireEvent.click(star());
    await waitFor(() => expect(star().getAttribute("aria-pressed")).toBe("false"));
  });

  it("offers Up and Down on starred folders only, omitted at the ends", () => {
    render(<FolderManager initialFolders={[starredA, starredB, alpha]} counts={{}} />);
    expect(screen.queryByRole("button", { name: "Move up Pay" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move down Pay" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move up Ops" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move down Ops" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Move (up|down) Alpha/ })).toBeNull();
  });

  it("moves a starred folder by sending the whole list, and shows the new order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ folderIds: [4, 3] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FolderManager initialFolders={[starredA, starredB]} counts={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Move up Ops" }));
    await waitFor(() => expect(screen.getByText("Tab order saved.")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/folders/starred",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ folderIds: [4, 3] }) }),
    );
    expect(order()).toEqual(["Ops", "Pay"]);
  });

  it("keeps the old order and shows the error on a stale reorder (409)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fail(409, "The starred list changed; reload and try again")),
    );
    render(<FolderManager initialFolders={[starredA, starredB]} counts={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Move down Pay" }));
    await waitFor(() => expect(screen.getByText(/starred list changed/)).toBeTruthy());
    expect(order()).toEqual(["Pay", "Ops"]);
  });

  it("deletes only after confirmation, naming the folder and its repository count", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FolderManager initialFolders={[alpha, beta]} counts={{ 1: 3 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    expect(screen.getByText(/Delete Alpha\?/).textContent).toContain("Its 3 repositories move");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm delete Alpha" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Alpha" }));
    await waitFor(() => expect(screen.getByText(/Deleted Alpha/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/folders/1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(items()).toHaveLength(1);
  });

  it("keeps the folder when the delete request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<FolderManager initialFolders={[alpha]} counts={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Alpha" }));
    await waitFor(() => expect(screen.getByText("Could not reach the server.")).toBeTruthy());
    expect(items()).toHaveLength(1);
  });

  it("takes over fresh folders and counts after a refresh", () => {
    const { rerender } = render(<FolderManager initialFolders={[alpha]} counts={{ 1: 1 }} />);
    rerender(<FolderManager initialFolders={[{ ...alpha, name: "Renamed" }]} counts={{ 1: 4 }} />);
    expect(screen.getByText("Renamed")).toBeTruthy();
    expect(screen.getByText("4 repositories")).toBeTruthy();
  });
});
