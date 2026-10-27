import { contrastRatio } from "./theme-tokens";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT, sourceFiles as repoSourceFiles } from "../../../tests/support/repo-files";

import {
  DEFAULT_TEXT_SIZE,
  READ_KEY_COOKIE,
  TEXT_SIZE_COOKIE,
  TEXT_SIZE_STEPS,
  serializePreference,
} from "./reading-prefs";

/**
 * Text size audit guard (reading-accessibility 1.2). The text size control scales everything that
 * is sized in `rem`, so text sized in `px` would ignore the chosen step. This fails when a `px`
 * font size, or a `px` height that holds text, is added under `src/`. Test files are skipped.
 *
 * The audit at the time of writing found none: every font size is `rem` or `em`, the only `px`
 * arbitrary value is `rounded-[2px]` (a radius, not text), and the `0px` fallback of
 * `--doc-bar-h` is a scroll offset.
 */

const SRC = join(REPO_ROOT, "src");

const PX_TEXT_PATTERNS: readonly RegExp[] = [
  /font-size\s*:\s*[\d.]+px/,
  /\btext-\[[\d.]+px\]/,
  /\bleading-\[[\d.]+px\]/,
  /\b(?:min-)?h-\[[\d.]+px\]/,
  /fontSize\s*:\s*["'`]?[\d.]+px/,
];

/** Every non-test source file of the app and the packages, repository-relative. */
function sourceFiles(): string[] {
  return repoSourceFiles().filter((f) => !/\.test\.tsx?$/.test(f) && /\.(tsx?|css)$/.test(f));
}

describe("text scale audit", () => {
  it("has no px font sizes or px heights holding text under src/", () => {
    const hits: string[] = [];
    for (const file of sourceFiles()) {
      readFileSync(join(REPO_ROOT, file), "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (PX_TEXT_PATTERNS.some((pattern) => pattern.test(line))) {
            hits.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("text size CSS matches the library steps", () => {
  const css = readFileSync(join(REPO_ROOT, "packages", "ui", "src", "styles.css"), "utf8");

  it.each(TEXT_SIZE_STEPS.filter((step) => step.id !== DEFAULT_TEXT_SIZE))(
    "$id sets its percent and scale on <html>",
    ({ id, percent, scale }) => {
      const block = new RegExp(`html\\[data-text-size="${id}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1];
      expect(block).toBeDefined();
      expect(block).toContain(`font-size: ${percent}%;`);
      expect(block).toContain(`--text-scale: ${scale};`);
    },
  );

  it("gives Default no rules", () => {
    expect(css).not.toMatch(/html\[data-text-size="default"\]/);
  });
});

describe("README documents the text size preference", () => {
  const readme = readFileSync(join(SRC, "..", "README.md"), "utf8");

  it("names the cookie and every stored value", () => {
    expect(readme).toContain(`\`${TEXT_SIZE_COOKIE}\``);
    for (const step of TEXT_SIZE_STEPS.filter((candidate) => candidate.id !== DEFAULT_TEXT_SIZE)) {
      expect(readme).toContain(`\`${step.id}\``);
    }
  });

  it("states the percent of every step", () => {
    for (const step of TEXT_SIZE_STEPS) {
      expect(readme).toContain(`${step.label} (${step.percent}%)`);
    }
  });

  it("names the shortcut cookie, its off value and the key", () => {
    expect(readme).toContain(`\`${READ_KEY_COOKIE}\``);
    expect(readme).toContain("value \`off\`");
    expect(readme).toContain("**R**");
    expect(serializePreference(READ_KEY_COOKIE, "off", { secure: false })).toMatch(
      new RegExp(`^${READ_KEY_COOKIE}=off;`),
    );
  });
});

describe("DESIGN.md names the read mode mechanism that exists", () => {
  const design = readFileSync(join(SRC, "..", "DESIGN.md"), "utf8");
  const readMode = design.slice(
    design.indexOf("### Read Mode"),
    design.indexOf("### Text Size Control"),
  );
  const sources = sourceFiles().map((file) => readFileSync(join(REPO_ROOT, file), "utf8"));

  it.each([
    "data-read-hide",
    "data-read-mode",
    "data-read-article",
    "data-read-toggle",
    "reader-grid",
    "reader-content",
    "ReadModeTarget",
    "Reading controls",
  ])("%s is described and present in the source", (name) => {
    expect(readMode).toContain(name);
    expect(sources.some((source) => source.includes(name))).toBe(true);
  });
});

describe("read mode paper", () => {
  const css = readFileSync(join(REPO_ROOT, "packages", "ui", "src", "styles.css"), "utf8");
  const block = (selector: string): Record<string, string> => {
    const body = css.split(`${selector} {`)[1]?.split("}")[0] ?? "";
    return Object.fromEntries(
      [...body.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1]!, m[2]!]),
    );
  };
  const PAIRS = [
    ["foreground", "background", 4.5],
    ["muted-foreground", "background", 4.5],
    ["muted-foreground", "muted", 4.5],
    ["link", "background", 4.5],
    ["link", "code-background", 4.5],
    ["code-foreground", "code-background", 4.5],
    ["popover-foreground", "popover", 4.5],
  ] as const;

  it.each([
    ["light", 'html[data-read-mode="true"]'],
    ["dark", 'html.dark[data-read-mode="true"]'],
  ])("%s paper meets contrast minimums", (_name, selector) => {
    const tokens = block(selector);
    for (const [fg, bg, min] of PAIRS) {
      expect(tokens[fg], fg).toBeDefined();
      expect(tokens[bg], bg).toBeDefined();
      expect(contrastRatio(tokens[fg]!, tokens[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
    }
  });

  it("is beige in light and uses a serif face for the document", () => {
    expect(block('html[data-read-mode="true"]').background).toBe("#f5eedc");
    expect(css).toMatch(/\.reader-content \{\s*font-family: var\(--font-serif\)/);
  });
});
