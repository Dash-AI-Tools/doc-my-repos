import { describe, expect, it } from "vitest";

import { contrastRatio } from "../theme-tokens";
import { deriveBrandTokens, hslToRgb, rgbToHex } from "./colors";

const LIGHT_BG = ["#ffffff", "#f5f5f5", "#ffffff", "#ffffff", "#f5f5f5"];
const DARK_BG = ["#0c0c0d", "#151516", "#0c0c0d", "#161617", "#151516"];

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

describe("deriveBrandTokens", () => {
  it("returns the fill unchanged when usable", () => {
    const derived = deriveBrandTokens({ primary: "#2b59ff", accent: "#2b59ff" });
    expect(derived.light["primary"]).toBe("#2b59ff");
  });

  it("keeps every text pair at 4.5:1 and every focus/boundary pair at 3:1", () => {
    for (const color of sweepColors()) {
      const derived = deriveBrandTokens({ primary: color, accent: color });
      for (const [theme, surfaces] of [
        ["light", LIGHT_BG],
        ["dark", DARK_BG],
      ] as const) {
        const t = derived[theme];
        const textPairs: Array<[string, string, string]> = [
          [t["primary-foreground"] ?? "", t["primary"] ?? "", "primary text"],
          [t["link"] ?? "", surfaces[0] ?? "", "link"],
          [t["link-hover"] ?? "", surfaces[0] ?? "", "link hover"],
          [t["accent-foreground"] ?? "", t["accent"] ?? "", "accent"],
          [t["okf-badge-foreground"] ?? "", t["okf-badge"] ?? "", "okf"],
          [t["selection-foreground"] ?? "", t["selection"] ?? "", "selection"],
          [t["header-foreground"] ?? "", t["header"] ?? "", "header"],
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
});
