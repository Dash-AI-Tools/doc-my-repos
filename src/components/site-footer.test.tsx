import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { REPO_URL } from "@/lib/site";

import { SiteFooter } from "./site-footer";

describe("site footer", () => {
  it("credits DocMyRepos with a star link, both to the repository constant", () => {
    const html = renderToStaticMarkup(<SiteFooter />);
    expect(html).toContain("Powered by");
    expect(html).toContain(`href="${REPO_URL}"`);
    expect(html).toContain("Star");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("<svg");
  });

  it("keeps the Sync status link and renders the same whatever branding is set", () => {
    const html = renderToStaticMarkup(<SiteFooter />);
    expect(html).toContain('data-testid="footer-status-link"');
    expect(html).toContain("Sync status");
    const statusTag = /<a [^>]*data-testid="footer-status-link"[^>]*>/.exec(html)?.[0] ?? "";
    expect(statusTag).toContain('href="/status"');
  });

  it("loads no external resource", () => {
    const html = renderToStaticMarkup(<SiteFooter />);
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:(?!\/\/github\.com\/Dash-AI-Tools\/doc-my-repos")/);
  });
});
