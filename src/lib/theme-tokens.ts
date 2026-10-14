/**
 * Design tokens (task 8.1, design decision 10). The CSS in `src/app/globals.css` is what the
 * browser uses; these constants mirror it so tests (contrast, CSS/constant agreement) and Mermaid
 * (`mermaidThemeVariables`) can read the same values. `theme-tokens.test.ts` fails if the two
 * drift. Keys are the CSS custom property names without the leading `--`.
 *
 * Palette: neutral zinc greys, blue for primary/links/focus, with tinted badge pairs. Dark is a
 * near-black surface with lighter accents rather than an inversion, so contrast is tuned per theme.
 *
 * Worst-case contrast ratios as of task 8.3 (see CONTRAST_PAIRS; the unit test fails on any pair
 * under its minimum):
 *   text pairs (min 4.5), light: link/muted 6.10, link/code-background 6.10, link/card 6.42,
 *     destructive-foreground/destructive 6.47, primary-foreground/primary 6.70
 *   text pairs (min 4.5), dark: selection-foreground/selection 6.70, muted-foreground/muted 6.91,
 *     destructive-foreground/destructive 7.19, muted-foreground/card 7.36
 *   UI pairs (min 3), light: input/card 4.63, ring/muted 4.70; dark: input/card 3.90, input/background 4.12
 *   Shiki comment color #6a737d on code-background: 4.38 light, 3.68 dark, so highlight.ts mixes
 *     any token color under 4.5 toward black/white until it passes (ensureCodeContrast).
 */

export const TOKEN_NAMES = [
  "background",
  "foreground",
  "muted",
  "muted-foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "border",
  "input",
  "ring",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "destructive-muted",
  "destructive-muted-foreground",
  "destructive-muted-border",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "link",
  "link-hover",
  "code-background",
  "code-foreground",
  "selection",
  "selection-foreground",
  "private-badge",
  "private-badge-foreground",
  "okf-badge",
  "okf-badge-foreground",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];
export type TokenSet = Readonly<Record<TokenName, string>>;
export type ThemeName = "light" | "dark";

export const LIGHT_TOKENS: TokenSet = {
  background: "#ffffff",
  foreground: "#18181b",
  muted: "#f4f4f5",
  "muted-foreground": "#52525b",
  card: "#fafafa",
  "card-foreground": "#18181b",
  popover: "#ffffff",
  "popover-foreground": "#18181b",
  border: "#d4d4d8",
  input: "#71717a",
  ring: "#2563eb",
  primary: "#1d4ed8",
  "primary-foreground": "#ffffff",
  secondary: "#f4f4f5",
  "secondary-foreground": "#18181b",
  accent: "#e0e7ff",
  "accent-foreground": "#1e3a8a",
  destructive: "#b91c1c",
  "destructive-foreground": "#ffffff",
  "destructive-muted": "#fef2f2",
  "destructive-muted-foreground": "#7f1d1d",
  "destructive-muted-border": "#fca5a5",
  success: "#dcfce7",
  "success-foreground": "#14532d",
  warning: "#fef3c7",
  "warning-foreground": "#78350f",
  link: "#1d4ed8",
  "link-hover": "#1e3a8a",
  "code-background": "#f4f4f5",
  "code-foreground": "#18181b",
  selection: "#bfdbfe",
  "selection-foreground": "#0f172a",
  "private-badge": "#ede9fe",
  "private-badge-foreground": "#4c1d95",
  "okf-badge": "#ccfbf1",
  "okf-badge-foreground": "#134e4a",
};

export const DARK_TOKENS: TokenSet = {
  background: "#09090b",
  foreground: "#fafafa",
  muted: "#18181b",
  "muted-foreground": "#a1a1aa",
  card: "#111113",
  "card-foreground": "#fafafa",
  popover: "#18181b",
  "popover-foreground": "#fafafa",
  border: "#3f3f46",
  input: "#71717a",
  ring: "#60a5fa",
  primary: "#60a5fa",
  "primary-foreground": "#09090b",
  secondary: "#27272a",
  "secondary-foreground": "#fafafa",
  accent: "#1e3a8a",
  "accent-foreground": "#dbeafe",
  destructive: "#f87171",
  "destructive-foreground": "#09090b",
  "destructive-muted": "#450a0a",
  "destructive-muted-foreground": "#fecaca",
  "destructive-muted-border": "#991b1b",
  success: "#052e16",
  "success-foreground": "#bbf7d0",
  warning: "#422006",
  "warning-foreground": "#fde68a",
  link: "#7db4ff",
  "link-hover": "#bfdbfe",
  "code-background": "#18181b",
  "code-foreground": "#e4e4e7",
  selection: "#1d4ed8",
  "selection-foreground": "#ffffff",
  "private-badge": "#2e1065",
  "private-badge-foreground": "#ddd6fe",
  "okf-badge": "#042f2e",
  "okf-badge-foreground": "#99f6e4",
};

export const THEME_TOKENS: Readonly<Record<ThemeName, TokenSet>> = {
  light: LIGHT_TOKENS,
  dark: DARK_TOKENS,
};

export interface ContrastPair {
  readonly foreground: TokenName;
  readonly background: TokenName;
  /** WCAG 2.x minimum ratio: 4.5 for text, 3 for large text and UI components. */
  readonly min: number;
  readonly reason: string;
}

const text = (foreground: TokenName, background: TokenName, reason: string): ContrastPair => ({
  foreground,
  background,
  min: 4.5,
  reason,
});

/** Every foreground/background combination the UI uses, with the WCAG AA minimum it must meet. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  text("foreground", "background", "body text"),
  text("foreground", "muted", "text on muted surfaces"),
  text("card-foreground", "card", "card text"),
  text("popover-foreground", "popover", "popover text"),
  text("muted-foreground", "background", "muted text on page"),
  text("muted-foreground", "muted", "muted text on muted surface"),
  text("muted-foreground", "card", "muted text on card"),
  text("muted-foreground", "popover", "muted text in the command palette"),
  text("foreground", "popover", "result text in the command palette"),
  text("link", "popover", "See all results link in the command palette"),
  text("link", "background", "link on page"),
  text("link", "muted", "link on muted surface"),
  text("link", "card", "link on card"),
  text("link", "code-background", "link next to code"),
  text("link-hover", "background", "link hover"),
  text("primary-foreground", "primary", "primary button"),
  text("secondary-foreground", "secondary", "secondary button"),
  text("accent-foreground", "accent", "accent surface"),
  text("destructive-foreground", "destructive", "destructive button"),
  text("destructive-muted-foreground", "destructive-muted", "error box"),
  text("success-foreground", "success", "success badge"),
  text("warning-foreground", "warning", "warning badge"),
  text("private-badge-foreground", "private-badge", "private repository badge"),
  text("okf-badge-foreground", "okf-badge", "OKF / type badge"),
  text("code-foreground", "code-background", "code text"),
  text("foreground", "code-background", "text beside inline code"),
  text("selection-foreground", "selection", "selected text"),
  { foreground: "ring", background: "background", min: 3, reason: "focus ring on page" },
  { foreground: "ring", background: "card", min: 3, reason: "focus ring on card" },
  { foreground: "ring", background: "muted", min: 3, reason: "focus ring on muted surface" },
  {
    foreground: "ring",
    background: "popover",
    min: 3,
    reason: "focus ring in the command palette",
  },
  {
    foreground: "input",
    background: "popover",
    min: 3,
    reason: "button border in the command palette",
  },
  { foreground: "ring", background: "code-background", min: 3, reason: "focus ring on code" },
  { foreground: "input", background: "background", min: 3, reason: "form control border" },
  { foreground: "input", background: "card", min: 3, reason: "form control border on card" },
  { foreground: "primary", background: "background", min: 3, reason: "primary on page (UI)" },
  { foreground: "destructive", background: "background", min: 3, reason: "destructive (UI)" },
];

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) throw new Error(`Expected #rrggbb, got ${hex}`);
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => channel(parseInt(part ?? "", 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG contrast ratio between two `#rrggbb` colors, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Mermaid `base` theme variables derived from the tokens, so diagrams match the page. Consumed by
 * `mermaid-diagram.tsx`. Only plain `#rrggbb` values (Mermaid derives lighter/darker shades from
 * them and does not parse CSS variables).
 */
export function mermaidThemeVariables(theme: ThemeName): Record<string, string | boolean> {
  const t = THEME_TOKENS[theme];
  return {
    darkMode: theme === "dark",
    background: t.background,
    mainBkg: t.accent,
    primaryColor: t.accent,
    primaryTextColor: t["accent-foreground"],
    primaryBorderColor: t.primary,
    secondaryColor: t.secondary,
    secondaryTextColor: t["secondary-foreground"],
    secondaryBorderColor: t.border,
    tertiaryColor: t.muted,
    tertiaryTextColor: t["muted-foreground"],
    tertiaryBorderColor: t.border,
    noteBkgColor: t.warning,
    noteTextColor: t["warning-foreground"],
    noteBorderColor: t.border,
    lineColor: t["muted-foreground"],
    textColor: t.foreground,
    titleColor: t.foreground,
    nodeBorder: t.primary,
    clusterBkg: t.muted,
    clusterBorder: t.border,
    edgeLabelBackground: t.background,
    labelBackground: t.background,
    actorBkg: t.accent,
    actorTextColor: t["accent-foreground"],
    actorBorder: t.primary,
    actorLineColor: t["muted-foreground"],
    signalColor: t.foreground,
    signalTextColor: t.foreground,
    labelBoxBkgColor: t.muted,
    labelBoxBorderColor: t.border,
    labelTextColor: t.foreground,
    loopTextColor: t.foreground,
    activationBkgColor: t.secondary,
    activationBorderColor: t.border,
    sequenceNumberColor: t["primary-foreground"],
    errorBkgColor: t["destructive-muted"],
    errorTextColor: t["destructive-muted-foreground"],
  };
}
