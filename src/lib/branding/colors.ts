/**
 * Brand color derivation (org-branding 1.2). Pure: no React, no I/O. Shared by the server
 * layout and the admin preview, so both derive the same tokens from the same two colors.
 * Reuses `contrastRatio` from `theme-tokens.ts`, so the AA guarantee is tested, not argued.
 *
 * Rules (design decision 2):
 * - The chosen color is used unchanged as a fill where readable text can sit on it; the
 *   foreground on a fill is `#ffffff` or `#000000`, whichever contrasts more (always >= 4.5).
 * - Text/focus colors (`link`, `link-hover`, `ring`) are the primary shifted in HSL lightness
 *   (hue and saturation kept) until they meet 4.5:1 (links) or 3:1 (ring) on every surface of
 *   that theme. Light darkens pale colors; dark lightens deep ones; the shift stops at
 *   black/white, which still passes.
 * - Dark `primary` is the lightened variant, so it doubles as readable text on dark surfaces.
 * - Accent/OKF/selection follow the same construction.
 */

import { contrastRatio } from "../theme-tokens";

export interface BrandColorsInput {
  readonly primary: string;
  readonly accent: string;
}

/** Token overrides per theme, keyed by CSS variable name without the leading `--`. */
export type BrandThemeTokens = Record<string, string>;

export interface DerivedBrandTokens {
  readonly light: BrandThemeTokens;
  readonly dark: BrandThemeTokens;
}

const LIGHT_SURFACES = ["#ffffff", "#f5f5f5", "#ffffff", "#ffffff", "#f5f5f5"];
const DARK_SURFACES = ["#0c0c0d", "#151516", "#0c0c0d", "#161617", "#151516"];
const DARK_BG = "#0c0c0d";

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const part = (n: number): string =>
    Math.round(clamp01(n / 255) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ];
}

/** Linear mix of two `#rrggbb` colors; `weight` is the share of `a`. */
export function mixHex(a: string, b: string, weight: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const w = clamp01(weight);
  return rgbToHex(ar * w + br * (1 - w), ag * w + bg * (1 - w), ab * w + bb * (1 - w));
}

/** `#ffffff` or `#000000`, whichever contrasts more on `bg`. */
export function bestForegroundOn(bg: string): string {
  return contrastRatio("#ffffff", bg) >= contrastRatio("#000000", bg) ? "#ffffff" : "#000000";
}

function withLightness(hex: string, l: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [h, s] = rgbToHsl(r, g, b);
  const [nr, ng, nb] = hslToRgb(h, s, clamp01(l));
  return rgbToHex(nr, ng, nb);
}

/**
 * Shift `hex` in HSL lightness (hue/saturation kept) until it meets `min` on every background.
 * Light themes darken first; dark themes lighten first. Stops at black/white.
 */
export function shiftToMeet(
  hex: string,
  backgrounds: readonly string[],
  min: number,
  darken: boolean,
): string {
  const passes = (c: string): boolean => backgrounds.every((bg) => contrastRatio(c, bg) >= min);
  if (passes(hex)) return hex;
  const [r, g, b] = hexToRgb(hex);
  const [, , startL] = rgbToHsl(r, g, b);
  for (let i = 1; i <= 60; i++) {
    const l = darken ? startL - i * 0.02 : startL + i * 0.02;
    if (l < 0 || l > 1) break;
    const candidate = withLightness(hex, l);
    if (passes(candidate)) return candidate;
  }
  // Fallback: the extreme in the shift direction always passes (black on light, white on dark).
  const extreme = darken ? "#000000" : "#ffffff";
  if (passes(extreme)) return extreme;
  return bestForegroundOn(backgrounds[0] ?? "#ffffff") === "#ffffff" ? "#ffffff" : "#000000";
}

function themeTokens(
  primary: string,
  accent: string,
  surfaces: readonly string[],
  darken: boolean,
  darkBg: boolean,
): BrandThemeTokens {
  const link = shiftToMeet(primary, surfaces, 4.5, darken);
  const linkHoverBase = withLightness(
    link,
    (() => {
      const [r, g, b] = hexToRgb(link);
      const [, , l] = rgbToHsl(r, g, b);
      return darken ? l - 0.07 : l + 0.07;
    })(),
  );
  const linkHover = shiftToMeet(linkHoverBase, surfaces, 4.5, darken);
  const ring = shiftToMeet(primary, surfaces, 3, darken);

  const primaryForeground = bestForegroundOn(darkBg ? primary : primary);

  const accentTint = darkBg ? mixHex(accent, DARK_BG, 0.35) : mixHex(accent, "#ffffff", 0.12);
  const accentForeground = darkBg
    ? shiftToMeet(mixHex(accent, "#ffffff", 0.7), [accentTint], 4.5, false)
    : shiftToMeet(accent, [accentTint], 4.5, true);
  // `shiftToMeet` with darken=true on a light tint can return the accent unchanged only when it
  // already passes; otherwise it walks to a darker shade or black. Guarantee the fallback:
  const accentFg =
    contrastRatio(accentForeground, accentTint) >= 4.5
      ? accentForeground
      : bestForegroundOn(accentTint);

  const selection = darkBg ? primary : mixHex(primary, "#ffffff", 0.28);
  const selectionForeground =
    contrastRatio(bestForegroundOn(selection), selection) >= 4.5
      ? bestForegroundOn(selection)
      : darken
        ? "#000000"
        : "#ffffff";

  const header = darkBg ? mixHex(primary, DARK_BG, 0.45) : primary;
  const headerForeground = bestForegroundOn(header);

  return {
    primary,
    "primary-foreground": primaryForeground,
    link,
    "link-hover": linkHover,
    ring,
    accent: accentTint,
    "accent-foreground": accentFg,
    "okf-badge": accentTint,
    "okf-badge-foreground": accentFg,
    selection,
    "selection-foreground": selectionForeground,
    header,
    "header-foreground": headerForeground,
    "header-border": headerForeground,
    "header-ring": headerForeground,
  };
}

/**
 * Derive light and dark token overrides from `{ primary, accent }` (`#rrggbb`). Light `primary`
 * is the input unchanged (a usable fill stays exact); dark `primary` is the lightened variant
 * so it stays readable on dark surfaces.
 */
export function deriveBrandTokens(input: BrandColorsInput): DerivedBrandTokens {
  const lightPrimary = input.primary.toLowerCase();
  const darkPrimary = shiftToMeet(input.primary.toLowerCase(), [DARK_BG], 4.5, false);
  const light = themeTokens(lightPrimary, input.accent.toLowerCase(), LIGHT_SURFACES, true, false);
  const darkInner = themeTokens(
    darkPrimary,
    input.accent.toLowerCase(),
    DARK_SURFACES,
    false,
    true,
  );
  return { light, dark: darkInner };
}
