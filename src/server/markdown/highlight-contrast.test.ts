import { describe, expect, it } from "vitest";

import { DARK_TOKENS, LIGHT_TOKENS, contrastRatio } from "@/lib/theme-tokens";

import { ensureCodeContrast, MIN_CODE_CONTRAST, rehypeHighlight } from "./highlight";
import { renderMarkdown } from "./pipeline";

/** Task 8.3: every token color Shiki emits meets WCAG AA on the code background of its theme. */

const CORPUS: Readonly<Record<string, string>> = {
  ts: "// comment\n/** doc */\nimport { a } from 'x';\nexport const n: number = 42;\nfunction f<T>(x: T): T { return x; }\nclass A { private b = `t${1}`; }\nconst r = /ab+c/gi;",
  json: '{\n  "a": [1, true, null, "s"],\n  "b": { "c": -1.5e3 }\n}',
  yaml: "# comment\nkey: value\nlist:\n  - a\n  - &anchor b\nmap: { x: 1 }\nmulti: |\n  text",
  bash: '#!/bin/bash\n# comment\nexport A=1\nif [ -f x ]; then echo "$A" | grep -v y > /dev/null; fi',
  diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n context",
  md: "# Title\n\n> quote\n\n- item **bold** *em* `code` [link](http://x)\n\n```js\nx\n```",
  html: "<!-- comment -->\n<div class=\"a\" id='b'>text &amp; <b>bold</b></div>\n<script>let a = 1;</script>",
  css: "/* comment */\n:root { --a: #fff; }\n.a > b:hover { color: red; margin: 0 auto; }\n@media (min-width: 1px) { a { content: 'x'; } }",
  python:
    '# comment\n@decorator\nclass A(B):\n    def f(self, x: int = 1) -> str:\n        """doc"""\n        return f\'{x}\'',
  go: '// comment\npackage main\nimport "fmt"\nfunc main() { x := []int{1}; fmt.Println(x) }',
  rust: '// comment\nuse std::io;\nfn main() -> Result<(), ()> { let x: &str = "s"; println!("{}", x); Ok(()) }',
  sql: "-- comment\nSELECT a, COUNT(*) FROM t WHERE b = 'x' AND c > 1 GROUP BY a;",
  toml: '# comment\n[a]\nb = 1\nc = "d"',
  dockerfile: '# comment\nFROM node:20\nRUN npm ci\nCMD ["node", "x.js"]',
};

function colors(html: string, theme: "light" | "dark"): string[] {
  return [...html.matchAll(new RegExp(`--shiki-${theme}:([^;"]+)`, "g"))].map((m) => m[1] ?? "");
}

describe("ensureCodeContrast", () => {
  it("fixes the GitHub comment color on both backgrounds", () => {
    const light = ensureCodeContrast("#6a737d", "light");
    const dark = ensureCodeContrast("#6a737d", "dark");
    expect(contrastRatio("#6a737d", LIGHT_TOKENS["code-background"])).toBeLessThan(
      MIN_CODE_CONTRAST + 1,
    );
    expect(contrastRatio(light, LIGHT_TOKENS["code-background"])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark, DARK_TOKENS["code-background"])).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps colors that already pass and replaces non-hex values", () => {
    expect(ensureCodeContrast("#005CC5", "light")).toBe("#005cc5");
    expect(ensureCodeContrast("red", "dark")).toBe(DARK_TOKENS["code-foreground"]);
    expect(ensureCodeContrast("#fff8", "light")).toBe(LIGHT_TOKENS["code-foreground"]);
  });
});

describe("emitted token colors", () => {
  for (const [lang, code] of Object.entries(CORPUS)) {
    it(`${lang} meets ${MIN_CODE_CONTRAST}:1 in both themes`, async () => {
      const { html } = await renderMarkdown("```" + lang + "\n" + code + "\n```\n", {
        slots: { highlight: [rehypeHighlight] },
      });
      for (const theme of ["light", "dark"] as const) {
        const found = colors(html, theme);
        expect(found.length, `${lang} ${theme} has colored tokens`).toBeGreaterThan(0);
        const background = (theme === "light" ? LIGHT_TOKENS : DARK_TOKENS)["code-background"];
        for (const color of found) {
          const ratio = contrastRatio(color, background);
          expect(ratio, `${lang} ${theme} ${color}`).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST);
        }
      }
    });
  }
});
