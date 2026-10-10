// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const params = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("next/navigation", () => ({ useParams: () => params.value }));

import { DocBody } from "./doc-body";
import { DocBreadcrumb } from "./doc-breadcrumb";
import { DocNotFound, repoSpaceHref } from "./doc-not-found";
import { DocPager } from "./doc-pager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

describe("DocBreadcrumb", () => {
  it("lists home, the repository, the folders (linked when they have an index) and the page", () => {
    render(
      <DocBreadcrumb
        owner="acme"
        repo="api"
        title="Tuning"
        crumbs={[
          { label: "guides", href: "/acme/api/docs/guides/index" },
          { label: "advanced", href: null },
        ]}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
    expect(within(nav).getByRole("link", { name: "acme/api" }).getAttribute("href")).toBe(
      "/acme/api",
    );
    expect(within(nav).getByRole("link", { name: "guides" }).getAttribute("href")).toBe(
      "/acme/api/docs/guides/index",
    );
    expect(within(nav).queryByRole("link", { name: "advanced" })).toBeNull();
    expect(within(nav).getByText("advanced")).toBeTruthy();
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Tuning");
  });

  it("escapes names and titles", () => {
    render(
      <DocBreadcrumb
        owner="acme"
        repo="api"
        title="<script>x</script>"
        crumbs={[{ label: "<b>f</b>", href: null }]}
      />,
    );
    expect(document.querySelector("script, b")).toBeNull();
  });
});

describe("DocPager", () => {
  it("links previous and next with rel and titles", () => {
    render(
      <DocPager
        previous={{ title: "Setup", href: "/a/b/docs/setup" }}
        next={{ title: "Tuning", href: "/a/b/docs/tuning" }}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Previous and next pages" });
    const prev = within(nav).getByRole("link", { name: /Previous/ });
    expect(prev.getAttribute("rel")).toBe("prev");
    expect(prev.getAttribute("href")).toBe("/a/b/docs/setup");
    expect(prev.textContent).toContain("Setup");
    const next = within(nav).getByRole("link", { name: /Next/ });
    expect(next.getAttribute("rel")).toBe("next");
    expect(next.textContent).toContain("Tuning");
  });

  it("leaves out a missing neighbour, and renders nothing for a page with neither", () => {
    const { container, rerender } = render(
      <DocPager previous={null} next={{ title: "B", href: "/b" }} />,
    );
    expect(screen.queryByRole("link", { name: /Previous/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Next/ })).toBeTruthy();
    rerender(<DocPager previous={null} next={null} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("DocBody", () => {
  it("injects the rendered HTML in the markdown wrapper", () => {
    render(
      <DocBody
        body={{ status: "rendered", html: "<h2>Hi</h2><p>x</p>", hideTitleHeading: false }}
      />,
    );
    const body = screen.getByTestId("doc-body");
    expect(body.className).toContain("markdown-body");
    expect(body.innerHTML).toBe("<h2>Hi</h2><p>x</p>");
    expect(body.hasAttribute("data-hide-title")).toBe(false);
  });

  it("flags a body whose first h1 repeats the page title", () => {
    render(<DocBody body={{ status: "rendered", html: "<h1>T</h1>", hideTitleHeading: true }} />);
    expect(screen.getByTestId("doc-body").hasAttribute("data-hide-title")).toBe(true);
  });

  it("shows plain text, escaped, when rendering failed", () => {
    render(<DocBody body={{ status: "plain", text: "# T\n<script>alert(1)</script>" }} />);
    const pre = screen.getByTestId("doc-plain");
    expect(pre.textContent).toBe("# T\n<script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
    expect(pre.getAttribute("tabindex")).toBe("0");
  });
});

describe("DocNotFound", () => {
  it("names the problem and links back to the repository space and home", () => {
    params.value = { owner: "acme", repo: "api-service", path: ["guides", "x"] };
    render(<DocNotFound />);
    const box = screen.getByTestId("doc-not-found");
    expect(within(box).getByRole("heading", { level: 1, name: "Document not found" })).toBeTruthy();
    expect(
      within(box).getByRole("link", { name: "Back to the repository" }).getAttribute("href"),
    ).toBe("/acme/api-service");
    expect(
      within(box).getByRole("link", { name: "Back to the home page" }).getAttribute("href"),
    ).toBe("/");
  });

  it("only links to a repository for names GitHub allows", () => {
    expect(repoSpaceHref({ owner: "acme", repo: "a.b_c-d" })).toBe("/acme/a.b_c-d");
    for (const [owner, repo] of [
      ["acme", "a b"],
      ["acme", "a%2Fb"],
      ["acme", ".."],
      ["acme", "javascript:alert(1)"],
      ["a/b", "c"],
      ["acme", ""],
      [undefined, "c"],
      ["acme", ["x"]],
    ] as const) {
      expect(repoSpaceHref({ owner, repo }), `${String(owner)}/${String(repo)}`).toBeNull();
    }
    params.value = { owner: "acme", repo: "a b" };
    render(<DocNotFound />);
    expect(screen.queryByRole("link", { name: "Back to the repository" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to the home page" })).toBeTruthy();
  });
});
