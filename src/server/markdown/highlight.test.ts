import type { Element, Root } from "hast";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VFile } from "vfile";

import { assertSafeHtml } from "./assert-safe-html";
import {
  getHighlighter,
  MAX_BLOCKS,
  MAX_BLOCK_CHARS,
  PRELOADED_LANGUAGES,
  rehypeHighlight,
  resetHighlighterForTests,
  resolveLanguage,
  WARN_BLOCK_TOO_LARGE,
  WARN_BUDGET,
  WARN_TOO_MANY_BLOCKS,
} from "./highlight";
import { renderMarkdown } from "./pipeline";

const created = vi.hoisted(() => ({ count: 0 }));

vi.mock("shiki", async (importOriginal) => {
  const actual = await importOriginal<typeof import("shiki")>();
  return {
    ...actual,
    createHighlighter: ((...args: Parameters<typeof actual.createHighlighter>) => {
      created.count++;
      return actual.createHighlighter(...args);
    }) as typeof actual.createHighlighter,
  };
});

const slots = { highlight: [rehypeHighlight] };

async function render(source: string) {
  const result = await renderMarkdown(source, { slots });
  assertSafeHtml(result.html);
  return result;
}

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```\n";

describe("known languages", () => {
  it("highlights ts with both theme variables", async () => {
    const { html, warnings } = await render(fence("ts", "const a: string = 'x';"));
    expect(html).toContain('<pre class="shiki shiki-themes"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain('<span class="line">');
    expect(html).toMatch(
      /<span style="--shiki-light:#[0-9a-fA-F]{6};--shiki-dark:#[0-9a-fA-F]{6}">/,
    );
    expect(html).toMatch(/--shiki-light-bg:#[0-9a-fA-F]+;--shiki-dark-bg:#[0-9a-fA-F]+/);
    expect(html).not.toContain("github-light");
    expect(warnings).toEqual([]);
  });

  it.each(["typescript", "sh", "TS", "yml", "py"])("resolves alias %s", async (lang) => {
    const { html } = await render(fence(lang, "x = 1"));
    expect(html).toContain("shiki");
    expect(html).toContain("--shiki-light:");
  });

  it("keeps the exact text and escapes markup inside code", async () => {
    const { html } = await render(fence("ts", 'const s = "<script>alert(1)</script>"; // & <b>'));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&#x3C;script>");
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).toContain("alert(1)");
  });

  it("preloaded languages all resolve", () => {
    for (const lang of PRELOADED_LANGUAGES) expect(resolveLanguage(lang)).toBe(lang);
  });

  it("loads a rarer bundled language on demand", async () => {
    const { html } = await render(fence("haskell", 'main = putStrLn "hi"'));
    expect(html).toContain('<pre class="shiki shiki-themes"');
  });

  it("highlights italic or bold token styles through allowed variables only", async () => {
    const { html } = await render(fence("ts", "// comment\nconst a = 1;\n"));
    for (const m of html.matchAll(/style="([^"]*)"/g)) {
      expect(m[1]).toMatch(/^(--shiki-[a-z-]+:[#a-zA-Z0-9]+;?)+$/);
    }
  });
});

describe("plain text", () => {
  it.each(["madeuplang", "text", "plaintext", "txt", ""])(
    "leaves %j as plain pre/code",
    async (lang) => {
      const { html } = await render(fence(lang, "a < b && c"));
      expect(html).not.toContain("shiki");
      expect(html).not.toContain("style=");
      expect(html).toContain("a &#x3C; b &#x26;&#x26; c");
    },
  );

  it("keeps the language class on an unknown language", async () => {
    const { html } = await render(fence("madeuplang", "x"));
    expect(html).toContain('<pre><code class="language-madeuplang">x\n</code></pre>');
  });

  it("no-language fence has no class", async () => {
    const { html } = await render(fence("", "x"));
    expect(html).toBe("<pre><code>x\n</code></pre>");
  });

  it("leaves mermaid untouched", async () => {
    const plain = await renderMarkdown(fence("mermaid", "graph TD; A-->B"));
    const { html } = await render(fence("mermaid", "graph TD; A-->B"));
    expect(html).toBe(plain.html);
    expect(html).not.toContain("shiki");
  });

  it("does not touch inline code or a pre with other content", async () => {
    const { html } = await render("use `ts` here\n\n<pre>raw <b>x</b></pre>\n");
    expect(html).not.toContain("shiki");
    expect(html).toContain("<code>ts</code>");
  });
});

describe("hostile language strings", () => {
  const hostile = [
    'ts" onerror="x',
    "ts' style='color:red",
    "a".repeat(5000),
    "日本語",
    "../../x",
    "..%2f..%2fetc/passwd",
    "constructor",
    "__proto__",
    "toString",
    "ts;background:url(x)",
    "ts<script>",
    "node:fs",
    "file:///etc/passwd",
  ];

  it.each(hostile)("never throws and never highlights %j", async (lang) => {
    const { html } = await render("```" + lang.replace(/\n/g, " ") + "\nconst a = 1;\n```\n");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("url(");
    expect(html).not.toContain("<script");
    expect(html).toContain("const a = 1;");
    expect(html).not.toContain("--shiki");
  });

  it("resolveLanguage accepts only bundled names", () => {
    expect(resolveLanguage("TypeScript")).toBe("typescript");
    for (const bad of ["", "../x", "a/b", "a b", "constructor", "x".repeat(33), "hasOwnProperty"]) {
      expect(resolveLanguage(bad)).toBeUndefined();
    }
  });

  it("drops style injected through an authored pre", async () => {
    const { html } = await render(
      '<pre class="shiki" style="background:url(javascript:x);color:red"><code class="language-ts">x</code></pre>\n',
    );
    expect(html).not.toContain("url(");
    expect(html).not.toContain("javascript");
  });
});

describe("bounds", () => {
  it("skips a block over the size limit and warns", async () => {
    const big = "x".repeat(MAX_BLOCK_CHARS + 1);
    const { html, warnings } = await render(fence("ts", big) + fence("ts", "const a = 1;"));
    expect(warnings).toContain(WARN_BLOCK_TOO_LARGE);
    expect(html.match(/<pre class="shiki/g)).toHaveLength(1);
  });

  it("highlights at most MAX_BLOCKS blocks and warns", async () => {
    const doc = Array.from({ length: MAX_BLOCKS + 5 }, () => fence("ts", "a;")).join("\n");
    const { html, warnings } = await render(doc);
    expect(html.match(/<pre class="shiki/g)).toHaveLength(MAX_BLOCKS);
    expect(html.match(/<pre>/g)).toHaveLength(5);
    expect(warnings).toContain(WARN_TOO_MANY_BLOCKS);
  });

  it("stops at the total character budget and warns (plugin on a large tree)", async () => {
    const block = (): Element => ({
      type: "element",
      tagName: "pre",
      properties: {},
      children: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-ts"] },
          children: [{ type: "text", value: "a;\n".repeat(30 * 1024) }],
        },
      ],
    });
    const tree: Root = { type: "root", children: Array.from({ length: 8 }, block) };
    const file = new VFile();
    await rehypeHighlight()(tree, file);
    const kinds = tree.children.map((c) =>
      c.type === "element" && String(c.properties.className).includes("shiki") ? "h" : "p",
    );
    expect(kinds.filter((k) => k === "h").length).toBeGreaterThan(0);
    expect(kinds.filter((k) => k === "p").length).toBeGreaterThan(0);
    expect(file.data.warnings).toContain(WARN_BUDGET);
  });

  it("renders a 256 KB document of code in bounded time", async () => {
    const line =
      "export function f(a: number, b: string): Promise<void> { return g(a, `${b}`); }\n";
    const doc = fence("ts", line.repeat(Math.floor((60 * 1024) / line.length))).repeat(4);
    await getHighlighter();
    const t = Date.now();
    const { html, warnings } = await render(doc);
    const ms = Date.now() - t;
    expect(html).toContain("shiki");
    // The highlighter itself stops after ~1 s of work; allow headroom for the rest of the
    // pipeline and for a loaded CI machine running the whole suite in parallel.
    expect(ms).toBeLessThan(4000);
    expect(warnings).toContain(WARN_BUDGET);
  });

  it("does not blow up on one very long line", async () => {
    const t = Date.now();
    const { html } = await render(fence("json", '{"a":"' + "x".repeat(90 * 1024) + '"}'));
    expect(Date.now() - t).toBeLessThan(3000);
    expect(html).toContain("<pre");
  });
});

describe("highlighter singleton", () => {
  beforeEach(() => {
    resetHighlighterForTests();
    created.count = 0;
  });

  it("is created once for concurrent and repeated renders", async () => {
    await Promise.all([
      render(fence("ts", "a")),
      render(fence("js", "b")),
      render(fence("go", "c")),
    ]);
    await render(fence("python", "d"));
    expect(created.count).toBe(1);
  });

  it("is not created for a document with no highlightable block", async () => {
    await render(fence("madeuplang", "a") + fence("mermaid", "x"));
    expect(created.count).toBe(0);
  });
});
