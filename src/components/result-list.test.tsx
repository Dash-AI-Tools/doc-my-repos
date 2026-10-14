// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HIGHLIGHT_END as E, HIGHLIGHT_START as S } from "@/lib/search";
import type { ResultItemData } from "@/lib/search-view";

import { ResultList } from "./result-list";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const ITEM: ResultItemData = {
  key: "1:docs/guides/setup.md",
  title: "Setup",
  href: "/acme/api/docs/guides/setup#install",
  repoLabel: "acme/api",
  repoHref: "/acme/api",
  path: "docs/guides/setup.md",
  section: "Install",
  snippet: `Run the ${S}deployment${E} script, then ${S}deployment${E} is done.`,
  isPrivate: false,
  type: null,
  status: null,
  tags: [],
};

function renderOne(over: Partial<ResultItemData> = {}) {
  render(<ResultList items={[{ ...ITEM, ...over }]} />);
  return screen.getByTestId("result");
}

describe("ResultList", () => {
  it("shows the title as a link to the document, with the heading anchor", () => {
    const result = renderOne();
    const link = within(result).getByRole("link", { name: "Setup" });
    expect(link.getAttribute("href")).toBe("/acme/api/docs/guides/setup#install");
    expect(link.closest("h3")).not.toBeNull();
  });

  it("shows the repository as a link and the path as text", () => {
    const result = renderOne();
    expect(within(result).getByRole("link", { name: "acme/api" }).getAttribute("href")).toBe(
      "/acme/api",
    );
    expect(within(result).getByTestId("result-path").textContent).toBe("docs/guides/setup.md");
  });

  it("highlights matched terms as <mark> and keeps the rest as text", () => {
    const result = renderOne();
    const marks = result.querySelectorAll("mark");
    expect([...marks].map((m) => m.textContent)).toEqual(["deployment", "deployment"]);
    expect(within(result).getByTestId("result-snippet").textContent).toBe(
      "Run the deployment script, then deployment is done.",
    );
  });

  it("never turns snippet text into HTML", () => {
    const result = renderOne({
      snippet: `${S}x${E} <img src=x onerror=alert(1)> <b>bold</b> &amp;`,
    });
    expect(result.querySelector("img, b, script")).toBeNull();
    expect(within(result).getByTestId("result-snippet").textContent).toBe(
      "x <img src=x onerror=alert(1)> <b>bold</b> &amp;",
    );
  });

  it("renders a hostile title and path as text", () => {
    const result = renderOne({ title: "<script>alert(1)</script>", path: "docs/<b>x</b>.md" });
    expect(result.querySelector("script, b")).toBeNull();
    expect(result.textContent).toContain("<script>alert(1)</script>");
  });

  it("shows no snippet paragraph when the snippet is empty, still title and path", () => {
    const result = renderOne({ snippet: "" });
    expect(within(result).queryByTestId("result-snippet")).toBeNull();
    expect(within(result).getByRole("link", { name: "Setup" })).toBeTruthy();
    expect(within(result).getByTestId("result-path")).toBeTruthy();
  });

  it("badges results from private repositories only", () => {
    expect(within(renderOne({ isPrivate: true })).getByTestId("private-badge").textContent).toBe(
      "Private",
    );
    cleanup();
    expect(within(renderOne({ isPrivate: false })).queryByTestId("private-badge")).toBeNull();
  });

  it("shows type, status and tags only when present", () => {
    const plain = renderOne();
    expect(within(plain).queryByTestId("result-type")).toBeNull();
    expect(within(plain).queryByTestId("result-status")).toBeNull();
    expect(within(plain).queryByTestId("result-tag")).toBeNull();
    cleanup();
    const okf = renderOne({ type: "Runbook", status: "draft", tags: ["infra", "oncall"] });
    expect(within(okf).getByTestId("result-type").textContent).toBe("Type: Runbook");
    expect(within(okf).getByTestId("result-status").textContent).toBe("Status: draft");
    expect(
      within(okf)
        .getAllByTestId("result-tag")
        .map((t) => t.textContent),
    ).toEqual(["Tag: infra", "Tag: oncall"]);
  });

  it("shows the section label only when there is one", () => {
    expect(within(renderOne()).getByTestId("result-section").textContent).toBe("Section: Install");
    cleanup();
    expect(within(renderOne({ section: null })).queryByTestId("result-section")).toBeNull();
  });

  it("is an ordered list of results", () => {
    render(<ResultList items={[ITEM, { ...ITEM, key: "2", title: "Other" }]} />);
    const list = screen.getByRole("list", { name: "Search results" });
    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByTestId("result")).toHaveLength(2);
  });
});
