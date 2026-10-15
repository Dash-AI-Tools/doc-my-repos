import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { CommandPalette } from "@/components/command-palette";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { ReadModeProvider } from "@/components/read-mode-provider";
import { ReadingControls } from "@/components/reading-controls";
import { ThemeProvider } from "@/components/theme-provider";
import { E2E_CRASH_HEADER, shouldCrashRootLayout } from "@/lib/e2e-fixtures";
import { NONCE_HEADER, isValidNonce } from "@/lib/security-headers";
import { getCurrentUser } from "@/server/auth/current-user";
import { deriveBrandTokens } from "@/lib/branding/colors";
import { brandStyleBlock } from "@/lib/branding/style";
import { DEFAULT_BRANDING, getBranding } from "@/server/branding";
import {
  DEFAULT_TEXT_SIZE,
  READ_KEY_COOKIE,
  TEXT_SIZE_COOKIE,
  parseReadKey,
  parseTextSize,
} from "@/lib/reading-prefs";
import { THEME_TOKENS } from "@/lib/theme-tokens";
import "@fontsource-variable/hanken-grotesk";
import "./globals.css";

/**
 * Tab titles (org-branding 3.1): the branding page title, else the organization name, else
 * "DocMyRepos", as the default and as every page title's suffix. Pages return their own part
 * only; `notFound()` pages are static and inherit the default when branding is unset.
 */
export async function generateMetadata(): Promise<Metadata> {
  const branding = await getBranding().catch(() => DEFAULT_BRANDING);
  const pageTitle = branding.pageTitle ?? branding.orgName ?? "DocMyRepos";
  return {
    title: { default: pageTitle, template: `%s · ${pageTitle}` },
    description: "Searchable documentation portal for your GitHub org's repos.",
  };
}

/**
 * `colorScheme` emits `<meta name="color-scheme" content="light dark">` so the browser's own UI
 * and the canvas before CSS arrives match the OS. `themeColor` follows the OS preference (a meta
 * tag cannot follow the in-app choice without script), with the token backgrounds.
 */
export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_TOKENS.light.background },
    { media: "(prefers-color-scheme: dark)", color: THEME_TOKENS.dark.background },
  ],
};

/**
 * The per-request CSP nonce set by `src/proxy.ts`. Only a value of the shape the proxy generates
 * is used; anything else (no proxy run, a forged header) gives no nonce, and the CSP then blocks
 * the theme script rather than trusting arbitrary text. Reading headers renders every page per
 * request, which a nonce requires.
 */
function requestNonce(requestHeaders: Headers): string | undefined {
  const nonce = requestHeaders.get(NONCE_HEADER);
  return isValidNonce(nonce) ? nonce : undefined;
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  // E2E only (needs E2E_FIXTURES=1 in the server environment): lets the suite prove that
  // `global-error.tsx` takes over when this layout throws.
  if (shouldCrashRootLayout(process.env, requestHeaders.get(E2E_CRASH_HEADER))) {
    throw new Error("e2e: forced root layout crash");
  }
  const nonce = requestNonce(requestHeaders);
  // Logged-out on failure: the proxy already keeps unauthenticated visitors off every page
  // except /login, so null here only means the login page or a forged cookie mid-redirect.
  const user = await getCurrentUser().catch(() => null);
  // Branding (org-branding 3.1): same derivation as the admin preview; a bad row or a down
  // database falls back to the defaults, so the page still renders.
  const branding = await getBranding().catch(() => DEFAULT_BRANDING);
  const { primaryColor, accentColor } = branding;
  const derived =
    primaryColor !== null && accentColor !== null
      ? deriveBrandTokens({ primary: primaryColor, accent: accentColor })
      : null;
  const brandCss = brandStyleBlock(derived, {
    coloredHeader: branding.coloredHeader,
    invertLogo: branding.invertLogoOnDark,
    hasLogo: branding.hasLogo,
  });
  const coloredBar = primaryColor !== null && accentColor !== null && branding.coloredHeader;
  // Read on the server so the first HTML already has the reader's size (no flash). Default has no
  // attribute, so the page then has no text size rules at all.
  const preferences = await cookies();
  const textSize = parseTextSize(preferences.get(TEXT_SIZE_COOKIE)?.value);
  const shortcutEnabled = parseReadKey(preferences.get(READ_KEY_COOKIE)?.value) === "on";
  return (
    // suppressHydrationWarning: next-themes sets the `dark` class and color-scheme on <html>
    // before React hydrates, so the attributes differ from the server markup by design.
    <html
      lang="en"
      suppressHydrationWarning
      data-colored-header={coloredBar ? "true" : "false"}
      data-text-size={textSize === DEFAULT_TEXT_SIZE ? undefined : textSize}
    >
      <body className="flex min-h-screen flex-col">
        {/* Branding overrides (org-branding 3.1): server-rendered, so there is no flash.
            Nothing is emitted when the defaults apply. */}
        {brandCss === "" ? null : <style id="branding">{brandCss}</style>}
        {/* The provider's inline script is the first script child of <body>: it runs before any
            visible content is parsed. It carries the request nonce, so the CSP lets it run. */}
        <ThemeProvider nonce={nonce}>
          <ReadModeProvider initialShortcutEnabled={shortcutEnabled}>
            <SiteHeader
              user={user}
              branding={{
                orgName: branding.orgName,
                pageTitle: branding.pageTitle,
                logoVersion: branding.logoVersion,
                hasLogo: branding.hasLogo,
                coloredBar: coloredBar,
              }}
            />
            <main className="site-shell mx-auto w-full max-w-[88rem] flex-1 px-5 py-10 sm:px-8 lg:px-16 lg:py-14">
              {children}
            </main>
            <SiteFooter />
            <CommandPalette />
            <ReadingControls />
          </ReadModeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
