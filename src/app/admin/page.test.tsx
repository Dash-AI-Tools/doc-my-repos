import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AdminPage from "./page";

describe("admin overview", () => {
  it("links to the branding page", () => {
    const html = renderToStaticMarkup(<AdminPage />);
    expect(html).toContain('href="/admin/branding"');
    expect(html).toContain("Branding");
  });

  it("links to the Ask page", () => {
    const html = renderToStaticMarkup(<AdminPage />);
    expect(html).toContain('href="/admin/ask"');
  });
});
