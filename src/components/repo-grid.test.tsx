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

  it("is responsive: one column, two from sm, three from lg", () => {
    render(<RepoGrid now={NOW} repos={[repo("a")]} />);
    const cls = screen.getByRole("list").className;
    expect(cls).toContain("grid");
    expect(cls).toContain("sm:grid-cols-2");
    expect(cls).toContain("lg:grid-cols-3");
  });

  it("keeps heading order: h2 for the section, h3 for each card", () => {
    render(<RepoGrid now={NOW} repos={[repo("a"), repo("b")]} />);
    expect(screen.getAllByRole("heading").map((h) => h.tagName)).toEqual(["H2", "H3", "H3"]);
  });
});
