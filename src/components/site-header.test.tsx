import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ReadModeProvider } from "./read-mode-provider";
import { SiteHeader, type HeaderBranding } from "./site-header";

const nav = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  usePathname: () => nav.pathname,
}));

const PLAIN: HeaderBranding = {
  orgName: null,
  pageTitle: null,
  logoVersion: 0,
  hasLogo: false,
  coloredBar: false,
};

/** The root layout mounts the read mode provider around the header, so every render does too. */
const inLayout = (node: ReactElement) => (
  <ReadModeProvider initialShortcutEnabled>{node}</ReadModeProvider>
);

function markup(branding: HeaderBranding = PLAIN): string {
  return renderToStaticMarkup(
    inLayout(
      <SiteHeader user={{ email: "admin@example.com", role: "admin" }} branding={branding} />,
    ),
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

  it("shows the logo and the page title, not the organization name", () => {
    const html = markup({
      ...PLAIN,
      orgName: "Globex",
      pageTitle: "Docs Portal",
      hasLogo: true,
      logoVersion: 3,
    });
    expect(html).toContain("/api/branding/logo?v=3");
    expect(html).toContain("Docs Portal");
    expect(html).not.toContain("Globex");
    expect(html).toContain('alt=""');
  });

  it("shows the organization name and the page title when there is no logo", () => {
    const html = markup({ ...PLAIN, orgName: "Globex", pageTitle: "Docs Portal" });
    expect(html).toContain("Globex \u00b7 Docs Portal");
    expect(html).not.toContain("/api/branding/logo");
  });

  it("shows only the set one of name and title without a logo", () => {
    expect(markup({ ...PLAIN, pageTitle: "Docs Portal" })).toContain("Docs Portal");
    expect(markup({ ...PLAIN, orgName: "Globex" })).toContain("Globex");
  });

  it("names the logo Home when it stands alone", () => {
    const homed = markup({ ...PLAIN, hasLogo: true, logoVersion: 1 });
    expect(homed).toContain('alt="Home"');
    expect(homed).not.toContain("DocMyRepos");
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

  it("keeps a wide logo and a long title inside the bar", () => {
    const html = markup({
      ...PLAIN,
      pageTitle: "A very long page title that keeps going and going",
      hasLogo: true,
      logoVersion: 5,
    });
    expect(html).toContain("max-w-full");
    expect(html).toContain("break-words");
    expect(html).toContain("max-w-40");
  });
});

describe("site header account menu", () => {
  const header = (role: "admin" | "user" | null, pathname = "/"): string => {
    nav.pathname = pathname;
    return renderToStaticMarkup(
      inLayout(
        <SiteHeader
          user={role === null ? null : { email: `${role}@example.com`, role }}
          branding={PLAIN}
        />,
      ),
    );
  };

  it("puts the admin pages and sign out behind the email", () => {
    const html = header("admin");
    expect(html).toContain("account-menu-trigger");
    expect(html).toContain("admin@example.com");
    expect(html).toContain('aria-expanded="false"');
    for (const label of ["Users", "Workspace configuration", "Branding"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("Administration");
    expect(html).toContain("Sign out");
  });

  it("keeps the top nav free of administration links", () => {
    const html = header("admin");
    const navHtml = html.slice(html.indexOf('aria-label="Main"'), html.indexOf("</nav>"));
    expect(navHtml).not.toContain("admin");
    expect(navHtml).toContain("Repositories");
  });

  it("marks the current admin page", () => {
    const html = header("admin", "/admin/users");
    expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1);
    expect(header("admin")).not.toContain("aria-current");
  });

  it("hides the admin links from a viewer", () => {
    const html = header("user");
    expect(html).toContain("user@example.com");
    expect(html).not.toContain("/admin");
    expect(html).toContain("Sign out");
  });

  it("shows no account menu when signed out", () => {
    expect(header(null)).not.toContain("account-menu-trigger");
  });
});

describe("site header text size control", () => {
  const cluster = (user: { email: string; role: "admin" | "user" } | null): string =>
    renderToStaticMarkup(inLayout(<SiteHeader user={user} branding={PLAIN} />));

  it("is in the top bar with a user", () => {
    expect(cluster({ email: "viewer@example.com", role: "user" })).toContain(
      'data-testid="text-size-placeholder"',
    );
  });

  it("is in the top bar signed out, as on the sign-in page", () => {
    expect(cluster(null)).toContain('data-testid="text-size-placeholder"');
  });

  it("sits before the palette trigger and the account menu", () => {
    const html = cluster({ email: "admin@example.com", role: "admin" });
    const at = (needle: string) => html.indexOf(needle);
    expect(at('data-testid="text-size-placeholder"')).toBeGreaterThan(-1);
    expect(at('data-testid="text-size-placeholder"')).toBeLessThan(
      at('data-testid="palette-trigger"'),
    );
    expect(at('data-testid="palette-trigger"')).toBeLessThan(
      at('data-testid="account-menu-trigger"'),
    );
    // Theme moved into the reading panel.
    expect(html).not.toContain('data-testid="theme-toggle-placeholder"');
  });
});

describe("site header read mode", () => {
  it("is marked for read mode to hide", () => {
    expect(markup()).toMatch(/<header[^>]*data-read-hide/);
  });
});

describe("site header Ask link", () => {
  const render = (askEnabled?: boolean) =>
    renderToStaticMarkup(
      inLayout(
        <SiteHeader
          user={{ email: "u@example.com", role: "user" }}
          branding={PLAIN}
          {...(askEnabled === undefined ? {} : { askEnabled })}
        />,
      ),
    );

  it("is shown in the main navigation only when Ask is enabled", () => {
    const nav = (html: string) =>
      html.slice(html.indexOf('aria-label="Main"'), html.indexOf("</nav>"));
    expect(nav(render(true))).toContain('href="/ask"');
    expect(nav(render(true))).toMatch(/Repositories[\s\S]*Ask/);
    expect(render(false)).not.toContain('href="/ask"');
    expect(render()).not.toContain('href="/ask"'); // the default is off
  });
});
