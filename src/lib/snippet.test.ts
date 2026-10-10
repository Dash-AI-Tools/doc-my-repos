import { describe, expect, it } from "vitest";

import { splitHighlights } from "./search";
import {
  cleanSnippet,
  HEADLINE_ANGLE,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  SNIPPET_MAX_CHARS,
} from "./snippet";

/** Writes ⟦ and ⟧ as the highlight markers so the cases stay readable. */
const mark = (text: string) => text.replaceAll("⟦", HIGHLIGHT_START).replaceAll("⟧", HIGHLIGHT_END);
/** The reverse, for failure messages. */
const show = (text: string) => text.replaceAll(HIGHLIGHT_START, "⟦").replaceAll(HIGHLIGHT_END, "⟧");

const clean = (input: string) => show(cleanSnippet(mark(input)));

describe("cleanSnippet cases", () => {
  // [name, input, expected]. ⟦ ⟧ are the highlight markers.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    // Inline Markdown.
    ["strong", "**bold** text", "bold text"],
    ["strong with underscores", "__bold__ text", "bold text"],
    ["emphasis pair", "an *emphasized* word", "an emphasized word"],
    ["emphasis with underscores", "an _emphasized_ word", "an emphasized word"],
    ["strikethrough", "~~gone~~ stays", "gone stays"],
    ["unpaired star stays", "5 * 3 and a * b", "5 * 3 and a * b"],
    ["glob stars stay", "match *.md and *.js files", "match *.md and *.js files"],
    ["intraword stars stay", "a*b*c", "a*b*c"],
    ["snake_case stays", "use snake_case_name here", "use snake_case_name here"],
    ["inline code keeps its text", "run `pnpm test` now", "run pnpm test now"],
    ["code span keeps emphasis characters", "the `a*b*` pattern", "the a*b* pattern"],
    ["double backtick code", "see ``a ` b`` here", "see a ` b here"],
    ["unterminated code span", "start `unterminated code", "start unterminated code"],
    ["code span closing only", "tail of code` and more", "tail of code and more"],
    ["inline link keeps text", "a [link](https://x.y/z) b", "a link b"],
    ["link with title", 'a [link](https://x.y/z "the title") b', "a link b"],
    ["link with parens in url", "a [link](https://x.y/a_(b)) b", "a link b"],
    ["link with angle title and paren", "[x](u 'a (b)') y", "x y"],
    ["image keeps alt", "![diagram of flow](img/a.png) after", "diagram of flow after"],
    ["image with empty alt", "![](img/a.png) after", "after"],
    ["badge link around an image", "[![build](ci.svg)](https://ci.example) ok", "build ok"],
    ["reference link", "see [the guide][guide] now", "see the guide now"],
    ["collapsed reference link", "see [the guide][] now", "see the guide now"],
    ["bare brackets stay", "use array[0] and [optional] args", "use array[0] and [optional] args"],
    ["footnote reference", "claim[^1] holds[^note]", "claim holds"],
    ["link cut in the url", "read [the guide](https://exa", "read the guide"],
    ["link cut right after the bracket", "read [the guide](", "read the guide"],
    ["link cut inside the title", 'read [the guide](https://x.y "ti', "read the guide"],
    ["link cut before the url", "read [the guide]", "read [the guide]"],
    ["link tail at the start", "guide](https://x.y/z) and more", "guide and more"],
    ["image tail at the start", "alt](a.png) and more", "alt and more"],
    ["javascript url is dropped", "[click me](javascript:alert(1)) now", "click me now"],
    [
      "escaped characters",
      "\\*not emphasis\\* and \\[not a link\\] and a\\_b",
      "*not emphasis* and [not a link] and a_b",
    ],
    ["backslash before a letter stays", "C:\\Users\\me", "C:\\Users\\me"],
    ["hard break backslash", "line one\\\nline two", "line one line two"],
    ["emoji shortcodes", "ship it :rocket: and :+1: now", "ship it and now"],
    ["namespaces are not emoji", "call std::vector::push now", "call std::vector::push now"],
    ["time is not emoji", "at 12:30:45 sharp", "at 12:30:45 sharp"],
    [
      "bare url is shortened",
      "see https://github.com/org/repo/pull/12?x=1#top for it",
      "see github.com/org/repo/pull/12 for it",
    ],
    ["bare url loses trailing punctuation", "(see https://example.com/a.)", "(see example.com/a.)"],
    [
      "long url is cut",
      "https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa x",
      `example.com/${"a".repeat(28)}… x`,
    ],
    ["www url", "go to www.example.org/docs now", "go to example.org/docs now"],
    ["autolink", "mail <a@b.co> or open <https://x.y/z>", "mail a@b.co or open x.y/z"],
    ["jsx expression", "Title: {props.title} and {items.map(i => i.id)} done", "Title: and done"],
    [
      "placeholders stay",
      "GET /users/{id} and ${HOME} and {{ name }}",
      "GET /users/{id} and ${HOME} and {{ name }}",
    ],
    ["repeated punctuation", "intro ----- middle ===== end ####", "intro middle end"],
    ["three dashes inside text stay", "a --- b", "a --- b"],
    [
      "math and generics stay",
      "2 < 3 and 5 > 4, C++, Promise<void>, Map<string, number>, <T>",
      "2 < 3 and 5 > 4, C++, Promise<void>, Map<string, number>, <T>",
    ],

    // Blocks.
    ["heading", "# Title\ntext", "Title text"],
    ["heading with closing hashes", "## Title ##\ntext", "Title text"],
    ["hashtag stays", "#hashtag stays", "#hashtag stays"],
    ["blockquote", "> quoted\n>> deeper", "quoted deeper"],
    ["greater-equal line stays", ">= 5 items", ">= 5 items"],
    ["alert marker", "> [!NOTE]\n> remember this", "remember this"],
    ["bullets", "- one\n* two\n+ three", "one two three"],
    ["ordered list", "1. one\n2) two", "one two"],
    ["number without a list stays", "2023 was a year", "2023 was a year"],
    ["task list", "- [ ] todo\n- [x] done", "todo done"],
    ["horizontal rules", "above\n***\nmiddle\n___\n- - -\nbelow", "above middle below"],
    ["setext underline", "Title\n=====\ntext", "Title text"],
    ["frontmatter delimiters", "---\ntitle: Doc\n---\nbody", "title: Doc body"],
    ["toml frontmatter delimiter", "+++\nbody", "body"],
    [
      "fence drops the info string",
      '```ts title="a.ts"\nconst a = 1;\n```\nafter',
      "const a = 1; after",
    ],
    ["fence keeps markup characters as code", "```\n*a* # b | c\n```", "*a* # b | c"],
    ["tilde fence", "~~~\ncode\n~~~\nafter", "code after"],
    ["fence cut open", "text\n```js\nconst a = 1;", "text const a = 1;"],
    ["table", "| a | b |\n|---|:-:|\n| c | d |", "a · b c · d"],
    ["table without outer pipes", "a | b\n--- | ---\nc | d", "a · b c · d"],
    ["table cut mid-row", "| a | b | c", "a · b · c"],
    ["table with empty cells", "| a |  | c |", "a · c"],
    ["table with escaped pipe", "| a \\| b | c |", "a | b · c"],
    ["single pipe stays", "run ls | grep foo now", "run ls | grep foo now"],
    ["logical or stays", "a || b", "a || b"],
    [
      "reference definitions",
      'text\n[guide]: https://x.y/guide "Guide"\n[b]: ./b.md\nmore',
      "text more",
    ],
    ["footnote definition keeps its text", "[^1]: The note text.", "The note text."],
    ["bracketed label with prose stays", "[Note]: remember this", "[Note]: remember this"],
    [
      "mdx import and export",
      "import Tabs from '@theme/Tabs';\nexport const meta = {};\nBody",
      "Body",
    ],

    // HTML.
    ["tags are removed", '<div class="x">html</div> and <b>bold</b>', "html and bold"],
    ["block tags separate words", "<td>a</td><td>b</td>", "a b"],
    ["inline tags do not", "<b>bo</b>ld", "bold"],
    ["void and self-closing tags", "a<br>b<br/>c <img src='a.png' alt='x'/> d", "a b c d"],
    ["attribute holding a greater-than", '<a href="x" title="a > b">link</a> rest', "link rest"],
    ["uppercase tags", "<DIV>x</DIV>", "x"],
    ["comments", "a <!-- hidden --> b <!--> c", "a b c"],
    ["multi-line comment", "a <!--\nhidden\n--> b", "a b"],
    ["unterminated comment", "a <!-- hidden forever", "a"],
    ["doctype and processing instruction", "<!DOCTYPE html><?xml version='1.0'?>text", "text"],
    ["script content is dropped", "a <script>alert('x')</script> b", "a b"],
    ["script with attributes and mixed case", '<SCRIPT type="x">alert(1)</ScRiPt >after', "after"],
    ["style content is dropped", "a <style>p { color: red }</style> b", "a b"],
    [
      "template, noscript, iframe, object",
      "a<template>t</template>b<noscript>n</noscript>c<iframe src=x>i</iframe>d<object>o</object>e",
      "a b c d e",
    ],
    ["unterminated script", "a <script>alert(1) and more text", "a"],
    ["script cut at the start", "alert(1);</script> visible", "visible"],
    ["style cut at the start", "p { color: red }</style> visible", "visible"],
    ["tag cut at the end", "text <div cl", "text"],
    ["tag cut right after the name", "text <div", "text"],
    ["tag cut after a partial name", "text <di", "text"],
    ["closing tag cut", "text </di", "text"],
    ["tag cut inside a quoted value", 'text <a href="http://x.y/', "text"],
    ["tag cut at the start", "class=\"x\" id='y'>rest of it", "rest of it"],
    ["prose with equals and greater-than stays", "when a = b > c holds", "when a = b > c holds"],
    [
      "jsx components",
      '<Callout type="warning">careful</Callout> and <Tabs>x</Tabs>',
      "careful and x",
    ],
    ["jsx self-closing", 'a <Badge /> b <Icon name="x" /> c', "a b c"],
    ["custom element", "a <my-widget>x</my-widget> b", "a x b"],
    ["generic hanging on an identifier stays", "List<Integer> items", "List<Integer> items"],
    ["lone angle bracket stays", "a < b", "a < b"],
    ["prose angle brackets stay", "<3 you", "<3 you"],

    // Entities.
    [
      "named entities",
      "a &amp; b &lt;tag&gt; &quot;q&quot; &apos;s&apos;",
      "a & b <tag> \"q\" 's'",
    ],
    ["nbsp becomes a space", "a&nbsp;&nbsp;b", "a b"],
    ["numeric entities", "&#39;x&#39; &#x27;y&#X27; &#128512;", "'x' 'y' \u{1F600}"],
    ["decoded once", "&amp;lt; &amp;amp;", "&lt; &amp;"],
    ["unknown entity stays", "&bogus; AT&T R&D", "&bogus; AT&T R&D"],
    ["entity into a control is dropped", "a&#0;b&#7;c&#x1F;d&#127;e", "abcde"],
    ["entity into zero-width and bidi is dropped", "a&#x200B;b&#x202E;c&#8206;d&#xFEFF;e", "abcde"],
    ["entity into a marker or private use is dropped", "a&#xE000;b&#57345;c&#xF0000;d", "abcd"],
    [
      "entity into a surrogate or out of range is dropped",
      "a&#xD800;b&#x110000;c&#99999999;d",
      "abcd",
    ],
    ["entity cut at the end", "text &am", "text"],
    ["numeric entity cut at the end", "text &#x2", "text"],
    ["entity cut at the start", "p; text and &lt;", "p; text and <"],
    ["named entity tail at the start", "amp; text", "text"],
    [
      "entities do not make tags",
      "&lt;script&gt;alert(1)&lt;/script&gt;",
      "<script>alert(1)</script>",
    ],

    // Characters.
    ["crlf", "a\r\nb\rc", "a b c"],
    ["unicode spaces collapse", "a\u00a0\u2003\u3000b\t\tc", "a b c"],
    [
      "zero-width and bidi are removed",
      "a\u200bb\u200dc\u202ed\u2066e\u2069f\ufeffg\u00adh",
      "abcdefgh",
    ],
    ["controls are removed", "a\u0000b\u0007c\u001bd\u007fe\u0085f", "abcdef"],
    ["foreign private use is removed", "a\uE003b\uF8FFc\u{F0000}d\u{E0041}e", "abcde"],
    ["lone surrogates are removed", "a\uD800b\uDC00c", "abc"],
    ["emoji survive", "ship 🦄 it 👍🏽", "ship 🦄 it 👍🏽"],
    ["cjk and arabic survive", "日本語 ドキュメント مرحبا", "日本語 ドキュメント مرحبا"],
    ["empty and blank", "  \n\t ", ""],
    ["only markup", "<div></div><!-- x -->**", ""],

    // Markers.
    ["plain highlight", "the ⟦deploy⟧ guide", "the ⟦deploy⟧ guide"],
    ["highlight inside strong", "**⟦deploy⟧** now", "⟦deploy⟧ now"],
    ["highlight around strong", "⟦**deploy**⟧ now", "⟦deploy⟧ now"],
    ["highlight inside emphasis", "an *⟦deploy⟧* now", "an ⟦deploy⟧ now"],
    ["highlight inside a link text", "[⟦deploy⟧ guide](https://x.y) now", "⟦deploy⟧ guide now"],
    ["highlight inside a link url is dropped", "[guide](https://x.y/⟦deploy⟧) now", "guide now"],
    ["highlight inside a cut link url is dropped", "[guide](https://x.y/⟦deploy⟧", "guide"],
    ["highlight inside code", "run `⟦deploy⟧ now`", "run ⟦deploy⟧ now"],
    ["highlight across code backticks", "⟦`deploy`⟧", "⟦deploy⟧"],
    ["highlight inside an attribute value is dropped", '<a href="/⟦deploy⟧">link</a>', "link"],
    ["highlight inside a tag name is dropped", "<⟦div⟧ class=x>text</div>", "text"],
    ["highlight on tag text is kept", "<b>⟦deploy⟧</b>", "⟦deploy⟧"],
    ["highlight inside a comment is dropped", "a <!-- ⟦deploy⟧ --> b", "a b"],
    ["highlight inside script is dropped", "a <script>⟦deploy⟧()</script> b", "a b"],
    [
      "highlight inside a url is dropped past the cut",
      "see https://x.y/⟦deploy⟧ now",
      "see x.y/⟦deploy⟧ now",
    ],
    ["highlight in a query string is dropped", "see https://x.y/a?q=⟦deploy⟧ now", "see x.y/a now"],
    ["highlight inside a heading", "## The ⟦deploy⟧ step", "The ⟦deploy⟧ step"],
    ["highlight inside a table cell", "| ⟦deploy⟧ | step |", "⟦deploy⟧ · step"],
    ["highlight on a pipe is dropped", "| a ⟦|⟧ b |", "a · b"],
    ["highlight in an entity is dropped when it has no word", "a &⟦amp⟧; b", "a & b"],
    ["highlight inside a fence", "```\n⟦deploy⟧ it\n```", "⟦deploy⟧ it"],
    ["highlight only on punctuation is dropped", "a ⟦---⟧ b ⟦,⟧ c", "a --- b , c"],
    ["highlight on whitespace only is dropped", "a⟦ ⟧b", "a b"],
    ["unclosed start", "the ⟦deploy guide", "the ⟦deploy guide⟧"],
    ["stray end", "the⟧ deploy ⟦guide⟧", "the deploy ⟦guide⟧"],
    ["nested starts close at the first end", "⟦a ⟦b⟧ c⟧ d", "⟦a b⟧ c d"],
    ["empty highlight", "a ⟦⟧ b", "a b"],
    ["adjacent highlights", "⟦a⟧⟦b⟧", "⟦ab⟧"],
    ["two terms", "⟦rate⟧ ⟦limit⟧ headers", "⟦rate⟧ ⟦limit⟧ headers"],
    ["highlight keeps the fragment delimiter outside", "⟦a⟧ … ⟦b⟧", "⟦a⟧ … ⟦b⟧"],
  ];

  it("has at least 60 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
  });

  it.each(cases)("%s", (_name, input, expected) => {
    expect(clean(input)).toBe(expected);
  });
});

describe("cleanSnippet and HEADLINE_ANGLE", () => {
  // The query layer swaps `<` for HEADLINE_ANGLE before ts_headline, which swallows `<tag>`.
  const angle = (text: string) => text.replaceAll("<", HEADLINE_ANGLE);

  it("reads the stand-in as a less-than sign", () => {
    expect(cleanSnippet(angle("a <b>bold</b> c"))).toBe("a bold c");
    expect(cleanSnippet(angle("2 < 3 and Promise<void>"))).toBe("2 < 3 and Promise<void>");
  });

  it("drops script content ts_headline would have exposed", () => {
    expect(cleanSnippet(angle("a <script>alert(1)</script> b"))).toBe("a b");
    expect(cleanSnippet(angle("a <style>p{}</style> <!-- c --> b"))).toBe("a b");
  });

  it("never outputs the stand-in", () => {
    expect(cleanSnippet(`${HEADLINE_ANGLE}${HEADLINE_ANGLE}`)).not.toContain(HEADLINE_ANGLE);
  });
});

describe("cleanSnippet fragments", () => {
  it("keeps the fragment delimiter and cleans each side on its own", () => {
    expect(clean("deploy the **app** … run `make` [now](http://x")).toBe(
      "deploy the app … run make now",
    );
  });

  it("cuts an unterminated element at the delimiter, not at the end", () => {
    expect(clean("a <script>alert(1) … b <i>c</i>")).toBe("a … b c");
  });

  it("drops a comment cut at the delimiter", () => {
    expect(clean("a <!-- cut … b")).toBe("a … b");
  });

  it("drops a tag cut at the delimiter", () => {
    expect(clean('a <div class="x … b')).toBe("a … b");
  });

  it("reads a stray closing script tag in the second fragment without eating the first", () => {
    expect(clean("first part … alert(1);</script> second part")).toBe("first part … second part");
  });

  it("drops a link tail at the start of the second fragment", () => {
    expect(clean("one … two](https://x.y) three")).toBe("one … two three");
  });
});

describe("cleanSnippet length", () => {
  it("leaves short text alone", () => {
    expect(cleanSnippet("short")).toBe("short");
  });

  it("caps at SNIPPET_MAX_CHARS code points at a word boundary with an ellipsis", () => {
    const word = "wordy ";
    const out = cleanSnippet(word.repeat(200));
    const points = Array.from(out);
    expect(points.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(points.length).toBeGreaterThan(SNIPPET_MAX_CHARS - 10);
    expect(out.endsWith("wordy…")).toBe(true);
  });

  it("cuts a single long word without splitting a surrogate pair", () => {
    const out = cleanSnippet("😀".repeat(1000), { maxChars: 11 });
    expect(Array.from(out)).toHaveLength(11);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("does not count markers", () => {
    const text = `${HIGHLIGHT_START}ab${HIGHLIGHT_END}`;
    expect(cleanSnippet(text, { maxChars: 2 })).toBe(text);
  });

  it("never leaves an open highlight when the cut is inside one", () => {
    const text = `x ${HIGHLIGHT_START}${"word ".repeat(200)}${HIGHLIGHT_END}`;
    const out = cleanSnippet(text, { maxChars: 50 });
    expect(Array.from(out.replace(/[\uE000\uE001]/g, "")).length).toBeLessThanOrEqual(50);
    expect(balanced(out)).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
});

/** Markers alternate START, END, START, END, ... and no pair is empty or whitespace-only. */
function balanced(text: string): boolean {
  let open = false;
  let run = "";
  for (const ch of text) {
    if (ch === HIGHLIGHT_START) {
      if (open) return false;
      open = true;
      run = "";
    } else if (ch === HIGHLIGHT_END) {
      if (!open || run.trim() === "") return false;
      open = false;
    } else if (open) {
      run += ch;
    }
  }
  return !open;
}

describe("cleanSnippet and splitHighlights", () => {
  it("gives parts the UI can render as text and mark", () => {
    const parts = splitHighlights(cleanSnippet(mark("a **⟦deploy⟧** [guide](http://x) b")));
    expect(parts).toEqual([
      { text: "a ", highlighted: false },
      { text: "deploy", highlighted: true },
      { text: " guide b", highlighted: false },
    ]);
  });
});

describe("cleanSnippet is safe to render as text", () => {
  const attacks = [
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
    "<scr<script>ipt>alert(1)</scr</script>ipt>",
    "<svg onload=alert(1)>",
    "<svg><script>alert(1)</script></svg>",
    "<iframe src=javascript:alert(1)></iframe>",
    "<a href=javascript:alert(1)>x</a>",
    "<a href='  javascript:alert(1)'>x</a>",
    "[x](javascript:alert(1))",
    "[x](  javascript:alert(1)  )",
    "![x](javascript:alert(1))",
    "<style>@import 'x';</style>",
    "<!--><script>alert(1)</script>-->",
    "<math><mi xlink:href=javascript:alert(1)>x</mi></math>",
    "<body onload=alert(1)>",
    "<img src=x onerror=alert(1) ",
    "<img/src=x/onerror=alert(1)>",
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<a href="x" onclick="alert(1)">x</a>',
    "<object data=javascript:alert(1)>",
    "<form action=javascript:alert(1)><input type=submit>",
  ];

  it.each(attacks)("leaves no tag fragment or script content: %s", (attack) => {
    for (const input of [attack, `before ${attack} after`, `${attack}\n${attack}`]) {
      const out = cleanSnippet(input);
      expect(out).not.toMatch(/<\s*\/?\s*[a-zA-Z!?]/);
      expect(out).not.toMatch(/alert\(1\)|evil\.example|onerror|onload|onclick|javascript:/i);
      expect(out).not.toMatch(/\]\(/);
    }
  });

  it("keeps the words around an attack", () => {
    expect(cleanSnippet("before <script>alert(1)</script> after")).toBe("before after");
    expect(cleanSnippet("before <img src=x onerror=alert(1)> after")).toBe("before after");
    expect(cleanSnippet("before [x](javascript:alert(1)) after")).toBe("before x after");
  });

  it("does not let a marker rebuild a tag", () => {
    const input = `<${HIGHLIGHT_START}script${HIGHLIGHT_END}>alert(1)<${HIGHLIGHT_START}/script${HIGHLIGHT_END}>`;
    const out = cleanSnippet(input);
    expect(out).not.toMatch(/alert|script/);
  });

  it("emits only text and the two markers", () => {
    const out = cleanSnippet(mark("⟦<b>x</b>⟧ &#xE000; &#xE001; \uE003 <script>⟦y⟧</script> ⟦z⟧"));
    expect(out).toBe(mark("⟦x⟧ ⟦z⟧"));
  });

  it("decodes entities into text only, never into a marker or a control", () => {
    const out = cleanSnippet("&#xE000;&#xE001;&#0;&#x1B;&#x202E;ok");
    expect(out).toBe("ok");
  });
});

describe("cleanSnippet robustness", () => {
  const rawWithin = (input: string, ms: number) => {
    const started = performance.now();
    const out = cleanSnippet(input);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(ms);
    expect(balanced(out)).toBe(true);
    expect(Array.from(out.replace(/[\uE000\uE001]/g, "")).length).toBeLessThanOrEqual(
      SNIPPET_MAX_CHARS,
    );
    return out;
  };

  const pathological: ReadonlyArray<readonly [string, string]> = [
    ["open brackets", "[".repeat(100_000)],
    ["close brackets", "]".repeat(100_000)],
    ["bracket parens", "[a](".repeat(30_000)],
    ["open angle", "<".repeat(100_000)],
    ["open tags", "<a ".repeat(40_000)],
    ["open tags with quotes", '<a b=" '.repeat(20_000)],
    ["open comments", "<!--".repeat(30_000)],
    ["open scripts", "<script>".repeat(15_000)],
    ["script closers", "<script></script".repeat(10_000)],
    ["stars", "*".repeat(100_000)],
    ["alternating stars", "*a ".repeat(40_000)],
    ["alternating underscores", "_a ".repeat(40_000)],
    ["backticks", "`".repeat(100_000)],
    ["varying backticks", Array.from({ length: 2000 }, (_, i) => "`".repeat(i % 50)).join("a")],
    ["nested brackets", "[".repeat(50_000) + "]".repeat(50_000)],
    ["amps", "&".repeat(100_000)],
    ["cut entities", "&#x".repeat(40_000)],
    ["pipes", "|".repeat(100_000)],
    ["single pipes", "a|".repeat(50_000)],
    ["braces", "{a.b}".repeat(30_000)],
    ["open braces", "{".repeat(100_000)],
    ["colons", ":a".repeat(50_000)],
    ["urls", "http://a ".repeat(10_000)],
    ["long url", "https://" + "a".repeat(100_000)],
    ["newlines", "\n".repeat(100_000)],
    ["bullets", "- ".repeat(50_000)],
    ["hashes", "# ".repeat(50_000)],
    ["markers", HIGHLIGHT_START.repeat(100_000)],
    ["marker pairs", `${HIGHLIGHT_START}a${HIGHLIGHT_END}`.repeat(30_000)],
    ["markers in tags", `<${HIGHLIGHT_START}a `.repeat(30_000)],
    ["lone surrogates", "\uD800".repeat(100_000)],
    ["1 MB of mixed markup", '[a](b) **c** `d` <e f="g"> &h; | i |\n'.repeat(30_000)],
    ["1 MB of brackets and angles", "[<*_`&|{:".repeat(120_000)],
  ];

  it.each(pathological)("handles %s quickly", (_name, input) => {
    expect(() => rawWithin(input, 400)).not.toThrow();
  });

  it("handles 1 MB of adversarial input in under 200 ms", () => {
    const input = "[<*_`&|{:<a [x](".repeat(65_536);
    expect(input.length).toBeGreaterThanOrEqual(1_000_000);
    cleanSnippet(input);
    const started = performance.now();
    cleanSnippet(input);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("scales linearly with the input once the input cap is raised", () => {
    const unit = '[a](b) **c** `d` <e f="g"> &h; | i | <a <a [[ ** __ \n';
    const run = (copies: number) => {
      const input = unit.repeat(copies);
      const options = { maxInputChars: input.length + 1 };
      cleanSnippet(input, options);
      const started = performance.now();
      cleanSnippet(input, options);
      return performance.now() - started;
    };
    // Warm up, then compare 4x the input: linear is about 4x; quadratic would be about 16x.
    run(500);
    const small = Math.max(run(2000), 1);
    const large = run(8000);
    expect(large / small).toBeLessThan(9);
  });

  it("returns an empty string for input that is not text", () => {
    expect(cleanSnippet(undefined as unknown as string)).toBe("");
    expect(cleanSnippet(null as unknown as string)).toBe("");
    expect(cleanSnippet(42 as unknown as string)).toBe("");
    expect(cleanSnippet("")).toBe("");
  });
});

describe("cleanSnippet properties", () => {
  const pieces = [
    "**bold**",
    "__strong__",
    "*em*",
    "_em_",
    "~~gone~~",
    "`code` ",
    "```inline fence``` ",
    '[link text](https://x.y/z "title")',
    "[link](https://x.y/⟦deploy⟧)",
    "[⟦deploy⟧ guide](u)",
    "[ref text][ref]",
    "![alt text](a.png)",
    "[^1]",
    "[ref]: https://x.y/ref",
    '<div class="x">',
    "</div>",
    "<p>",
    "<br/>",
    "<img src=x onerror=alert(1)>",
    '<a href="https://x.y/?q=a>b">',
    "</a>",
    "<span title='a > b'>",
    '<Callout type="warning">',
    "</Callout>",
    "<my-widget>",
    "<!-- comment -->",
    "<script>alert(1)</script>",
    "<script>",
    "</script>",
    "<style>p{}</style>",
    "<iframe src=x>",
    "&amp;",
    "&#x27;",
    "&#39;",
    "&nbsp;",
    "&#xE000;",
    "&#8238;",
    "[a][b]",
    '[b]: https://x.y/b "T"',
    "<https://x.y/auto>",
    "https://github.com/org/repo/pull/12",
    "www.example.org/a",
    "# heading",
    "## heading ##",
    "> quote",
    "- item",
    "1. item",
    "- [ ] task",
    "| a | b |",
    "|---|---|",
    "---",
    "***",
    "=====",
    ":smile:",
    "{props.title}",
    "{items.map(x => x)}",
    "import X from 'x';",
    "\u200bzero\u202ebidi\u0000nul\uE003",
    "\r\n",
    "word",
    "deploy",
    "⟦deploy⟧",
    "⟦",
    "⟧",
    "plain text with spaces",
    " ",
    "\n",
  ];

  // Syntax cut by the end or the start of a fragment only occurs there.
  const tails = [
    "<!-- cut comment",
    "<div cl",
    "<di",
    "</sc",
    "&am",
    "&#x2",
    "[link](ht",
    '[link](https://x.y "ti',
    "<a href='http://x.y/",
    "<script>alert(1)",
  ];
  const heads = ["alt](a.png) ", "class=\"x\" id='y'>", "alert(1);</script> ", ""];

  // A small deterministic generator, so a failure reproduces.
  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  const joiners = ["", " ", "\n", "", " "];

  // A tag glued to a word is a generic (`List<Integer>`), which stays; pieces that start a tag
  // therefore never follow a word directly.
  const piece = (next: () => number) => {
    const text = pieces[Math.floor(next() * pieces.length)]!;
    return text.startsWith("<") ? ` ${text}` : text;
  };

  function build(next: () => number): string {
    const count = 1 + Math.floor(next() * 12);
    let input = heads[Math.floor(next() * heads.length)]!;
    for (let k = 0; k < count; k++) {
      input += piece(next) + joiners[Math.floor(next() * joiners.length)]!;
    }
    if (next() < 0.3) input += ` ${tails[Math.floor(next() * tails.length)]!}`;
    return input;
  }

  it("holds the output invariants for random combinations", () => {
    const next = random(20260101);
    for (let round = 0; round < 3000; round++) {
      let input = build(next);
      // Occasionally cut the input at the end anywhere, as ts_headline does.
      const cut = next() < 0.4;
      if (cut) input = mark(input).slice(0, Math.floor(next() * input.length));
      const out = cleanSnippet(mark(input));
      const text = out.replace(/[\uE000\uE001]/g, "");
      const context = `input ${JSON.stringify(show(mark(input)))} gave ${JSON.stringify(show(out))}`;

      expect(balanced(out), context).toBe(true);
      // Only the two markers from the private-use area; no other control or invisible character.
      expect(text, context).not.toMatch(
        /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uE000-\uF8FF]/,
      );
      expect(text, context).not.toMatch(/[\u{F0000}-\u{10FFFF}]/u);
      expect(text, context).not.toMatch(/<\/?(?:[a-zA-Z][\w:-]*)(?:[\s/>]|$)/);
      expect(text, context).not.toMatch(/<[!?]/);
      expect(text, context).not.toContain("](");
      expect(text, context).not.toContain("**");
      expect(text, context).not.toContain("`");
      expect(text, context).not.toContain("<!--");
      expect(text, context).not.toContain("<script");
      // A cut can leave the content of an element whose opening tag was in the first fragment.
      if (!cut) expect(text, context).not.toMatch(/alert\(1\)/);
      expect(text, context).not.toMatch(/\s{2,}|\n|\t/);
      expect(text, context).toBe(text.trim());
      expect(Array.from(text).length, context).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    }
  });

  it("leaves plain words alone", () => {
    const next = random(11);
    const words = [
      "deploy",
      "rate",
      "limit",
      "snake_case",
      "C++",
      "2<3",
      "a,b",
      "x.y",
      "ünï",
      "日本",
    ];
    for (let round = 0; round < 300; round++) {
      const text = Array.from({ length: 1 + Math.floor(next() * 20) }, () => {
        return words[Math.floor(next() * words.length)]!;
      }).join(" ");
      expect(cleanSnippet(text)).toBe(text);
    }
  });

  it("keeps a marker on the word it surrounded through any wrapper", () => {
    const wrappers = [
      (t: string) => t,
      (t: string) => `**${t}**`,
      (t: string) => `*${t}*`,
      (t: string) => `_${t}_`,
      (t: string) => `~~${t}~~`,
      (t: string) => `\`${t}\``,
      (t: string) => `[${t}](https://x.y/z)`,
      (t: string) => `[${t}][ref]`,
      (t: string) => `# ${t}`,
      (t: string) => `> ${t}`,
      (t: string) => `- ${t}`,
      (t: string) => `1. ${t}`,
      (t: string) => `| ${t} | other |`,
      (t: string) => `<b>${t}</b>`,
      (t: string) => `<a href="/x">${t}</a>`,
      (t: string) => `<Callout type="x">${t}</Callout>`,
      (t: string) => `<p>${t}</p>`,
      (t: string) => `\`\`\`\n${t}\n\`\`\``,
    ];
    for (const wrap of wrappers) {
      for (const inner of [
        `${HIGHLIGHT_START}deploy${HIGHLIGHT_END}`,
        `x ${HIGHLIGHT_START}deploy${HIGHLIGHT_END} y`,
      ]) {
        const parts = splitHighlights(cleanSnippet(`before\n${wrap(inner)}\nafter`));
        const marked = parts.filter((p) => p.highlighted).map((p) => p.text);
        expect(marked, wrap(inner)).toEqual(["deploy"]);
      }
    }
  });
});
