import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseFrontmatter } from "../docs/frontmatter";
import {
  guardInline,
  LINE_DELIMITERS,
  MAX_LINE_CHARS,
  MAX_NODES,
  parseBody,
  RUN_DELIMITERS,
  WARNING_DENSE,
  WARNING_SPLIT,
  WARNING_TRUNCATED,
} from "./parse";
import { createProcessor, MAX_RENDER_CHARS, renderMarkdown } from "./pipeline";
import { VFile } from "vfile";

async function renderTree(body: string, wholeMax: number): Promise<string> {
  const processor = createProcessor();
  const file = new VFile(body);
  return String(
    processor.stringify(await processor.run(parseBody(body, [], wholeMax), file), file),
  );
}

describe("guardInline", () => {
  it("leaves ordinary prose alone", () => {
    const text = "Some *emphasis* and `code` and [a link](http://x.y) here.\n".repeat(20);
    expect(guardInline(text, new Set())).toBe(text);
  });

  it("escapes a paragraph with too many delimiters", () => {
    const notes = new Set<string>();
    const text = "*_".repeat(RUN_DELIMITERS);
    const out = guardInline(text, notes);
    expect(out).toBe("\\*\\_".repeat(RUN_DELIMITERS));
    expect(notes.has(WARNING_DENSE)).toBe(true);
  });

  it("counts a paragraph across lines, a list line alone", () => {
    const lines = ("*_".repeat(100) + "\n").repeat(10);
    expect(guardInline(lines, new Set())).toContain("\\*");
    const list = ("- " + "*_".repeat(LINE_DELIMITERS / 4) + "\n").repeat(40);
    expect(guardInline(list, new Set())).toBe(list);
  });

  it("does not touch fenced code", () => {
    const text = "```\n" + "*_".repeat(2000) + "\n```\n";
    expect(guardInline(text, new Set())).toBe(text);
  });

  it("cuts an over-long line into paragraphs", () => {
    const notes = new Set<string>();
    const out = guardInline("word ".repeat(MAX_LINE_CHARS), notes);
    expect(out).toContain("\n\n");
    expect(notes.has(WARNING_SPLIT)).toBe(true);
    expect(out.replace(/\s+/g, " ").trim()).toBe("word ".repeat(MAX_LINE_CHARS).trim());
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

describe("block-level cutting", () => {
  it("renders this repo's own markdown the same cut into pieces as parsed whole", async () => {
    for (const file of markdownFiles(process.cwd())) {
      const body = parseFrontmatter(readFileSync(file, "utf8")).body.replace(/\r\n?/g, "\n");
      expect(await renderTree(body, 0), file).toBe(await renderTree(body, Infinity));
    }
  }, 60_000);

  it("resolves a footnote whose definition is in another piece", async () => {
    const filler = "A paragraph of ordinary prose that fills the space.\n\n".repeat(400);
    const body = `Reference[^note] here.\n\n${filler}[^note]: Far away.\n`;
    expect(body.length).toBeGreaterThan(20_000);
    const { html } = await renderMarkdown(body);
    expect(html).toContain("data-footnote-ref");
    expect(html).toContain("Far away.");
    expect(html.match(/id="user-content-fn-note"/g)).toHaveLength(1);
  });

  it("resolves a link reference whose definition is in another piece", async () => {
    const filler = "A paragraph of ordinary prose that fills the space.\n\n".repeat(400);
    const body = `See [the docs][d].\n\n${filler}[d]: https://example.com/docs\n`;
    const { html } = await renderMarkdown(body);
    expect(html).toContain(
      '<a href="https://example.com/docs" rel="nofollow noopener noreferrer">the docs</a>',
    );
  });

  it("keeps one long loose list in one list", async () => {
    const items = Array.from(
      { length: 400 },
      (_, i) => `${i + 1}. Item number ${i + 1} with some words\n`,
    );
    const body = `Intro\n\n${items.join("\n")}\nOutro\n`;
    expect(body.length).toBeGreaterThan(12 * 1024);
    const html = await renderTree(body, 0);
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html.match(/<li>/g)).toHaveLength(400);
    expect(html).toBe(await renderTree(body, Infinity));
  });

  it("keeps a long table in one piece", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => `| row ${i} | ${"cell ".repeat(10)}|\n`);
    const body = `| a | b |\n|---|---|\n${rows.join("")}`;
    const html = await renderTree(body, 0);
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html.match(/<tr>/g)).toHaveLength(301);
  });

  it("keeps a long fenced block whole, blank lines and headings inside it included", async () => {
    const code = "line one\n\n# not a heading\n\nline two\n".repeat(600);
    const body = "# Title\n\n```text\n" + code + "```\n\n## After\n";
    const { html, headings } = await renderMarkdown(body);
    expect(html.match(/<pre>/g)).toHaveLength(1);
    expect(headings.map((h) => h.text)).toEqual(["Title", "After"]);
  });
});

describe("worst-case time", () => {
  const size = MAX_RENDER_CHARS;
  const repeat = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const cases: Record<string, string> = {
    "delimiter soup *_": repeat("*_"),
    "unclosed links [*": repeat("[*"),
    "reversed *[": repeat("*["),
    "_*a": repeat("_*a"),
    "html-ish *<": repeat("*<"),
    "image openers ![[": repeat("![["),
    "footnote calls": repeat("[^a]"),
    "nested quotes": repeat("> ".repeat(10) + "a\n"),
    "nested lists": repeat("- ".repeat(10) + "a\n"),
    "quote then blank": repeat("> a\n\n"),
    "quote then lazy lines": "> a\n" + repeat("lazy\n"),
    setext: repeat("a\n===\n"),
    "long table row": "| " + repeat("a | ") + "\n|---|\n",
    "table of soup": "| a | b |\n|---|---|\n" + repeat("| *_ | [*x |\n"),
    "task items": repeat("- [ ] a\n"),
    headings: repeat("# a\n"),
    "unclosed divs": repeat("<div>"),
    "one huge line": repeat("word *emph* _more_ `c` [l](u) "),
  };

  for (const [name, source] of Object.entries(cases)) {
    it(`finishes quickly: ${name}`, async () => {
      const started = performance.now();
      const result = await renderMarkdown(source);
      const elapsed = performance.now() - started;
      expect(result.html.length).toBeGreaterThan(0);
      // About 0.2 to 1 s on a laptop. A quadratic regression takes minutes, so 15 s still catches it
      // and leaves room for a loaded CI runner (4 to 5 s was seen there).
      expect(elapsed).toBeLessThan(15_000);
    }, 30_000);
  }

  it("truncates a document with an extreme node count and says so", async () => {
    const result = await renderMarkdown(repeat("> a\n\n"));
    expect(result.warnings).toContain(WARNING_TRUNCATED);
    expect(MAX_NODES).toBeLessThan(100_000);
  }, 20_000);
});
