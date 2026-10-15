import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SiteHeader, type HeaderBranding } from "./site-header";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

const PLAIN: HeaderBranding = {
  orgName: null,
  pageTitle: null,
  logoVersion: 0,
  hasLogo: false,
  coloredBar: false,
};

function markup(branding: HeaderBranding = PLAIN): string {
  return renderToStaticMarkup(
    <SiteHeader user={{ email: "admin@example.com", role: "admin" }} branding={branding} />,
  );
}

describe("site header branding", () => {
  it("shows the wordmark with header tokens when nothing is set", () => {
    const html = markup();
    expect(html).toContain("DocMyRepos");
    expect(html).not.toContain("/api/branding/logo");
    expect(html).toContain("bg-header");
    expect(html).toContain("border-header-border");
    expect(html).toContain("text-header-foreground");
  });

  it("shows the logo plus the name, with an empty logo alt", () => {
    const html = markup({
      ...PLAIN,
      orgName: "Acme",
      pageTitle: "Acme Docs",
      hasLogo: true,
      logoVersion: 3,
    });
    expect(html).toContain("/api/branding/logo?v=3");
    expect(html).toContain("Acme");
    expect(html).toContain('alt=""');
  });

  it("names the logo-only link from the title, else Home", () => {
    const titled = markup({ ...PLAIN, pageTitle: "Acme Docs", hasLogo: true, logoVersion: 1 });
    expect(titled).toContain('alt="Acme Docs"');
    const homed = markup({ ...PLAIN, hasLogo: true, logoVersion: 1 });
    expect(homed).toContain('alt="Home"');
    expect(homed).not.toContain("DocMyRepos");
  });

  it("shows the name without a logo image", () => {
    const html = markup({ ...PLAIN, orgName: "Acme" });
    expect(html).toContain("Acme");
    expect(html).not.toContain("/api/branding/logo");
  });

  it("renders the logo in a fixed-height box using the filter variable", () => {
    const html = markup({ ...PLAIN, orgName: "Acme", hasLogo: true, logoVersion: 2 });
    expect(html).toContain("h-8");
    expect(html).toContain("max-w-40");
    expect(html).toContain("object-contain");
    expect(html).toContain("var(--logo-filter, none)");
  });

  it("scopes the focus ring to the bar tokens in colored mode only", () => {
    expect(markup()).not.toContain("--header-ring");
    expect(markup({ ...PLAIN, coloredBar: true })).toContain("--header-ring");
  });
});
