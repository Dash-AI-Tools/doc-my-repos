// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SearchBar } from "./search-bar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

describe("SearchBar", () => {
  it("is a GET form to /search with a q field, so it works without JavaScript", () => {
    render(<SearchBar />);
    const form = screen.getByRole("search", { name: "Search documentation" });
    expect(form.tagName).toBe("FORM");
    expect(form.getAttribute("action")).toBe("/search");
    expect(form.getAttribute("method")).toBe("get");
    const input = screen.getByRole("searchbox", { name: "Search all documentation" });
    expect(input.getAttribute("name")).toBe("q");
    expect(screen.getByRole("button", { name: "Search" }).getAttribute("type")).toBe("submit");
  });

  it("labels the input through a real label element", () => {
    const { container } = render(<SearchBar id="x" />);
    const label = container.querySelector("label");
    expect(label?.getAttribute("for")).toBe("x");
    expect(container.querySelector("input")?.id).toBe("x");
  });

  it("prefills the query", () => {
    render(<SearchBar defaultValue="deploy guide" />);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("deploy guide");
  });
});
