"use client";

import { useTheme } from "next-themes";

import type { MermaidTheme } from "./mermaid-diagram";

/**
 * The Mermaid theme for the active app theme (task 7.7, design decisions 7 and 10).
 *
 * `resolvedTheme` is next-themes' answer after `system` is resolved. It is `undefined` before the
 * provider has mounted and when no `ThemeProvider` is mounted at all (`useTheme` then returns an
 * inert default context and does not throw). Both cases mean `light`. Diagrams are rendered on the
 * client after mount, so a first `light` pass never paints a wrong-themed SVG that the user sees
 * before the real theme arrives: the effect re-runs once the provider reports `dark`.
 */
export function useMermaidTheme(): MermaidTheme {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === "dark" ? "dark" : "light";
}
