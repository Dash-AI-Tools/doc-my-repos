import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import GithubSlugger from "github-slugger";
import { describe, expect, it } from "vitest";

import { extractMetadata } from "../docs/extract";
import { parseFrontmatter } from "../docs/frontmatter";
import { createProcessor, MAX_RENDER_CHARS, renderMarkdown } from "./pipeline";
import { rehypeSafeHtml, SANITIZE_SCHEMA } from "./sanitize";

async function html(source: string): Promise<string> {
  return (await renderMarkdown(source)).html;
}

describe("GFM", () => {
  it("renders a table with column alignment", async () => {
    const out = await html("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n");
    expect(out).toContain("<table>");
    expect(out).toContain('<th align="left">a</th>');
    expect(out).toContain('<th align="center">b</th>');
    expect(out).toContain('<th align="right">c</th>');
    expect(out).toContain('<td align="right">3</td>');
  });

  it("renders task lists with disabled checkboxes and the checked state", async () => {
    const out = await html("- [x] done\n- [ ] todo\n- plain\n");
    expect(out).toContain('<ul class="contains-task-list">');
    expect(out).toContain(
      '<li class="task-list-item"><input type="checkbox" checked disabled aria-label="Task item"> done</li>',
    );
    expect(out).toContain(
      '<li class="task-list-item"><input type="checkbox" disabled aria-label="Task item"> todo</li>',
    );
    expect(out).toContain("<li>plain</li>");
    expect(out.match(/<input/g)).toHaveLength(2);
    expect(out.match(/disabled/g)).toHaveLength(2);
  });

  it("renders footnotes with a reference, a definition and a back-link", async () => {
    const out = await html("Text[^1] here.\n\n[^1]: The note.\n");
    expect(out).toContain('<a href="#user-content-fn-1" id="user-content-fnref-1"');
    expect(out).toContain('<li id="user-content-fn-1">');
    expect(out).toContain('href="#user-content-fnref-1"');
    expect(out).toContain("data-footnote-backref");
    expect(out).toContain('<h2 class="sr-only" id="footnote-label">Footnotes</h2>');
    expect(out).toContain("The note.");
  });

  it("renders strikethrough", async () => {
    expect(await html("~~gone~~")).toBe("<p><del>gone</del></p>");
  });

  it("links autolink literals", async () => {
    const out = await html("see https://example.com and www.example.org and me@example.com");
    expect(out).toContain(
      '<a href="https://example.com" rel="nofollow noopener noreferrer">https://example.com</a>',
    );
    expect(out).toContain(
      '<a href="http://www.example.org" rel="nofollow noopener noreferrer">www.example.org</a>',
    );
    expect(out).toContain('<a href="mailto:me@example.com">me@example.com</a>');
  });

  it("returns an empty string for an empty document", async () => {
    const result = await renderMarkdown("");
    expect(result.html).toBe("");
    expect(result.headings).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("treats CRLF and LF alike", async () => {
    const lf = "# Title\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect((await renderMarkdown(crlf)).html).toBe((await renderMarkdown(lf)).html);
    expect((await renderMarkdown(crlf)).headings).toEqual((await renderMarkdown(lf)).headings);
  });
});

describe("frontmatter", () => {
  it("never renders the frontmatter block", async () => {
    const result = await renderMarkdown("---\ntitle: Secret Title\ntype: concept\n---\n# Hello\n");
    expect(result.html).not.toContain("Secret Title");
    expect(result.html).not.toContain("type: concept");
    expect(result.html).toContain('id="hello"');
    expect(result.headings.map((h) => h.text)).toEqual(["Hello"]);
  });

  it("keeps an invalid frontmatter block as prose", async () => {
    const result = await renderMarkdown("---\nnot: [valid\n---\ntext\n");
    expect(result.html).toContain("text");
  });
});

describe("heading anchors", () => {
  it("gives a heading a stable id and an accessible link", async () => {
    const out = await html("## Getting Started\n");
    expect(out).toContain('<h2 id="getting-started">Getting Started');
    expect(out).toContain(
      '<a class="heading-anchor" href="#getting-started" aria-label="Link to section: Getting Started"></a>',
    );
  });

  it("numbers duplicates x, x-1, x-2 in document order", async () => {
    const result = await renderMarkdown("# A\n\n## A\n\n### A\n");
    expect(result.headings.map((h) => h.slug)).toEqual(["a", "a-1", "a-2"]);
    expect(result.html).toContain('id="a"');
    expect(result.html).toContain('id="a-1"');
    expect(result.html).toContain('id="a-2"');
  });

  it("slugs emoji-only headings to empty and gives them no id or link", async () => {
    const result = await renderMarkdown("## 🎉\n\n## Next\n");
    expect(result.headings).toEqual([
      { depth: 2, text: "🎉", slug: "" },
      { depth: 2, text: "Next", slug: "next" },
    ]);
    expect(result.html).toContain("<h2>🎉</h2>");
  });

  it("counts empty headings in the duplicate numbering, like extractMetadata", async () => {
    const source = "#\n\n## \n\n# A\n";
    const rendered = await renderMarkdown(source);
    const extracted = extractMetadata({ body: source, frontmatter: {}, path: "a.md" }).headings;
    expect(rendered.headings).toEqual(extracted);
    // The two empty headings took "" and "-1", so "A" is "a".
    expect(rendered.headings).toEqual([{ depth: 1, text: "A", slug: "a" }]);
  });

  it("slugs the plain text of inline code, links and emphasis", async () => {
    const result = await renderMarkdown("## `code` and [a link](http://x.y) *em*\n");
    expect(result.headings).toEqual([
      { depth: 2, text: "code and a link em", slug: "code-and-a-link-em" },
    ]);
    expect(result.html).toContain('id="code-and-a-link-em"');
    expect(result.html).toContain(
      '<a href="http://x.y" rel="nofollow noopener noreferrer">a link</a>',
    );
  });

  it("slugs setext headings and headings inside lists and quotes", async () => {
    const result = await renderMarkdown("Title\n=====\n\n> ## Quoted\n\n- ## In list\n");
    expect(result.headings.map((h) => h.slug)).toEqual(["title", "quoted", "in-list"]);
  });

  it("does not make headings out of fenced code", async () => {
    const result = await renderMarkdown("```\n# not a heading\n```\n\n# Real\n");
    expect(result.headings.map((h) => h.slug)).toEqual(["real"]);
  });

  it("uses github-slugger's algorithm on the heading text", async () => {
    const texts = [
      "Getting Started",
      "Hello, World!",
      "API v2.0 (beta)",
      "Über uns",
      "Getting Started",
    ];
    const result = await renderMarkdown(texts.map((t) => `## ${t}`).join("\n\n"));
    const slugger = new GithubSlugger();
    expect(result.headings.map((h) => h.slug)).toEqual(texts.map((t) => slugger.slug(t)));
  });

  it("is stable across runs", async () => {
    const source = "# A\n\n## B\n\n## B\n\ntext\n";
    const first = await renderMarkdown(source);
    const second = await renderMarkdown(source);
    expect(second).toEqual(first);
  });

  it("is not affected by a heading written in raw HTML", async () => {
    const result = await renderMarkdown('<h2 id="x">Raw</h2>\n\n## Real\n');
    expect(result.headings.map((h) => h.slug)).toEqual(["real"]);
    expect(result.html).not.toContain('heading-anchor" href="#x"');
  });
});

describe("untrusted content (basic; the full XSS suite is in sanitize.test.ts and xss.test.ts)", () => {
  it("strips script elements and event handlers", async () => {
    const out = await html('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("onerror");
    expect(out).toContain('<img src="x" loading="lazy">');
  });

  it("does not render a javascript: link as a link", async () => {
    const out = await html("[x](javascript:alert(1))\n");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("href=");
  });

  it("leaves MDX syntax inert", async () => {
    const out = await html(
      "import Thing from './thing'\n\n<Thing onClick={() => alert(1)}>inside</Thing>\n\nexport const a = 1\n\n{1 + 1}\n",
    );
    expect(out).not.toContain("<Thing");
    expect(out).not.toContain("<thing");
    // The tag is not valid HTML, so it comes out as escaped text, never as an element.
    expect(out).toContain("&#x3C;Thing onClick");
    expect(out).toContain("<p>import Thing from './thing'</p>");
    expect(out).toContain("inside");
    expect(out).toContain("<p>{1 + 1}</p>");
  });

  it("drops ids that author HTML puts on ordinary elements", async () => {
    const out = await html('<div id="cookie" name="x" class="y">hi</div>\n');
    expect(out).toBe("<div>hi</div>");
  });

  it("keeps ids on headings but no id on an author link", async () => {
    const out = await html('<a id="evil" href="#x">y</a>\n');
    expect(out).not.toContain("evil");
  });

  it("always applies the sanitizer, last before stringify, with no clobber prefix", async () => {
    const attachers = createProcessor().attachers.map(([plugin]) => plugin);
    expect(attachers.at(-2)).toBe(rehypeSafeHtml);
    expect(SANITIZE_SCHEMA.clobberPrefix).toBe("");
  });
});

describe("limits", () => {
  it("cuts a body over the render limit and says so", async () => {
    const result = await renderMarkdown("word ".repeat(MAX_RENDER_CHARS));
    expect(result.warnings).toContain("document is longer than the render limit and was cut");
  });

  it("never throws; an internal failure shows escaped text", async () => {
    const result = await renderMarkdown("# ok\n", {
      slots: {
        highlight: [
          () => () => {
            throw new Error("boom");
          },
        ],
      },
    });
    expect(result.html).toBe("<pre># ok\n</pre>");
    expect(result.warnings).toContain("rendering failed; showing plain text");
  });
});

describe("slots", () => {
  it("runs the link, highlight and mermaid slots in order, before the sanitizer", async () => {
    const order: string[] = [];
    const mark = (name: string) => () => () => {
      order.push(name);
    };
    const result = await renderMarkdown("text\n", {
      slots: {
        mermaid: [mark("mermaid")],
        highlight: [mark("highlight")],
        linkRewrite: [mark("linkRewrite")],
        afterParse: [mark("afterParse")],
      },
    });
    expect(order).toEqual(["afterParse", "linkRewrite", "highlight", "mermaid"]);
    expect(result.html).toBe("<p>text</p>");
  });

  it("sanitizes what a slot plugin adds", async () => {
    const evil = () => (tree: { children: unknown[] }) => {
      tree.children.push({
        type: "element",
        tagName: "script",
        properties: {},
        children: [{ type: "text", value: "alert(1)" }],
      });
    };
    const result = await renderMarkdown("text\n", { slots: { highlight: [evil] } });
    expect(result.html).not.toContain("script");
  });
});

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if ([".git", "node_modules", ".next", ".vitest", ".scratch"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) markdownFiles(path, out);
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

describe("parity with extractMetadata", () => {
  const files = markdownFiles(process.cwd());

  it("finds markdown files to compare", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("renders the same headings and slugs as the sync stored, for this repo's own markdown", async () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const parsed = parseFrontmatter(text);
      const extracted = extractMetadata({
        body: parsed.body,
        frontmatter: parsed.frontmatter,
        path: file,
      });
      const rendered = await renderMarkdown(text);
      expect(rendered.headings, file).toEqual(extracted.headings);
      for (const heading of rendered.headings) {
        if (heading.slug !== "") expect(rendered.html, file).toContain(`id="${heading.slug}"`);
      }
    }
  }, 60_000);
});
