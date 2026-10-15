import { describe, expect, it } from "vitest";

import { contrastRatio, THEME_TOKENS } from "../theme-tokens";
import { deriveBrandTokens, hslToRgb, rgbToHex } from "./colors";

function sweepColors(): string[] {
  const out = new Set<string>([
    "#000000",
    "#ffffff",
    "#808080",
    "#767676",
    "#fef08a",
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#2b59ff",
  ]);
  for (let h = 0; h < 360; h += 30) {
    for (const s of [1, 0.7, 0.4, 0.15]) {
      for (const l of [0.05, 0.25, 0.5, 0.75, 0.95]) {
        const [r, g, b] = hslToRgb(h / 360, s, l);
        out.add(rgbToHex(r, g, b));
      }
    }
  }
  return [...out];
}

/** The tokens as a page renders them: the shipped palette with the branding overrides on top. */
function effective(
  theme: "light" | "dark",
  overrides: Record<string, string>,
): Record<string, string> {
  return { ...THEME_TOKENS[theme], ...overrides };
}

describe("deriveBrandTokens", () => {
  it("returns the fill unchanged when usable", () => {
    const derived = deriveBrandTokens({ primary: "#2b59ff", accent: "#2b59ff" });
    expect(derived.light["primary"]).toBe("#2b59ff");
  });

  it("keeps every text pair at 4.5:1 and every focus/boundary pair at 3:1", () => {
    for (const color of sweepColors()) {
      const derived = deriveBrandTokens({ primary: color, accent: color });
      for (const theme of ["light", "dark"] as const) {
        const t = effective(theme, derived[theme]);
        const surfaces = [
          t["background"] ?? "",
          t["card"] ?? "",
          t["muted"] ?? "",
          t["popover"] ?? "",
          t["code-background"] ?? "",
        ];
        const textPairs: Array<[string, string, string]> = [
          [t["primary-foreground"] ?? "", t["primary"] ?? "", "primary text"],
          [t["link"] ?? "", surfaces[0] ?? "", "link"],
          [t["link-hover"] ?? "", surfaces[0] ?? "", "link hover"],
          [t["accent-foreground"] ?? "", t["accent"] ?? "", "accent"],
          [t["okf-badge-foreground"] ?? "", t["okf-badge"] ?? "", "okf"],
          [t["selection-foreground"] ?? "", t["selection"] ?? "", "selection"],
          [t["header-foreground"] ?? "", t["header"] ?? "", "header"],
          [t["foreground"] ?? "", t["background"] ?? "", "body"],
          [t["foreground"] ?? "", t["card"] ?? "", "card"],
          [t["foreground"] ?? "", t["muted"] ?? "", "text on muted"],
          [t["foreground"] ?? "", t["popover"] ?? "", "popover"],
          [t["secondary-foreground"] ?? "", t["secondary"] ?? "", "secondary"],
          [t["muted-foreground"] ?? "", t["background"] ?? "", "muted text on page"],
          [t["muted-foreground"] ?? "", t["muted"] ?? "", "muted text on muted"],
          [t["muted-foreground"] ?? "", t["card"] ?? "", "muted text on card"],
          [t["muted-foreground"] ?? "", t["popover"] ?? "", "muted text in popover"],
          [t["code-foreground"] ?? "", t["code-background"] ?? "", "code text"],
        ];
        for (const [fg, bg, name] of textPairs) {
          expect(
            contrastRatio(fg, bg),
            `${color} ${theme} ${name} ${fg} on ${bg}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        for (const bg of surfaces) {
          expect(
            contrastRatio(t["link"] ?? "", bg),
            `${color} ${theme} link on ${bg}`,
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            contrastRatio(t["ring"] ?? "", bg),
            `${color} ${theme} ring on ${bg}`,
          ).toBeGreaterThanOrEqual(3);
        }
        expect(
          contrastRatio(t["header-ring"] ?? "", t["header"] ?? ""),
          `${color} ${theme} header ring`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("tints the dark surfaces with the primary but leaves the light ones alone", () => {
    const derived = deriveBrandTokens({ primary: "#2b59ff", accent: "#2b59ff" });
    const background = derived.dark["background"] ?? "";
    const r = parseInt(background.slice(1, 3), 16);
    const g = parseInt(background.slice(3, 5), 16);
    const b = parseInt(background.slice(5, 7), 16);
    // A dark shade of the blue hue: blue dominant, and dark.
    expect(b).toBeGreaterThan(r + 30);
    expect(b).toBeGreaterThan(g + 30);
    expect(Math.max(r, g, b)).toBeLessThan(90);
    expect(derived.dark["card"]).toBe(background);
    expect(derived.dark["muted"]).not.toBe("#151516");
    // The light theme keeps the shipped surfaces.
    expect(derived.light["background"]).toBeUndefined();
  });

  it("keeps a grey primary neutral in the dark theme", () => {
    const background = deriveBrandTokens({ primary: "#808080", accent: "#808080" }).dark[
      "background"
    ];
    expect(background?.slice(1, 3)).toBe(background?.slice(3, 5));
    expect(background?.slice(3, 5)).toBe(background?.slice(5, 7));
  });
});
