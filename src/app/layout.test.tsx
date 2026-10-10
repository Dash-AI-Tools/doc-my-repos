import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { CommandPalette } from "@/components/command-palette";
import { THEME_STORAGE_KEY } from "@/components/theme-provider";
import { THEME_TOKENS } from "@/lib/theme-tokens";

import RootLayout, { viewport } from "./layout";

/** The request headers `headers()` returns; each test sets what the proxy would have sent. */
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));

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

  it("renders the theme toggle in the header and the page content", () => {
    expect(html).toMatch(
      /<header[^>]*>[\s\S]*data-testid="theme-toggle-placeholder"[\s\S]*<\/header>/,
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
