import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { CommandPalette } from "@/components/command-palette";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { ThemeProvider } from "@/components/theme-provider";
import { NONCE_HEADER, isValidNonce } from "@/lib/security-headers";
import { THEME_TOKENS } from "@/lib/theme-tokens";
import "./globals.css";

export const metadata: Metadata = {
  title: "DocMyRepos",
  description: "Searchable documentation portal for your GitHub org's repos.",
};

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
async function requestNonce(): Promise<string | undefined> {
  const nonce = (await headers()).get(NONCE_HEADER);
  return isValidNonce(nonce) ? nonce : undefined;
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = await requestNonce();
  return (
    // suppressHydrationWarning: next-themes sets the `dark` class and color-scheme on <html>
    // before React hydrates, so the attributes differ from the server markup by design.
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        {/* The provider's inline script is the first child of <body>: it runs before any visible
            content is parsed. It carries the request nonce, so the CSP lets it run. */}
        <ThemeProvider nonce={nonce}>
          <SiteHeader />
          <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
          <SiteFooter />
          <CommandPalette />
        </ThemeProvider>
      </body>
    </html>
  );
}
