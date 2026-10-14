"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * App-wide theme provider (task 8.2, design decision 10).
 *
 * Wraps `next-themes`:
 * - `attribute="class"`: the active theme is the `dark` class on `<html>` (none for light). The
 *   Tailwind `dark:` variant, the token block in `src/app/globals.css`, the Shiki dual-theme
 *   rules and `useMermaidTheme()` all read that state.
 * - `defaultTheme="system"` + `enableSystem`: a first visit follows `prefers-color-scheme`, and a
 *   `system` choice reacts live to OS changes.
 * - `storageKey`: the choice (`light` | `dark` | `system`) lives in `localStorage` under this key.
 *   A missing key means "never chose", which is `system`.
 * - `disableTransitionOnChange`: no colour transition ripples through the page on a switch.
 *
 * No flash of the wrong theme: next-themes renders a blocking inline `<script>` as the first
 * child of `<body>` (the layout mounts this provider around all body content). It runs while the
 * parser is still at the top of the body, before any visible content is parsed or painted, and
 * sets the `dark` class from `localStorage` or `matchMedia`. Nothing waits for hydration.
 *
 * CSP (task 12.1): the script is inline, so the strict `script-src` needs a nonce for it. The
 * root layout reads the per-request nonce (`x-nonce`, set by `src/proxy.ts`) and passes it as
 * `nonce`; next-themes puts it on the script (and on the transition-blocking `<style>` it
 * injects, which `style-src 'unsafe-inline'` would allow anyway).
 */

/** `localStorage` key holding `light`, `dark` or `system`. Tests and docs refer to it. */
export const THEME_STORAGE_KEY = "docmyrepos-theme";

export interface ThemeProviderProps {
  readonly children: ReactNode;
  /** Per-request CSP nonce for next-themes' inline script (see above). */
  readonly nonce?: string | undefined;
}

export function ThemeProvider({ children, nonce }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey={THEME_STORAGE_KEY}
      disableTransitionOnChange
      {...(nonce === undefined ? {} : { nonce })}
    >
      {children}
    </NextThemesProvider>
  );
}
