import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { Fragment, type ReactNode } from "react";
import { AskLauncher } from "../components/ask-launcher";
import { CommandPalette } from "../components/command-palette";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import { ReadModeProvider } from "../components/read-mode-provider";
import { ReadingControls } from "../components/reading-controls";
import { ThemeProvider } from "../components/theme-provider";
import { E2E_CRASH_HEADER, shouldCrashRootLayout } from "@docmyrepos/core/internal/e2e-fixtures";
import { NONCE_HEADER, isValidNonce } from "@docmyrepos/core/internal/security-headers";
import { loadAskPage } from "@docmyrepos/server/internal/ask-page";
import { askStateFor } from "@docmyrepos/server/internal/ask/settings";
import { logger } from "@docmyrepos/server/internal/log";
import { mcpEnabled } from "@docmyrepos/server/internal/workspace";
import { NO_FEATURES, coreSlotItems } from "@docmyrepos/server/internal/plugins/slots";
import type { SlotName } from "@docmyrepos/core";
import { deriveBrandTokens } from "@docmyrepos/core/internal/branding/colors";
import { brandStyleBlock } from "@docmyrepos/core/internal/branding/style";
import { DEFAULT_BRANDING, getBranding } from "@docmyrepos/server/internal/branding/index";
import {
  DEFAULT_TEXT_SIZE,
  READ_KEY_COOKIE,
  TEXT_SIZE_COOKIE,
  parseReadKey,
  parseTextSize,
} from "@docmyrepos/core/internal/reading-prefs";
import { THEME_TOKENS } from "@docmyrepos/core/internal/theme-tokens";
import "@fontsource-variable/hanken-grotesk";
import type { AppProps } from "../bind-page";

/**
 * Tab titles (org-branding 3.1): the branding page title, else the organization name, else
 * "DocMyRepos", as the default and as every page title's suffix. Pages return their own part
 * only; `notFound()` pages are static and inherit the default when branding is unset.
 */
export async function generateMetadata({ app }: AppProps): Promise<Metadata> {
  const ctx = await app.pageContext();
  const branding =
    ctx === null
      ? DEFAULT_BRANDING
      : await ctx
          .db()
          .then((db) => getBranding(db))
          .catch(() => DEFAULT_BRANDING);
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

export async function RootLayout({ app, children }: AppProps & { children: ReactNode }) {
  const requestHeaders = await headers();
  // E2E only (needs E2E_FIXTURES=1 in the server environment): lets the suite prove that
  // `global-error.tsx` takes over when this layout throws.
  if (shouldCrashRootLayout(process.env, requestHeaders.get(E2E_CRASH_HEADER))) {
    throw new Error("e2e: forced root layout crash");
  }
  const nonce = requestNonce(requestHeaders);
  // A request that matches no tenant renders the not-found page inside this layout, with the
  // default branding and nobody signed in: nothing of any tenant is read.
  const ctx = await app.pageContext();
  // Branding does not depend on the user, so it loads alongside the session. Both fall back so the
  // page still renders: branding to the defaults (org-branding 3.1: same derivation as the admin
  // preview; a bad row or a down database), the user to logged-out. A user failure is logged: a
  // broken database (for example a missing migration) must not look like a plain signed-out
  // visitor. A missing or forged session is not an error: `authenticate` returns null for it.
  const [user, branding] =
    ctx === null
      ? [null, DEFAULT_BRANDING]
      : await Promise.all([
          ctx.user().catch((error: unknown) => {
            logger.error("auth.current_user.failed", { error });
            return null;
          }),
          ctx
            .db()
            .then((db) => getBranding(db))
            .catch(() => DEFAULT_BRANDING),
        ]);
  // Ask is shown to signed-in readers only when an admin turned it on and the provider is usable
  // (`getAskState` never throws: any failure reads as off). The account menu links to the AI agent
  // pages only while an admin has the MCP endpoint on. Neither is read for a signed-out visitor.
  const [askState, agentAccess] =
    user === null
      ? [null, false]
      : await Promise.all([
          ctx === null ? null : askStateFor(ctx),
          mcpEnabled(ctx ?? undefined).catch(() => false),
        ]);
  const askEnabled = askState?.state === "ready";
  // Admin links show to whoever the `authorize` hook lets administer the workspace.
  const isAdmin = user !== null && ctx !== null && (await ctx.can("admin.manage"));
  // The header, account menu, footer and banners: the core's items, then the plugins'. Without a
  // tenant there is no context and no plugin is asked.
  const state = { askEnabled, agentAccess };
  const slot = <S extends SlotName>(name: S) =>
    ctx === null
      ? Promise.resolve(coreSlotItems(name, NO_FEATURES))
      : app.slots.resolve(name, ctx, state);
  const [nav, accountItems, footerLinks, banners] = await Promise.all([
    slot("header.nav"),
    slot("account.menu"),
    slot("footer.links"),
    slot("layout.banner"),
  ]);
  const bannerNodes =
    ctx === null
      ? []
      : (
          await Promise.all(
            banners.map((banner) =>
              Promise.resolve()
                .then(() => banner.render(ctx))
                .catch((error: unknown) => {
                  ctx.log.warn("plugin.failed", { slot: "layout.banner", error });
                  return null;
                }),
            ),
          )
        ).filter((node) => node !== null && node !== undefined);
  const ask =
    askEnabled && ctx !== null
      ? await loadAskPage(
          {},
          {
            db: ctx.db,
            state: () => askStateFor(ctx),
            providers: async () => (await ctx.workspace()).providers,
          },
        )
      : null;
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
              user={user === null ? null : { email: user.email, admin: isAdmin }}
              nav={nav}
              accountItems={accountItems}
              branding={{
                orgName: branding.orgName,
                pageTitle: branding.pageTitle,
                logoVersion: branding.logoVersion,
                hasLogo: branding.hasLogo,
                coloredBar: coloredBar,
              }}
            />
            {bannerNodes.length > 0 ? (
              <div
                data-slot="layout.banner"
                className="site-shell mx-auto flex w-full max-w-[88rem] flex-col gap-3 px-5 pt-6 sm:px-8 lg:px-16"
              >
                {bannerNodes.map((node, index) => (
                  <Fragment key={index}>{node as ReactNode}</Fragment>
                ))}
              </div>
            ) : null}
            <main className="site-shell mx-auto w-full max-w-[88rem] flex-1 px-5 py-10 sm:px-8 lg:px-16 lg:py-14">
              {children}
            </main>
            <SiteFooter links={footerLinks} />
            <CommandPalette />
            <ReadingControls />
            {ask?.status === "ready" ? (
              <AskLauncher
                providerLabel={ask.providerLabel}
                host={ask.host}
                scope={null}
                repos={ask.repos}
              />
            ) : null}
          </ReadModeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
