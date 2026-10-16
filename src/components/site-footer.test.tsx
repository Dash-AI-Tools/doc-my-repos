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

  it("shows the logo inside the credit link, one image per theme, from this origin", () => {
    const html = renderToStaticMarkup(<SiteFooter />);
    const link = /<a [^>]*data-testid="footer-credit-link"[^>]*>(.*?)<\/a>/.exec(html)?.[1] ?? "";
    expect(link).toContain('src="/logo-black.png"');
    expect(link).toContain('src="/logo-white.png"');
    expect(link.match(/alt="DocMyRepos"/g)).toHaveLength(2);
    expect(link).toContain("dark:hidden");
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

describe("site footer read mode", () => {
  it("is marked for read mode to hide", () => {
    expect(renderToStaticMarkup(<SiteFooter />)).toMatch(/<footer[^>]*data-read-hide/);
  });
});
