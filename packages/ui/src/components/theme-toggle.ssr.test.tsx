import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThemeToggle, ThemeTogglePlaceholder } from "./theme-toggle";

/** Server render has no mounted state: the toggle must emit the inert placeholder. */
describe("ThemeToggle before mount", () => {
  it("renders the placeholder on the server, with no buttons", () => {
    const html = renderToStaticMarkup(<ThemeToggle />);
    expect(html).toContain('data-testid="theme-toggle-placeholder"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("radiogroup");
  });

  it("gives the placeholder the same box as the control", () => {
    const placeholder = renderToStaticMarkup(<ThemeTogglePlaceholder />);
    const size = /\bflex h-9 w-24\b/;
    expect(placeholder).toMatch(size);
  });
});
