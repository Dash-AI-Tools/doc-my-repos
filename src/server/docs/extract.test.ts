import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import {
  CHUNK_MAX_CHARS,
  CHUNK_MAX_LINES,
  CHUNK_TARGET_CHARS,
  extractMetadata,
  INLINE_BUDGET_CHARS,
  MAX_BODY_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_HEADING_CHARS,
  MAX_HEADING_SOURCE_CHARS,
  MAX_HEADINGS,
  MAX_LINE_CONTAINERS,
  MAX_SLUG_CHARS,
  MAX_TITLE_CHARS,
  splitChunks,
  titleFromPath,
} from "./extract";
import { parseFrontmatter } from "./frontmatter";

function run(body: string, frontmatter = {}, path = "guide.md") {
  return extractMetadata({ body, frontmatter, path });
}

describe("title fallback order", () => {
  it("uses the frontmatter title first", () => {
    expect(run("# Heading", { title: "From FM" }, "file.md").title).toBe("From FM");
  });

  it("uses the first H1 when there is no frontmatter title", () => {
    expect(run("intro\n\n# Getting Started\n\n# Second").title).toBe("Getting Started");
  });

  it("skips H2 and deeper when looking for the H1", () => {
    expect(run("## Sub\n\n# Real").title).toBe("Real");
  });

  it("uses the file name when there is neither", () => {
    expect(run("just text", {}, "guides/setup.md").title).toBe("Setup");
    expect(run("## only h2", {}, "guides/advanced/tuning.md").title).toBe("Tuning");
  });

  it("ignores non-string and blank frontmatter titles", () => {
    for (const title of [42, true, null, ["a"], { a: 1 }, "", "   \n "]) {
      expect(run("# H1", { title }).title).toBe("H1");
    }
  });

  it("trims and collapses whitespace in the frontmatter title", () => {
    expect(run("", { title: "  A \n\t B  " }).title).toBe("A B");
  });

  it("falls through when the H1 is empty", () => {
    expect(run("#\n\ntext", {}, "my-doc.md").title).toBe("My doc");
  });

  it("works on a document that only has a type", () => {
    const parsed = parseFrontmatter("---\ntype: Note\n---\nbody");
    expect(extractMetadata({ ...parsed, path: "notes/idea.md" }).title).toBe("Idea");
  });

  it("caps long titles", () => {
    expect(run("", { title: "x".repeat(5000) }).title).toHaveLength(MAX_TITLE_CHARS);
    expect(run(`# ${"y".repeat(5000)}`).title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
  });
});

describe("titleFromPath", () => {
  it("strips the final extension and humanizes", () => {
    expect(titleFromPath("docs/api-reference.md")).toBe("Api reference");
    expect(titleFromPath("docs/getting_started.mdx")).toBe("Getting started");
    expect(titleFromPath("docs/v1.2.notes.md")).toBe("V1.2.notes");
    expect(titleFromPath("setup")).toBe("Setup");
  });

  it("uses the folder for index and README in any case", () => {
    expect(titleFromPath("docs/guides/index.md")).toBe("Guides");
    expect(titleFromPath("docs/guides/README.md")).toBe("Guides");
    expect(titleFromPath("docs/the-guides/Readme.md")).toBe("The guides");
  });

  it("uses the file name at the root", () => {
    expect(titleFromPath("index.md")).toBe("Index");
    expect(titleFromPath("README.md")).toBe("README");
  });

  it("handles odd paths", () => {
    expect(titleFromPath("")).toBe("Untitled");
    expect(titleFromPath("/")).toBe("Untitled");
    expect(titleFromPath(".md")).toBe(".md");
    expect(titleFromPath("docs//a.md")).toBe("A");
  });

  it("drops NUL bytes and lone surrogates from the path", () => {
    expect(titleFromPath("docs/a\u0000b.md")).toBe("Ab");
    expect(titleFromPath("\u0000")).toBe("Untitled");
    expect(titleFromPath("docs/x\ud800y.md")).toBe("X\ufffdy");
    expect(run("text", {}, "docs/\u0000setup\u0000.md").title).toBe("Setup");
  });

  it("keeps non-ASCII names", () => {
    expect(titleFromPath("docs/éclair-über.md")).toBe("Éclair über");
    expect(titleFromPath("docs/日本語.md")).toBe("日本語");
  });

  it("is used by extraction for index.md without H1", () => {
    expect(run("text", {}, "docs/runbooks/index.md").title).toBe("Runbooks");
  });
});

describe("description", () => {
  it("comes from frontmatter, whitespace collapsed", () => {
    expect(run("# T", { description: " A  short\ndesc " }).description).toBe("A short desc");
  });

  it("is null without a usable frontmatter description (no body fallback)", () => {
    expect(run("# T\n\nSome paragraph.").description).toBeNull();
    for (const description of [1, null, "  ", ["x"], {}]) {
      expect(run("# T", { description }).description).toBeNull();
    }
  });

  it("is capped", () => {
    expect(run("", { description: "d".repeat(10_000) }).description).toHaveLength(
      MAX_DESCRIPTION_CHARS,
    );
  });
});

describe("headings", () => {
  it("returns depth, text and github-style slug in order", () => {
    expect(run("# Getting Started\n\n## Install & Run\n\n### 3. Done!").headings).toEqual([
      { depth: 1, text: "Getting Started", slug: "getting-started" },
      { depth: 2, text: "Install & Run", slug: "install--run" },
      { depth: 3, text: "3. Done!", slug: "3-done" },
    ]);
  });

  it("numbers duplicate slugs like GitHub", () => {
    const slugs = run("## Usage\n\n## Usage\n\n## Usage\n\n## Usage-1").headings.map((h) => h.slug);
    expect(slugs).toEqual(["usage", "usage-1", "usage-2", "usage-1-1"]);
  });

  it("strips inline markdown to plain text", () => {
    const [h] = run(
      "## A **bold** _em_ `code` [link](http://x.y) ![alt](i.png) ~~gone~~ end",
    ).headings;
    expect(h?.text).toBe("A bold em code link alt gone end");
    expect(h?.slug).toBe("a-bold-em-code-link-alt-gone-end");
  });

  it("drops inline html and footnote references", () => {
    const [h] = run("## Hello <b>x</b>[^1] there\n\n[^1]: note").headings;
    expect(h?.text).toBe("Hello x there");
  });

  it("handles setext headings", () => {
    expect(run("Title\n=====\n\nSub\n---\n").headings).toEqual([
      { depth: 1, text: "Title", slug: "title" },
      { depth: 2, text: "Sub", slug: "sub" },
    ]);
    expect(run("Setext\n======").title).toBe("Setext");
  });

  it("supports multi-line setext and closing hashes", () => {
    expect(run("Line one\nline two\n===").headings[0]?.text).toBe("Line one line two");
    expect(run("## Closed ##").headings[0]?.text).toBe("Closed");
  });

  it("ignores headings in fenced and indented code", () => {
    const body = "```md\n# Not a heading\n```\n\n~~~\n## Nor this\n~~~\n\n    # indented\n\n# Real";
    expect(run(body).headings.map((h) => h.text)).toEqual(["Real"]);
    expect(run(body).title).toBe("Real");
  });

  it("does not let an unclosed fence leak headings", () => {
    expect(run("```\n# Inside\n").headings).toEqual([]);
  });

  it("ignores headings in HTML blocks and comments", () => {
    const body = "<div>\n# in html\n</div>\n\n<!--\n# commented\n-->\n\n## After";
    expect(run(body).headings.map((h) => h.text)).toEqual(["After"]);
  });

  it("finds headings in blockquotes and lists", () => {
    const body = "> ## Quoted\n\n- ## Listed";
    expect(run(body).headings.map((h) => h.text)).toEqual(["Quoted", "Listed"]);
  });

  it("requires a space after the hashes and at most 6", () => {
    expect(run("#nospace\n\n####### seven").headings).toEqual([]);
  });

  it("skips empty headings", () => {
    expect(run("#\n\n##   \n\n## ok").headings.map((h) => h.text)).toEqual(["ok"]);
  });

  it("collapses whitespace and caps heading text", () => {
    const [a, b] = run(`## a   \t b\n\n## ${"z".repeat(5000)}`).headings;
    expect(a?.text).toBe("a b");
    expect(b?.text).toHaveLength(MAX_HEADING_CHARS);
  });

  it("handles non-ASCII text and slugs", () => {
    const hs = run("## Über uns\n\n## 日本語の見出し\n\n## Café ☕ time\n\n## 🎉").headings;
    expect(hs.map((h) => h.slug)).toEqual(["über-uns", "日本語の見出し", "café--time", ""]);
  });

  it("leaves no lone surrogates or NULs", () => {
    const res = run("## bad \ud800 x\u0000y", { title: "t\udc00\u0000" });
    expect(res.headings[0]?.text).toBe("bad � xy");
    expect(res.title).toBe("t�");
    expect(res.headings[0]?.text.toWellFormed()).toBe(res.headings[0]?.text);
  });

  it("does not split a surrogate pair when capping", () => {
    const [h] = run(`## ${"a".repeat(MAX_HEADING_CHARS - 1)}😀`).headings;
    expect(h?.text.toWellFormed()).toBe(h?.text);
    expect(h?.text).toHaveLength(MAX_HEADING_CHARS - 1);
  });
});

describe("robustness", () => {
  it("handles an empty document", () => {
    expect(run("", {}, "empty.md")).toEqual({ title: "Empty", description: null, headings: [] });
    expect(run("\n\n  \n", {}, "")).toEqual({ title: "Untitled", description: null, headings: [] });
  });

  it("caps the number of headings", () => {
    const body = Array.from({ length: MAX_HEADINGS + 50 }, (_, i) => `## h${i}`).join("\n\n");
    expect(run(body).headings).toHaveLength(MAX_HEADINGS);
  });

  it("blanks lines nested deeper than the container cap, keeps shallow ones", () => {
    const shallow = `${"> ".repeat(MAX_LINE_CONTAINERS)}## Ok`;
    const deep = `${"> ".repeat(MAX_LINE_CONTAINERS + 1)}## Too deep`;
    expect(run(`${shallow}\n\n${deep}`).headings.map((h) => h.text)).toEqual(["Ok"]);
  });

  it("does not scan beyond the body cap; a later H1 falls through to the file name", () => {
    const body = `${"x".repeat(MAX_BODY_CHARS)}\n\n# Late`;
    expect(run(body).headings).toEqual([]);
    expect(run(body, {}, "guides/setup.md").title).toBe("Setup");
  });

  it("composes with parseFrontmatter", () => {
    const parsed = parseFrontmatter("---\ntitle: FM\ndescription: D\n---\n# H1\n## Sub");
    const meta = extractMetadata({ ...parsed, path: "a.md" });
    expect(meta.title).toBe("FM");
    expect(meta.description).toBe("D");
    expect(meta.headings.map((h) => h.slug)).toEqual(["h1", "sub"]);
  });

  it("handles CRLF and lone CR line endings", () => {
    const body = "# One\r\n\r\n```\r\n# code\r\n\r\ntext\r\n```\r\n\r\n## Two\r\r## Three";
    expect(run(body).headings.map((h) => h.text)).toEqual(["One", "Two", "Three"]);
  });
});

describe("caps", () => {
  it("cuts a heading's source at MAX_HEADING_SOURCE_CHARS before collapsing whitespace", () => {
    const wide = `## a${" ".repeat(MAX_HEADING_SOURCE_CHARS)}b`;
    expect(run(wide).headings.map((h) => h.text)).toEqual(["a"]);
    const fits = `## a${" ".repeat(MAX_HEADING_SOURCE_CHARS - 10)}b`;
    expect(run(fits).headings.map((h) => h.text)).toEqual(["a b"]);
  });

  it("cuts slugs at MAX_SLUG_CHARS and keeps them unique", () => {
    const text = "s".repeat(MAX_HEADING_SOURCE_CHARS - 10);
    const hs = run(`## ${text}\n\n## ${text}`).headings;
    expect(hs[0]?.slug).toHaveLength(MAX_SLUG_CHARS);
    expect(hs[1]?.slug).toHaveLength(MAX_SLUG_CHARS);
    expect(hs[0]?.text).toHaveLength(MAX_HEADING_CHARS);
  });

  it("does not leave a lone surrogate when the slug is cut", () => {
    const [h] = run(`## ${"a".repeat(MAX_SLUG_CHARS - 1)}😀😀`).headings;
    expect(h?.slug.toWellFormed()).toBe(h?.slug);
  });

  it("slugs empty-text headings so duplicate counters match a renderer that slugs them all", () => {
    // Slugs "", "-1" for the two empty headings, so a later "-1" heading must become "-1-1".
    const hs = run("##\n\n##\n\n## -1\n\n## -1").headings;
    expect(hs.map((h) => h.slug)).toEqual(["-1-1", "-1-2"]);
  });

  it("keeps a heading's source text once the inline budget is spent", () => {
    const heading = `## ${"*a*".repeat(100)}\n\n`;
    const count = Math.ceil(INLINE_BUDGET_CHARS / 303) + 20;
    const hs = run(heading.repeat(count)).headings;
    expect(hs).toHaveLength(count);
    expect(hs[0]?.text.startsWith("aaaa")).toBe(true);
    expect(hs.at(-1)?.text.startsWith("*a*")).toBe(true);
  });
});

describe("block structure survives chunking", () => {
  const filler = (n: number) => "word ".repeat(n).trim();

  it("finds every heading across many chunks, in order, with unique slugs", () => {
    const sections = Array.from(
      { length: 300 },
      (_, i) => `## Section ${i % 7}\n\n${filler(40)}\n\n- item\n- item\n`,
    );
    const hs = run(sections.join("\n")).headings;
    expect(hs).toHaveLength(300);
    expect(hs.map((h) => h.text)).toEqual(sections.map((_, i) => `Section ${i % 7}`));
    expect(new Set(hs.map((h) => h.slug)).size).toBe(300);
  });

  it("does not turn lines of a fenced block into headings at a chunk boundary", () => {
    const code = Array.from({ length: 40 }, () => `\n# fake\n${filler(20)}`).join("\n");
    const body = `# Real\n\n${filler(200)}\n\n\`\`\`md${code}\n\`\`\`\n\n## After`;
    expect(code.length).toBeGreaterThan(CHUNK_TARGET_CHARS);
    expect(run(body).headings.map((h) => h.text)).toEqual(["Real", "After"]);
  });

  it("handles tilde fences, longer closing fences and info strings", () => {
    const body = `~~~~ js\n\n# a\n\n~~~\n\n# b\n\n~~~~~\n\n## ${"w".repeat(10)}`;
    const padded = `${filler(CHUNK_TARGET_CHARS / 4)}\n\n${body}`;
    expect(run(padded).headings.map((h) => h.depth)).toEqual([2]);
  });

  it("does not turn lines of an HTML comment or <pre> into headings", () => {
    const inner = Array.from({ length: 40 }, () => `\n# fake\n${filler(20)}`).join("\n");
    for (const [open, close] of [
      ["<!--", "-->"],
      ["<pre>", "</pre>"],
      ["<script>", "</script>"],
      ["<?php", "?>"],
      ["<![CDATA[", "]]>"],
    ] as const) {
      const body = `${filler(300)}\n\n${open}${inner}\n${close}\n\n## After`;
      expect(run(body).headings.map((h) => h.text)).toEqual(["After"]);
    }
  });

  it("does not turn lines of a plain HTML block into headings", () => {
    const body = `${filler(300)}\n<div>\n# in html\n${filler(300)}\n# also html\n</div>\n\n## After`;
    expect(run(body).headings.map((h) => h.text)).toEqual(["After"]);
  });

  it("does not lose later headings after a long comment or <pre> line", () => {
    for (const length of [1200, 5000]) {
      const filler = "x".repeat(length);
      expect(run(`# T\n\n<!-- ${filler} -->\n\n## After`).headings.map((h) => h.text)).toEqual([
        "T",
        "After",
      ]);
      expect(run(`<pre>${filler}</pre>\n\n## After`).headings.map((h) => h.text)).toEqual([
        "After",
      ]);
      expect(run(`# T\n\n${filler}\n\n## After`).headings.map((h) => h.text)).toEqual([
        "T",
        "After",
      ]);
    }
  });

  it("finds headings that follow text with no blank line", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `## h${i}\n${filler(30)}`);
    expect(run(lines.join("\n")).headings).toHaveLength(200);
  });

  it("keeps a setext heading together with its text", () => {
    const body = `${filler(300)}\n\nA title\nthat wraps\n===\n\nSub\n---\n\n${filler(300)}`;
    expect(run(body).headings.map((h) => h.text)).toEqual(["A title that wraps", "Sub"]);
  });

  it("resolves reference links and footnotes in headings from definitions anywhere", () => {
    const body = `## See [the docs][d] and [other] now[^n]\n\n${filler(400)}\n\n[d]: http://x.y\n[other]: http://z.y\n\n[^n]: note`;
    expect(run(body).headings[0]?.text).toBe("See the docs and other now");
  });

  it("reads headings in quotes and lists after other blocks", () => {
    const body = `${filler(500)}\n\n> ## Quoted\n> text\n\n- ## Listed\n\n  more\n\n${filler(500)}\n\n## Last`;
    expect(run(body).headings.map((h) => h.text)).toEqual(["Quoted", "Listed", "Last"]);
  });

  it("skips the rest of a block longer than a chunk but finds the headings after it", () => {
    const huge = `\`\`\`\n${"line\n".repeat(CHUNK_MAX_LINES * 3)}\`\`\``;
    expect(huge.length).toBeGreaterThan(CHUNK_MAX_CHARS / 2);
    const body = `# Top\n\n${huge}\n\n## After\n\n${"long ".repeat(CHUNK_MAX_CHARS)}\n\n## End`;
    expect(run(body).headings.map((h) => h.text)).toEqual(["Top", "After", "End"]);
  });

  /** Headings from parsing the whole document at once, with full inline parsing. */
  function wholeDocument(body: string): string[] {
    const tree: Root = unified().use(remarkParse).use(remarkGfm).parse(body);
    const text = (node: Nodes): string => {
      if (node.type === "html" || node.type === "footnoteReference") return "";
      if (node.type === "image") return node.alt ?? "";
      if ("value" in node) return node.value;
      return "children" in node ? node.children.map(text).join("") : "";
    };
    const out: string[] = [];
    const stack: Nodes[] = [tree];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      if (node.type === "heading") {
        const value = text(node).replace(/\s+/g, " ").trim();
        if (value !== "") out.push(`${node.depth}:${value}`);
      } else if ("children" in node) {
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as Nodes);
      }
    }
    return out;
  }

  function random(seed: number) {
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    return {
      next,
      pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    };
  }

  it("matches a whole-document parse on well-formed documents of mixed blocks", () => {
    const { next, pick } = random(1);
    const words = (n: number) =>
      Array.from({ length: n }, () => pick(["alpha", "beta", "gamma"])).join(" ");
    let id = 0;
    const blocks: (() => string)[] = [
      () =>
        `${"#".repeat(1 + Math.floor(next() * 6))} Head ${id++} ${pick(["", "*em*", "`code`", "[l](u)", "[r][ref]"])}`,
      () => `${words(8)}\n${words(8)}`,
      () => `Set ${id++}\n${pick(["===", "---"])}`,
      () => {
        const f = pick(["```", "~~~", "````"]);
        return `${f}${pick(["", "js"])}\n# fake ${id}\n\ncol zero\n## fake\n${f}`;
      },
      () => "    # not heading\n    code",
      () => `- ${words(3)}\n- ${words(3)}\n  - nested\n\n  ## list head ${id++}\n\n- last`,
      () => "1. step\n   ```bash\n   # comment\n\n   cmd\n   ```\n2. next",
      () => `> quote ${words(3)}\n> ## quoted ${id++}\nlazy`,
      () => "| a | b |\n|---|---|\n| 1 | 2 |",
      () => "<!--\n# fake in comment\n\ntext\n-->",
      () => `<div>\n# fake in div\n${words(3)}\n</div>`,
      () => "<pre>\n# fake in pre\n\nmore\n</pre>",
      () => "***",
      () => "[ref]: http://example.com",
      () => `${words(5)}\n<br>\n${words(5)}`,
      () => '<img src="a.png">',
      () => `[^1]: footnote ${words(3)}`,
      () => "<script>\n# fake in script\n\n</script>",
    ];
    for (let round = 0; round < 30; round++) {
      const parts: string[] = [];
      let length = 0;
      const target = 3 * CHUNK_TARGET_CHARS + Math.floor(next() * 10 * CHUNK_TARGET_CHARS);
      while (length < target) {
        const block = pick(blocks)();
        parts.push(block);
        length += block.length;
      }
      // Sloppy writers leave out the blank line before headings, fences and rules.
      const body = parts
        .map((part, i) => {
          const sloppy = /^(#{1,6} |```|~~~|\*\*\*)/.test(part) && next() < 0.4;
          return i === 0 ? part : (sloppy ? "\n" : "\n\n") + part;
        })
        .join("");
      const got = run(body).headings.map((h) => `${h.depth}:${h.text}`);
      expect(got, `round ${round}`).toEqual(wholeDocument(body));
    }
  });

  it("never invents a heading on arbitrary line mixes (it may give up on odd structure)", () => {
    const { next, pick } = random(2);
    const lines = [
      "# Alpha",
      "## Beta",
      "text",
      "more text",
      "",
      "",
      "```",
      "# in fence",
      "col zero",
      "~~~ts",
      "~~~",
      "<!--",
      "-->",
      "<div>",
      "# in div",
      "<pre>",
      "</pre>",
      "- item",
      "  - nested",
      "1. first",
      "> quoted",
      "> ## quoted heading",
      "lazy line",
      "- ## list heading",
      "    indented code",
      "| a | b |",
      "|---|---|",
      "Setext",
      "===",
      "---",
      "***",
      "  ```",
      "  <pre>",
      "<br>",
      "?>",
      "<?php",
    ];
    for (let round = 0; round < 40; round++) {
      const picked: string[] = [];
      let length = 0;
      const target = 2 * CHUNK_TARGET_CHARS + Math.floor(next() * 8 * CHUNK_TARGET_CHARS);
      while (length < target) {
        const line = pick(lines);
        picked.push(line);
        length += line.length + 1;
      }
      const body = picked.join("\n");
      const got = run(body).headings.map((h) => `${h.depth}:${h.text}`);
      const whole = wholeDocument(body);
      let at = 0;
      for (const heading of got) {
        at = whole.indexOf(heading, at);
        expect(at, `round ${round}: ${heading}`).toBeGreaterThanOrEqual(0);
        at++;
      }
    }
  });
});

describe("splitChunks", () => {
  const paragraph = (i: number) => `## Heading ${i}\n\n${"word ".repeat(40)}\n\n`;

  it("cuts a normal document at block starts and loses no text", () => {
    const body = Array.from({ length: 100 }, (_, i) => paragraph(i)).join("");
    const chunks = splitChunks(body);
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.join("")).toBe(body);
    for (const chunk of chunks) expect(chunk).toMatch(/^## Heading /);
  });

  it("keeps every chunk within the size and line limits", () => {
    const inputs = [
      "a\n".repeat(5000),
      `\`\`\`\n${"code\n\n".repeat(3000)}\`\`\``,
      "x".repeat(50_000),
      `> a\n${"b\n".repeat(5000)}\n\n${paragraph(1)}`,
    ];
    for (const body of inputs) {
      for (const chunk of splitChunks(body)) {
        expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
        expect(chunk.split("\n").length).toBeLessThanOrEqual(CHUNK_MAX_LINES + 1);
      }
    }
  });

  it("never cuts inside a fence or a comment", () => {
    const fenced = `\`\`\`\n${"\n# not a safe point\n".repeat(30)}\`\`\`\n\n`;
    const commented = `<!--\n${"\n# not a safe point\n".repeat(30)}-->\n\n`;
    for (const block of [fenced, commented]) {
      const around = Array.from({ length: 8 }, (_, i) => paragraph(i)).join("");
      const chunks = splitChunks(`${around}${block}${around}`);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(chunk.startsWith("# not a safe point")).toBe(false);
    }
  });

  it("returns nothing for an empty body", () => {
    expect(splitChunks("")).toEqual([]);
  });
});

describe("worst-case time", { timeout: 120_000 }, () => {
  // Measured at the cap on an Apple-silicon laptop: 0.1 to 0.4 s each (the quadratic inputs were
  // minutes before chunking and the block-only pass). 15 s still catches a regression and leaves
  // room for a loaded CI runner.
  const LIMIT_MS = 15_000;
  const repeatTo = (unit: string, size = MAX_BODY_CHARS) =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

  const hostile: Record<string, string> = {
    "emphasis soup": repeatTo(`${"*_".repeat(450)}\n`),
    "underscore soup": repeatTo("_*a"),
    "bracket star": repeatTo("[*"),
    "star bracket": repeatTo("*["),
    "star lt": repeatTo("*<"),
    "backticks per line": repeatTo(`${"`a ".repeat(300)}\n`),
    "brackets per line": repeatTo(`${"[".repeat(900)}\n`),
    "one huge heading": `## ${"a ".repeat(MAX_BODY_CHARS)}`,
    "only hashes": "#".repeat(MAX_BODY_CHARS * 4),
    "deep quote": `${"> ".repeat(MAX_BODY_CHARS / 2)}# deep`,
    "deep list": repeatTo(`${"- ".repeat(500)}x\n`),
    "deep mix": repeatTo(`${"> - ".repeat(250)}# x\n`),
    "quote then lazy lines": `> a\n${repeatTo("b\n")}`,
    "list then lazy lines": `- a\n${repeatTo("b\n")}`,
    "quote, blank, repeated": repeatTo("> a\n\n"),
    "quote, lazy line, repeated": repeatTo("> a\nb\n"),
    "setext, repeated": repeatTo("a\n===\n"),
    "table rows": repeatTo(`${"|a".repeat(500)}|\n`),
    "long table": `|a|b|\n|-|-|\n|${"x|".repeat(MAX_BODY_CHARS / 2)}`,
    definitions: repeatTo("[a]: b\n"),
    "empty headings": repeatTo("#\n"),
    "soup headings": repeatTo(`## ${"*_[".repeat(200)}\n\n`),
    "short soup headings": repeatTo("## *_[ `x ![y\n\n"),
    "soup setext headings": repeatTo(`${"_*a".repeat(100)}\n${"_*a".repeat(100)}\n===\n\n`),
    "many short lines": repeatTo("a\n"),
  };

  it.each(Object.entries(hostile))("%s finishes quickly", (_name, body) => {
    const started = performance.now();
    run(body);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  it("random delimiter mixes at the cap finish quickly", () => {
    let seed = 99;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const alphabet = [..."*_[]()<>!`~|&# \n\\-=:^+.1>"];
    const lines = ["> a", "b", "- x", "  - y", "# h", "a", "===", "---", "```", "", "", "[a]: b"];
    for (let round = 0; round < 6; round++) {
      const chars = Array.from(
        { length: MAX_BODY_CHARS },
        () => alphabet[Math.floor(next() * alphabet.length)],
      ).join("");
      let mixed = "";
      while (mixed.length < MAX_BODY_CHARS) {
        mixed += `${lines[Math.floor(next() * lines.length)] ?? ""}\n`;
      }
      for (const body of [chars, mixed]) {
        const started = performance.now();
        run(body);
        expect(performance.now() - started).toBeLessThan(LIMIT_MS);
      }
    }
    // 12 bodies, each held to LIMIT_MS above. Vitest's default 5 s would cap the whole loop, which a slow CI runner exceeds.
  }, 120_000);

  it("scans a whole run of the worst chunk-sized units within the limit", () => {
    const unit = `> a\n${"b\n".repeat(CHUNK_MAX_LINES - 2)}\n`;
    const started = performance.now();
    run(repeatTo(unit));
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });
});
