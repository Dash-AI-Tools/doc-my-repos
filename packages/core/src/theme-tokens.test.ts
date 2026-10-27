import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT, sourceFiles } from "../../../tests/support/repo-files";

import {
  CONTRAST_PAIRS,
  THEME_TOKENS,
  TOKEN_NAMES,
  contrastRatio,
  mermaidThemeVariables,
  type ThemeName,
  type TokenName,
} from "./theme-tokens";

const ROOT = REPO_ROOT;
const THEMES: readonly ThemeName[] = ["light", "dark"];

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // #767676 on white is the well-known 4.54:1 AA boundary grey.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#ffffff", "#767676")).toBeCloseTo(
      contrastRatio("#767676", "#ffffff"),
      10,
    );
  });

  it("rejects values that are not #rrggbb", () => {
    expect(() => contrastRatio("red", "#ffffff")).toThrow();
    expect(() => contrastRatio("#fff", "#ffffff")).toThrow();
  });
});

describe("token palettes", () => {
  it("define every token in both themes as #rrggbb", () => {
    for (const theme of THEMES) {
      expect(Object.keys(THEME_TOKENS[theme]).sort()).toEqual([...TOKEN_NAMES].sort());
      for (const name of TOKEN_NAMES) {
        expect(THEME_TOKENS[theme][name], `${theme} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("differ between themes for the page colors", () => {
    expect(THEME_TOKENS.light.background).not.toBe(THEME_TOKENS.dark.background);
    expect(THEME_TOKENS.light.foreground).not.toBe(THEME_TOKENS.dark.foreground);
  });

  for (const theme of THEMES) {
    describe(`WCAG AA contrast, ${theme} theme`, () => {
      for (const pair of CONTRAST_PAIRS) {
        it(`${pair.reason}: ${pair.foreground} on ${pair.background} >= ${pair.min}`, () => {
          const ratio = contrastRatio(
            THEME_TOKENS[theme][pair.foreground],
            THEME_TOKENS[theme][pair.background],
          );
          expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(pair.min);
        });
      }
    });
  }

  it("check every text-bearing token against at least one background", () => {
    const covered = new Set<TokenName>(CONTRAST_PAIRS.map((p) => p.foreground));
    for (const name of TOKEN_NAMES.filter((n) => n.endsWith("-foreground") || n === "link")) {
      expect(covered.has(name), name).toBe(true);
    }
  });
});

describe("globals.css mirrors the constants", () => {
  const css = readFileSync(join(REPO_ROOT, "packages", "ui", "src", "styles.css"), "utf8");

  function declarations(selector: string): Map<string, string> {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
    const end = css.indexOf("}", start);
    const map = new Map<string, string>();
    for (const m of css.slice(start, end).matchAll(/--([a-z-]+):\s*([^;]+);/g)) {
      map.set(m[1] ?? "", (m[2] ?? "").trim().toLowerCase());
    }
    return map;
  }

  for (const [theme, selector] of [
    ["light", ":root"],
    ["dark", ".dark"],
  ] as const) {
    it(`${selector} declares the ${theme} tokens exactly`, () => {
      const found = declarations(selector);
      expect([...found.keys()].sort()).toEqual([...TOKEN_NAMES].sort());
      for (const name of TOKEN_NAMES) {
        expect(found.get(name), `${theme} ${name}`).toBe(THEME_TOKENS[theme][name]);
      }
    });
  }

  it("sets color-scheme for both themes", () => {
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light;/);
    expect(css).toMatch(/\.dark\s*\{[^}]*color-scheme:\s*dark;/);
  });

  it("exposes every token as a Tailwind color", () => {
    for (const name of TOKEN_NAMES) {
      expect(css, name).toContain(`--color-${name}: var(--${name});`);
    }
  });
});

describe("mermaidThemeVariables", () => {
  it("uses plain hex colors from the tokens in each theme", () => {
    for (const theme of THEMES) {
      const vars = mermaidThemeVariables(theme);
      expect(vars.darkMode).toBe(theme === "dark");
      expect(vars.textColor).toBe(THEME_TOKENS[theme].foreground);
      for (const [key, value] of Object.entries(vars)) {
        if (typeof value === "string" && key !== "dropShadow") {
          expect(value, key).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it("draws diagrams flat: no drop shadow on nodes", () => {
    for (const theme of THEMES) expect(mermaidThemeVariables(theme).dropShadow).toBe("none");
  });

  it("keeps node text readable on node fill and on the page", () => {
    for (const theme of THEMES) {
      const v = mermaidThemeVariables(theme);
      expect(contrastRatio(String(v.primaryTextColor), String(v.primaryColor))).toBeGreaterThan(
        4.5,
      );
      expect(contrastRatio(String(v.textColor), String(v.background))).toBeGreaterThan(4.5);
      expect(contrastRatio(String(v.lineColor), String(v.background))).toBeGreaterThan(3);
    }
  });
});

/**
 * Lint-like guard: components and pages take colors from the tokens only. A raw Tailwind palette
 * utility (`bg-gray-100`, `text-red-900`, `dark:border-blue-400`, ...), an arbitrary color value
 * or a hex literal bypasses the theme. Add a file to ALLOWLIST (with the reason) only if it truly
 * needs a fixed color.
 */
describe("no raw colors outside the tokens", () => {
  const ALLOWLIST: ReadonlyMap<string, string> = new Map();
  const PALETTES =
    "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
  const UTILITIES =
    "bg|text|border|border-[trblxy]|ring|ring-offset|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|shadow|placeholder";
  const palette = new RegExp(`(?:^|[^\\w-])(?:${UTILITIES})-(?:${PALETTES})-\\d{2,3}\\b`);
  const plain = /(?:^|[^\w-])(?:bg|text|border|ring|outline|fill|stroke)-(?:white|black)\b/;
  const arbitrary = /(?:bg|text|border|ring|outline|fill|stroke)-\[(?:#|rgb|hsl|oklch)/;
  const hex = /#[0-9a-fA-F]{3,8}\b/;

  // The UI: the app's route files and every component, wherever it lives.
  const files = sourceFiles()
    .filter((f) => /^(src\/app|src\/components|packages\/ui\/src)\//.test(f))
    .map((f) => join(ROOT, f))
    .filter(
      (f) =>
        /\.(tsx?|css)$/.test(f) &&
        !/\.test\.tsx?$/.test(f) &&
        !f.endsWith("globals.css") &&
        !f.endsWith("styles.css"),
    );

  it("finds the files to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("flags what it should (self test)", () => {
    expect(palette.test('className="bg-gray-100"')).toBe(true);
    expect(palette.test('className="x dark:text-red-900"')).toBe(true);
    expect(palette.test('className="bg-background text-muted-foreground"')).toBe(false);
    expect(plain.test('className="bg-white/80"')).toBe(true);
    expect(arbitrary.test('className="bg-[#fff]"')).toBe(true);
  });

  for (const file of files) {
    const name = relative(ROOT, file);
    it(`${name} uses tokens only`, () => {
      if (ALLOWLIST.has(name)) return;
      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, i) => {
        const where = `${name}:${i + 1}`;
        expect(palette.test(line), `${where} raw palette utility`).toBe(false);
        expect(plain.test(line), `${where} raw white/black utility`).toBe(false);
        expect(arbitrary.test(line), `${where} arbitrary color`).toBe(false);
        expect(hex.test(line), `${where} hex literal`).toBe(false);
      });
    });
  }

  it("keeps hex values in globals.css inside the token blocks and Shiki-independent rules", () => {
    const css = readFileSync(join(REPO_ROOT, "packages", "ui", "src", "styles.css"), "utf8");
    // The read mode paper blocks are the one other place: they re-point the same tokens, and
    // text-scale.test.ts checks their contrast.
    const outside = css.replace(
      /\n(?::root|\.dark|html(?:\.dark)?\[data-read-mode="true"\]) \{[^}]*\}/g,
      "",
    );
    expect(outside.match(hex), "hex outside the token blocks").toBeNull();
  });
});
