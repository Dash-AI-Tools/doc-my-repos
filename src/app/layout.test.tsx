import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CommandPalette } from "@/components/command-palette";
import { THEME_STORAGE_KEY } from "@/components/theme-provider";
import { E2E_CRASH_HEADER } from "@/lib/e2e-fixtures";
import { AskLauncher } from "@/components/ask-launcher";
import { SiteHeader } from "@/components/site-header";
import { THEME_TOKENS } from "@/lib/theme-tokens";

import RootLayout, { generateMetadata, viewport } from "./layout";

/** Branding the layout reads; tests set this to a branded portal. */
const brandingState = vi.hoisted(() => ({
  current: {
    orgName: null as string | null,
    pageTitle: null as string | null,
    primaryColor: null as string | null,
    accentColor: null as string | null,
    coloredHeader: false,
    invertLogoOnDark: true,
    logoVersion: 0,
    hasLogo: false,
  },
}));
vi.mock("@/server/branding", () => ({
  DEFAULT_BRANDING: {
    orgName: null,
    pageTitle: null,
    primaryColor: null,
    accentColor: null,
    coloredHeader: false,
    invertLogoOnDark: true,
    logoVersion: 0,
    hasLogo: false,
  },
  getBranding: async () => ({ ...brandingState.current }),
}));

/** The request headers `headers()` returns; each test sets what the proxy would have sent. */
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
/** The request cookies `cookies()` returns; the text size test sets the stored choice here. */
const requestCookies = vi.hoisted(() => ({ current: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
  cookies: async () => ({
    get: (name: string) => {
      const value = requestCookies.current.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
// The header's user section comes from the session; layout tests render logged-out unless a test
// signs a user in. Ask's state decides whether the header shows the Ask link.
const session = vi.hoisted(() => ({
  user: null as null | { id: number; email: string; role: "admin" | "user" },
  ask: { state: "off" } as { state: string },
  mcp: true as boolean | "throws",
}));
vi.mock("@/server/auth/current-user", () => ({ getCurrentUser: async () => session.user }));
vi.mock("@/server/ask/settings", () => ({ getAskState: async () => session.ask }));
vi.mock("@/server/workspace", () => ({
  mcpEnabled: async () => {
    if (session.mcp === "throws") throw new Error("database down");
    return session.mcp;
  },
}));
vi.mock("@/server/ask-page", () => ({
  loadAskPage: async () =>
    session.ask.state === "ready"
      ? {
          status: "ready",
          providerLabel: "Anthropic",
          host: null,
          scope: null,
          repos: ["acme/api"],
          initialQuestion: "",
        }
      : { status: "off" },
}));

const NONCE = "AAECAwQFBgcICQoLDA0ODw==";

async function renderLayout(nonce?: string): Promise<ReactElement> {
  requestHeaders.current = new Headers(nonce === undefined ? {} : { "x-nonce": nonce });
  return (await RootLayout({ children: page })) as ReactElement;
}

const page = <p data-testid="page">Page content</p>;

/** How many times `type` appears in an element tree (children of host and composite elements). */
function countElements(node: ReactNode, type: unknown): number {
  if (Array.isArray(node))
    return node.reduce((n: number, child) => n + countElements(child, type), 0);
  if (!isValidElement<{ children?: ReactNode }>(node)) return 0;
  return (node.type === type ? 1 : 0) + countElements(node.props.children, type);
}

/** The props of the first element of `type` in the tree, or null. */
function propsOf<P>(node: ReactNode, type: unknown): P | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf<P>(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  if (node.type === type) return node.props as unknown as P;
  return propsOf<P>(node.props.children, type);
}

describe("root layout: the AI agent access link", () => {
  afterEach(() => {
    session.user = null;
    session.mcp = true;
  });

  const agentAccess = async () =>
    propsOf<{ agentAccess: boolean }>(await renderLayout(), SiteHeader)?.agentAccess;

  it("is on for a signed-in user while the MCP endpoint is on", async () => {
    session.user = { id: 1, email: "u@example.com", role: "user" };
    expect(await agentAccess()).toBe(true);
  });

  it("is off when an admin turned the endpoint off", async () => {
    session.user = { id: 1, email: "u@example.com", role: "user" };
    session.mcp = false;
    expect(await agentAccess()).toBe(false);
  });

  it("is off for a signed-out visitor, and when the setting cannot be read", async () => {
    expect(await agentAccess()).toBe(false);
    session.user = { id: 1, email: "u@example.com", role: "user" };
    session.mcp = "throws";
    expect(await agentAccess()).toBe(false);
  });
});

describe("root layout: the Ask link", () => {
  afterEach(() => {
    session.user = null;
    session.ask = { state: "off" };
  });

  const askEnabled = async () =>
    propsOf<{ askEnabled: boolean }>(await renderLayout(), SiteHeader)?.askEnabled;

  it("is off for a signed-in reader while Ask is off or unavailable", async () => {
    session.user = { id: 1, email: "u@example.com", role: "user" };
    expect(await askEnabled()).toBe(false);
    session.ask = { state: "unavailable" };
    expect(await askEnabled()).toBe(false);
  });

  it("is on for a signed-in reader when Ask is ready", async () => {
    session.user = { id: 1, email: "u@example.com", role: "user" };
    session.ask = { state: "ready" };
    expect(await askEnabled()).toBe(true);
  });

  it("shows the floating Ask orb only when the link is on", async () => {
    session.user = { id: 1, email: "u@example.com", role: "user" };
    session.ask = { state: "ready" };
    const orb = propsOf<{ providerLabel: string; repos: string[] }>(
      await renderLayout(),
      AskLauncher,
    );
    expect(orb).toMatchObject({ providerLabel: "Anthropic", repos: ["acme/api"] });

    session.ask = { state: "off" };
    expect(propsOf(await renderLayout(), AskLauncher)).toBeNull();
    session.user = null;
    session.ask = { state: "ready" };
    expect(propsOf(await renderLayout(), AskLauncher)).toBeNull();
  });

  it("is off for a signed-out visitor even when Ask is ready", async () => {
    session.ask = { state: "ready" };
    expect(await askEnabled()).toBe(false);
  });
});

describe("root layout", () => {
  let html = "";
  let tree: ReactElement;
  beforeAll(async () => {
    tree = await renderLayout(NONCE);
    html = renderToStaticMarkup(tree);
  });

  it("marks <html> with suppressHydrationWarning and a language", () => {
    const root = tree as ReactElement<{ lang: string; suppressHydrationWarning?: boolean }>;
    expect(root.type).toBe("html");
    expect(root.props.lang).toBe("en");
    expect(root.props.suppressHydrationWarning).toBe(true);
  });

  it("renders the reading menu in the header and the page content", () => {
    expect(html).toMatch(
      /<header[^>]*>[\s\S]*data-testid="text-size-placeholder"[\s\S]*<\/header>/,
    );
    expect(html).toContain("Page content");
  });

  it("puts the search trigger in the header, as a link that works without JavaScript", () => {
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    const trigger = /<a [^>]*data-testid="palette-trigger"[^>]*>/.exec(header)?.[0] ?? "";
    expect(trigger).toContain('href="/search"');
    expect(header).toContain('aria-keyshortcuts="Control+K Meta+K"');
    // the server cannot know the platform: the Ctrl hint is what it renders
    expect(header).toContain("Ctrl K");
  });

  it("mounts the command palette exactly once, in the root layout", () => {
    expect(countElements(tree, CommandPalette)).toBe(1);
  });

  it("mounts the command palette closed: no dialog and no second search form in the markup", () => {
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain('role="search"');
  });

  it("emits the theme script as the first thing in <body>, before any content", () => {
    const body = html.slice(html.indexOf("<body"));
    const script = body.indexOf("<script");
    expect(script).toBeGreaterThan(-1);
    expect(script).toBeLessThan(body.indexOf("<header"));
    expect(body.slice(script, body.indexOf("</script>"))).toContain(THEME_STORAGE_KEY);
    // Blocking: not async or deferred, and not an external file.
    const tag = body.slice(script, body.indexOf(">", script));
    expect(tag).not.toMatch(/\b(async|defer|src)\b/);
  });

  it("puts the request nonce from the proxy on the theme script", () => {
    const tag = /<script[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toContain(`nonce="${NONCE}"`);
  });

  it.each([
    ["no x-nonce header", undefined],
    ["an empty header", ""],
    ["a value that is not a generated nonce", "abc"],
    ["a value that would break out of the attribute", `${NONCE}" onload="alert(1)`],
  ])("renders no nonce for %s", async (_label, nonce) => {
    const markup = renderToStaticMarkup(await renderLayout(nonce));
    const tag = /<script[^>]*>/.exec(markup)?.[0] ?? "";
    expect(tag).not.toContain("nonce");
    expect(markup).not.toContain("onload");
  });

  it("configures the script for the class attribute, system default and system detection", () => {
    const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    const args = script.slice(script.lastIndexOf(")(") + 2, -1);
    // [attribute, storageKey, defaultTheme, forcedTheme, themes, value, enableSystem, enableColorScheme]
    expect(JSON.parse(`[${args}]`)).toEqual([
      "class",
      THEME_STORAGE_KEY,
      "system",
      null,
      ["light", "dark"],
      null,
      true,
      true,
    ]);
  });

  it("emits no branding style by default and marks the bar uncolored", () => {
    expect(html).not.toContain('id="branding"');
    expect(html).toContain('data-colored-header="false"');
  });

  it("shows the branded logo in the header even signed out", async () => {
    brandingState.current = {
      orgName: "Acme",
      pageTitle: "Acme Docs",
      primaryColor: null,
      accentColor: null,
      coloredHeader: false,
      invertLogoOnDark: true,
      logoVersion: 7,
      hasLogo: true,
    };
    try {
      const markup = renderToStaticMarkup(await renderLayout(NONCE));
      expect(markup).toContain("/api/branding/logo?v=7");
      // The sign-in page uses this same layout with no user.
      expect(markup).not.toContain("admin@example.com");
    } finally {
      brandingState.current = {
        orgName: null,
        pageTitle: null,
        primaryColor: null,
        accentColor: null,
        coloredHeader: false,
        invertLogoOnDark: true,
        logoVersion: 0,
        hasLogo: false,
      };
    }
  });

  it("emits the derived branding style and marks the bar colored when set", async () => {
    brandingState.current = {
      orgName: "Acme",
      pageTitle: "Acme Docs",
      primaryColor: "#2b59ff",
      accentColor: "#2b59ff",
      coloredHeader: true,
      invertLogoOnDark: true,
      logoVersion: 0,
      hasLogo: false,
    };
    try {
      const markup = renderToStaticMarkup(await renderLayout(NONCE));
      expect(markup).toContain('id="branding"');
      expect(markup).toContain("--primary:#2b59ff;");
      expect(markup).toContain('data-colored-header="true"');
    } finally {
      brandingState.current = {
        orgName: null,
        pageTitle: null,
        primaryColor: null,
        accentColor: null,
        coloredHeader: false,
        invertLogoOnDark: true,
        logoVersion: 0,
        hasLogo: false,
      };
    }
  });
});

describe("generateMetadata", () => {
  it("defaults to DocMyRepos with a matching template", async () => {
    expect(await generateMetadata()).toEqual({
      title: { default: "DocMyRepos", template: "%s · DocMyRepos" },
      description: "Searchable documentation portal for your GitHub org's repos.",
    });
  });

  it("prefers the page title, then the organization name", async () => {
    brandingState.current = { ...brandingState.current, orgName: "Acme", pageTitle: "Acme Docs" };
    try {
      expect((await generateMetadata()).title).toEqual({
        default: "Acme Docs",
        template: "%s · Acme Docs",
      });
    } finally {
      brandingState.current = { ...brandingState.current, orgName: null, pageTitle: null };
    }
  });
});

describe("viewport", () => {
  it("declares both color schemes and a theme color per scheme from the tokens", () => {
    expect(viewport.colorScheme).toBe("light dark");
    expect(viewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: THEME_TOKENS.light.background },
      { media: "(prefers-color-scheme: dark)", color: THEME_TOKENS.dark.background },
    ]);
  });
});

describe("root layout, forced crash for the e2e suite", () => {
  const original = process.env.E2E_FIXTURES;
  afterEach(() => {
    if (original === undefined) delete process.env.E2E_FIXTURES;
    else process.env.E2E_FIXTURES = original;
  });

  it("throws only with E2E_FIXTURES=1 and the crash header", async () => {
    requestHeaders.current = new Headers({ [E2E_CRASH_HEADER]: "1" });
    process.env.E2E_FIXTURES = "1";
    await expect(RootLayout({ children: page })).rejects.toThrow("forced root layout crash");

    // the header alone does nothing on a server without the switch
    delete process.env.E2E_FIXTURES;
    await expect(RootLayout({ children: page })).resolves.toBeDefined();

    // the switch alone does nothing without the header
    process.env.E2E_FIXTURES = "1";
    requestHeaders.current = new Headers();
    await expect(RootLayout({ children: page })).resolves.toBeDefined();
  });
});

describe("root layout, text size on <html>", () => {
  afterEach(() => {
    requestCookies.current = new Map();
  });

  async function htmlTagFor(cookies: Record<string, string>): Promise<string> {
    requestCookies.current = new Map(Object.entries(cookies));
    const tree = await renderLayout(NONCE);
    return renderToStaticMarkup(tree).match(/<html[^>]*>/)?.[0] ?? "";
  }

  it("sets no attribute when there is no cookie", async () => {
    expect(await htmlTagFor({})).not.toContain("data-text-size");
  });

  it.each(["small", "large", "larger", "largest"])("sets data-text-size=%s", async (size) => {
    expect(await htmlTagFor({ "docmyrepos-text-size": size })).toContain(
      `data-text-size="${size}"`,
    );
  });

  it("sets no attribute for the stored Default", async () => {
    expect(await htmlTagFor({ "docmyrepos-text-size": "default" })).not.toContain("data-text-size");
  });

  it.each(["huge", "", "LARGE"])("ignores the invalid cookie %j", async (value) => {
    expect(await htmlTagFor({ "docmyrepos-text-size": value })).not.toContain("data-text-size");
  });
});
