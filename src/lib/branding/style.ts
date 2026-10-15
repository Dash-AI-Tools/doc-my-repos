/**
 * Branding style block (org-branding 1.3). Pure: no React, no I/O. The root layout renders
 * this `<style>` in `<head>` when colors are set or a logo needs inversion, and nothing
 * otherwise, so the default render is byte-for-byte what it is today.
 *
 * Every value is filtered: only allow-listed `--var` names with `#rrggbb` values (or the
 * fixed `invert(1)` for the logo) reach the CSS, so a hostile stored string can never
 * influence the output.
 */

import type { DerivedBrandTokens } from "./colors";
import { BRAND_COLOR_RE } from "./validate";

export interface BrandStyleOptions {
  readonly coloredHeader: boolean;
  readonly invertLogo: boolean;
  readonly hasLogo: boolean;
}

const BASE_VARS: readonly string[] = [
  "primary",
  "primary-foreground",
  "link",
  "link-hover",
  "ring",
  "accent",
  "accent-foreground",
  "okf-badge",
  "okf-badge-foreground",
  "selection",
  "selection-foreground",
];

const HEADER_VARS: readonly string[] = [
  "header",
  "header-foreground",
  "header-border",
  "header-ring",
];

const LOGO_FILTER = "invert(1)";

function declarations(
  tokens: Record<string, string> | undefined,
  names: readonly string[],
): string {
  if (!tokens) return "";
  let out = "";
  for (const name of names) {
    const value = tokens[name];
    if (typeof value === "string" && BRAND_COLOR_RE.test(value)) out += `--${name}:${value};`;
  }
  return out;
}

/**
 * CSS overrides for branding. Empty when nothing is set and no logo needs inversion.
 * `html.dark` always carries the inversion when on; `html:root` only when the bar is
 * colored with a white derived foreground.
 */
export function brandStyleBlock(
  derived: DerivedBrandTokens | null,
  options: BrandStyleOptions,
): string {
  const invert = options.hasLogo && options.invertLogo;
  const lightVars = derived
    ? declarations(derived.light, BASE_VARS) +
      (options.coloredHeader ? declarations(derived.light, HEADER_VARS) : "")
    : "";
  const darkVars = derived
    ? declarations(derived.dark, BASE_VARS) +
      (options.coloredHeader ? declarations(derived.dark, HEADER_VARS) : "")
    : "";
  const lightHeaderFg = derived?.light["header-foreground"];
  const rootInvert =
    invert && options.coloredHeader && lightHeaderFg === "#ffffff"
      ? `--logo-filter:${LOGO_FILTER};`
      : "";
  const darkInvert = invert ? `--logo-filter:${LOGO_FILTER};` : "";
  const root = `${lightVars}${rootInvert}`;
  const dark = `${darkVars}${darkInvert}`;
  if (root === "" && dark === "") return "";
  let out = "";
  if (root !== "") out += `html:root{${root}}`;
  if (dark !== "") out += `html.dark{${dark}}`;
  return out;
}
