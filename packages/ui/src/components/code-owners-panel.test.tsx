// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CodeOwnersPanel, COLLAPSE_AFTER } from "./code-owners-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const user = (handle: string) => ({ handle, kind: "user" as const });
const team = (handle: string) => ({ handle, kind: "team" as const });
const email = (handle: string) => ({ handle, kind: "email" as const });

function groups() {
  return screen.getAllByTestId("owner-group");
}

describe("CodeOwnersPanel, spec scenario 'Owners with patterns'", () => {
  // CODEOWNERS: `* @alice` and `/docs/ @my-org/docs-team`
  const rules = [
    { pattern: "*", owners: [user("@alice")] },
    { pattern: "/docs/", owners: [team("@my-org/docs-team")] },
  ];

  it("lists @alice covering * and @my-org/docs-team covering /docs/", () => {
    render(<CodeOwnersPanel rules={rules} />);
    expect(screen.getByRole("heading", { level: 2, name: /Code owners/ })).toBeTruthy();
    const [alice, docsTeam] = groups();
    expect(alice).toBeDefined();
    expect(docsTeam).toBeDefined();

    expect(within(alice as HTMLElement).getByText("@alice")).toBeTruthy();
    const alicePatterns = within(alice as HTMLElement).getAllByRole("listitem");
    expect(alicePatterns.map((li) => li.textContent)).toEqual(["*"]);
    expect(within(alice as HTMLElement).getByText("User")).toBeTruthy();

    expect(within(docsTeam as HTMLElement).getByText("@my-org/docs-team")).toBeTruthy();
    expect(
      within(docsTeam as HTMLElement)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["/docs/"]);
    expect(within(docsTeam as HTMLElement).getByText("Team")).toBeTruthy();
  });

  it("links the user to the profile and the team to the team page, without the @", () => {
    render(<CodeOwnersPanel rules={rules} />);
    const alice = screen.getByRole("link", { name: "@alice" });
    expect(alice.getAttribute("href")).toBe("https://github.com/alice");
    expect(alice.getAttribute("rel")).toBe("noopener noreferrer");
    const docsTeam = screen.getByRole("link", { name: "@my-org/docs-team" });
    expect(docsTeam.getAttribute("href")).toBe("https://github.com/orgs/my-org/teams/docs-team");
    expect(docsTeam.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows the patterns in <code> and the counts", () => {
    render(<CodeOwnersPanel rules={rules} />);
    const code = screen.getAllByText(/^(\*|\/docs\/)$/);
    expect(code.map((el) => el.tagName)).toEqual(["CODE", "CODE"]);
    expect(screen.getAllByText("1 pattern")).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain("(2)");
  });
});

describe("CodeOwnersPanel grouping", () => {
  it("groups one owner's rules and keeps file order", () => {
    render(
      <CodeOwnersPanel
        rules={[
          { pattern: "*", owners: [user("@bob"), team("@acme/platform")] },
          { pattern: "/docs/", owners: [user("@bob")] },
          { pattern: "*.ts", owners: [user("@bob")] },
        ]}
      />,
    );
    const [bob, platform] = groups();
    expect(
      within(bob as HTMLElement)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["*", "/docs/", "*.ts"]);
    expect(within(bob as HTMLElement).getByText("3 patterns")).toBeTruthy();
    expect(within(platform as HTMLElement).getByText("1 pattern")).toBeTruthy();
  });

  it("merges case variants and shows the first spelling", () => {
    render(
      <CodeOwnersPanel
        rules={[
          { pattern: "/a/", owners: [user("@Bob")] },
          { pattern: "/b/", owners: [user("@bob")] },
        ]}
      />,
    );
    expect(groups()).toHaveLength(1);
    expect(screen.getByRole("link", { name: "@Bob" })).toBeTruthy();
    expect(screen.queryByText("@bob")).toBeNull();
    expect(screen.getByText("2 patterns")).toBeTruthy();
  });

  it("shows an e-mail owner with a mailto link and the Email label", () => {
    render(
      <CodeOwnersPanel
        rules={[{ pattern: "/SECURITY.md", owners: [email("sec@acme.example")] }]}
      />,
    );
    const link = screen.getByRole("link", { name: "sec@acme.example" });
    expect(link.getAttribute("href")).toBe("mailto:sec@acme.example");
    expect(link.getAttribute("rel")).toBeNull();
    expect(screen.getByText("Email")).toBeTruthy();
  });

  it("does not list a rule without owners", () => {
    render(
      <CodeOwnersPanel
        rules={[
          { pattern: "*", owners: [user("@alice")] },
          { pattern: "/vendor/", owners: [] },
        ]}
      />,
    );
    expect(groups()).toHaveLength(1);
    expect(screen.queryByText("/vendor/")).toBeNull();
  });

  it("explains that the last matching rule wins", () => {
    render(<CodeOwnersPanel rules={[{ pattern: "*", owners: [user("@alice")] }]} />);
    expect(screen.getByTestId("code-owners").textContent).toMatch(/last one wins/);
  });
});

describe("CodeOwnersPanel with many patterns", () => {
  const patterns = Array.from({ length: COLLAPSE_AFTER + 4 }, (_, i) => `/svc-${i + 1}/`);
  const rules = patterns.map((pattern) => ({ pattern, owners: [user("@carol")] }));

  it("shows the first patterns and folds the rest into a native details element", () => {
    const { container } = render(<CodeOwnersPanel rules={rules} />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Show 4 more patterns");
    const shown = within(groups()[0] as HTMLElement)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    // visible list items first, then the folded ones: all patterns, in file order
    expect(shown).toEqual(patterns);
    const folded = [...(details?.querySelectorAll("code") ?? [])].map((c) => c.textContent);
    expect(folded).toEqual(patterns.slice(COLLAPSE_AFTER));
    expect(screen.getByText(`${patterns.length} patterns`)).toBeTruthy();
  });

  it("does not fold exactly COLLAPSE_AFTER patterns", () => {
    const { container } = render(<CodeOwnersPanel rules={rules.slice(0, COLLAPSE_AFTER)} />);
    expect(container.querySelector("details")).toBeNull();
  });

  it("says 'pattern' for a single folded pattern", () => {
    const { container } = render(<CodeOwnersPanel rules={rules.slice(0, COLLAPSE_AFTER + 1)} />);
    expect(container.querySelector("summary")?.textContent).toBe("Show 1 more pattern");
  });

  it("lets a very long pattern wrap", () => {
    const long = `/${"segment/".repeat(60)}*.ts`;
    const { container } = render(
      <CodeOwnersPanel rules={[{ pattern: long, owners: [user("@carol")] }]} />,
    );
    const code = container.querySelector("li code");
    expect(code?.textContent).toBe(long);
    expect(code?.className).toContain("[overflow-wrap:anywhere]");
  });
});

describe("CodeOwnersPanel with hostile text", () => {
  it("renders handles and patterns as text and links only safe handles", () => {
    const { container } = render(
      <CodeOwnersPanel
        rules={[
          {
            pattern: '<img src=x onerror="alert(1)">',
            owners: [
              user("@javascript:alert(1)"),
              team('@org/"><script>alert(1)</script>'),
              email("a@b.co?bcc=evil@example.com"),
              user("@fine"),
            ],
          },
        ]}
      />,
    );
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://github.com/fine");
    expect(screen.getByText("@javascript:alert(1)").tagName).toBe("SPAN");
    const patterns = screen.getAllByText('<img src=x onerror="alert(1)">');
    expect(patterns).toHaveLength(4);
    expect(new Set(patterns.map((p) => p.tagName))).toEqual(new Set(["CODE"]));
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href")).not.toMatch(/^javascript:/i);
    }
  });
});

describe("CodeOwnersPanel empty states", () => {
  it("states that no code owners are defined when there are no rules", () => {
    render(<CodeOwnersPanel rules={[]} />);
    const empty = screen.getByTestId("code-owners-empty");
    expect(empty.textContent).toContain("No code owners are defined");
    expect(screen.queryAllByTestId("owner-group")).toHaveLength(0);
    // the heading carries no count
    expect(screen.getByRole("heading", { level: 2 }).textContent?.trim()).toBe("Code owners");
  });

  it("states the same when every rule is un-owned", () => {
    render(<CodeOwnersPanel rules={[{ pattern: "/vendor/", owners: [] }]} />);
    expect(screen.getByTestId("code-owners-empty").textContent).toContain(
      "No code owners are defined",
    );
  });

  it("says the code owners come with the first sync for a never-synced repository", () => {
    render(<CodeOwnersPanel rules={[]} awaitingSync />);
    const empty = screen.getByTestId("code-owners-empty");
    expect(empty.textContent).toContain("after the first sync");
    expect(empty.textContent).not.toContain("No code owners are defined");
  });
});
