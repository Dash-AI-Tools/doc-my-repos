// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RepoCardData } from "./repo-card";
import { RepoGrid } from "./repo-grid";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-10T12:00:00Z");

function repo(name: string, over: Partial<RepoCardData> = {}): RepoCardData {
  return {
    owner: "acme",
    name,
    description: `About ${name}`,
    visibility: "public",
    isOkf: false,
    okfVersion: null,
    syncStatus: "ok",
    syncError: null,
    lastSyncedAt: new Date("2026-10-09T12:00:00Z"),
    docCount: 3,
    ...over,
  };
}

afterEach(cleanup);

describe("RepoGrid", () => {
  it("lists public and private repositories together as list items under a heading", () => {
    render(
      <RepoGrid
        now={NOW}
        repos={[repo("open"), repo("secret", { visibility: "private" }), repo("later")]}
      />,
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Repositories (3)");
    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items.map((li) => within(li).getByRole("link").textContent)).toEqual([
      "acme/open",
      "acme/secret",
      "acme/later",
    ]);
    expect(screen.getAllByTestId("private-badge")).toHaveLength(1);
    expect(within(items[1] as HTMLElement).getByTestId("private-badge")).toBeTruthy();
  });

  it("is a ruled list: one column, two from md", () => {
    render(<RepoGrid now={NOW} repos={[repo("a")]} />);
    const cls = screen.getByRole("list").className;
    expect(cls).toContain("grid");
    expect(cls).toContain("md:grid-cols-2");
  });

  it("keeps heading order: h2 for the section, h3 for each card", () => {
    render(<RepoGrid now={NOW} repos={[repo("a"), repo("b")]} />);
    expect(screen.getAllByRole("heading").map((h) => h.tagName)).toEqual(["H2", "H3", "H3"]);
  });

  describe("Starred section", () => {
    it("lists starred repositories above Repositories, in the order given, with the same cards", () => {
      render(
        <RepoGrid
          now={NOW}
          starred={[repo("zed", { visibility: "private" }), repo("alpha")]}
          repos={[repo("rest")]}
        />,
      );
      expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
        "Starred (2)",
        "Repositories (1)",
      ]);
      const [starred, rest] = screen.getAllByRole("region");
      const names = (el: HTMLElement | undefined) =>
        within(el as HTMLElement)
          .getAllByRole("listitem")
          .map((li) => within(li).getByRole("link").textContent);
      expect(names(starred)).toEqual(["acme/zed", "acme/alpha"]);
      expect(names(rest)).toEqual(["acme/rest"]);
      // Same card markup, including the private badge.
      expect(within(starred as HTMLElement).getByTestId("private-badge")).toBeTruthy();
      expect(screen.getByRole("region", { name: /^Starred/ })).toBe(starred);
    });

    it("shows no Starred section when nothing is starred", () => {
      render(<RepoGrid now={NOW} starred={[]} repos={[repo("a")]} />);
      expect(screen.queryByText(/Starred/)).toBeNull();
      expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
        "Repositories (1)",
      ]);
    });

    it("omits the Repositories section when everything is starred", () => {
      render(<RepoGrid now={NOW} starred={[repo("a")]} repos={[]} />);
      expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
        "Starred (1)",
      ]);
      expect(screen.queryByText(/Repositories/)).toBeNull();
    });
  });
});
