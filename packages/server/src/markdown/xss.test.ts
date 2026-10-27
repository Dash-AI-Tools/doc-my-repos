import { describe, expect, it } from "vitest";

import { assertSafeHtml } from "./assert-safe-html";
import { renderMarkdown } from "./pipeline";

/**
 * XSS corpus (OWASP filter-evasion and PortSwigger cheat-sheet style, plus Markdown-specific
 * vectors). Every payload is rendered on its own and inside common Markdown containers, and the
 * output must pass the independent `assertSafeHtml` oracle, which re-parses it with parse5.
 * `gone` lists text that must not survive anywhere in the output (for script and style bodies,
 * which must be removed, not shown as text).
 */
interface Case {
  readonly name: string;
  readonly input: string;
  readonly gone?: readonly string[];
}

const CORPUS: readonly Case[] = [
  // The task's three.
  { name: "script tag", input: "<script>alert(1)</script>", gone: ["alert"] },
  { name: "img onerror", input: '<img src="x" onerror="alert(1)">', gone: ["alert"] },
  { name: "markdown javascript: link", input: "[x](javascript:alert(1))", gone: ["alert"] },

  // Script variants.
  { name: "script with src", input: '<script src="https://evil.example/x.js"></script>' },
  { name: "uppercase script", input: "<SCRIPT>alert(1)</SCRIPT>", gone: ["alert"] },
  { name: "script with attrs", input: '<script type="module">alert(1)</script>', gone: ["alert"] },
  { name: "unclosed script", input: "<script>alert(1)", gone: ["alert"] },
  { name: "script split by null", input: "<scr\u0000ipt>alert(1)</scr\u0000ipt>" },
  { name: "nested script", input: "<scr<script>ipt>alert(1)</scr</script>ipt>" },
  { name: "script in inline position", input: "text <script>alert(1)</script> more" },
  { name: "script in comment trick", input: "<!--><script>alert(1)</script>-->" },
  { name: "cdata", input: "<![CDATA[<script>alert(1)</script>]]>" },
  { name: "comment close trick", input: "<!-- --!><script>alert(1)</script> -->" },

  // Event handlers.
  { name: "img onload", input: '<img src="a.png" onload="alert(1)">', gone: ["alert"] },
  { name: "img unquoted onerror", input: "<img src=x onerror=alert(1)>", gone: ["alert"] },
  { name: "img slash separator", input: "<img/src=x/onerror=alert(1)>" },
  { name: "img uppercase handler", input: '<IMG SRC=x ONERROR="alert(1)">', gone: ["alert"] },
  { name: "img backtick", input: "<img src=`x` onerror=`alert(1)`>" },
  { name: "img newline in tag", input: "<img\nsrc=x\nonerror=alert(1)>", gone: ["alert"] },
  { name: "body onload", input: '<body onload="alert(1)">x</body>', gone: ["alert"] },
  { name: "div onmouseover", input: '<div onmouseover="alert(1)">hover</div>', gone: ["alert"] },
  { name: "a onclick", input: '<a href="#" onclick="alert(1)">x</a>', gone: ["alert"] },
  {
    name: "details ontoggle",
    input: '<details open ontoggle="alert(1)"><summary>s</summary></details>',
    gone: ["alert"],
  },
  { name: "input autofocus onfocus", input: '<input autofocus onfocus="alert(1)">' },
  { name: "input text with value", input: '<input type="text" name="q" value="x" form="f">' },
  { name: "select onfocus", input: "<select autofocus onfocus=alert(1)></select>" },
  { name: "textarea onfocus", input: "<textarea autofocus onfocus=alert(1)>x</textarea>" },
  { name: "marquee onstart", input: "<marquee onstart=alert(1)>x</marquee>", gone: ["alert"] },
  { name: "video source onerror", input: "<video><source onerror=alert(1)></video>" },
  { name: "audio src onerror", input: "<audio src=x onerror=alert(1)></audio>" },
  { name: "p onpointerenter", input: "<p onpointerenter=alert(1)>x</p>", gone: ["alert"] },
  { name: "custom element handler", input: "<x-y onclick=alert(1)>x</x-y>", gone: ["alert"] },
  { name: "heading handler", input: '<h1 id="x" onclick="alert(1)">x</h1>', gone: ["alert"] },

  // SVG and MathML.
  { name: "svg onload", input: "<svg onload=alert(1)>", gone: ["alert"] },
  { name: "svg script", input: "<svg><script>alert(1)</script></svg>", gone: ["alert"] },
  {
    name: "svg animate href",
    input:
      '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text y="20">x</text></a></svg>',
    gone: ["alert"],
  },
  {
    name: "svg use xlink",
    input: '<svg><use xlink:href="data:image/svg+xml,<svg id=x onload=alert(1)>#x"/></svg>',
  },
  { name: "svg foreignObject", input: "<svg><foreignObject><img src=x onerror=alert(1)>" },
  { name: "math href", input: '<math href="javascript:alert(1)">x</math>' },
  {
    name: "math maction",
    input:
      '<math><maction actiontype="statusline" xlink:href="javascript:alert(1)">x</maction></math>',
  },

  // mXSS.
  {
    name: "noscript title breakout",
    input: '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  },
  { name: "svg style breakout", input: "<svg><style><img src onerror=alert(1)></style></svg>" },
  {
    name: "math mglyph style comment",
    input:
      '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
  },
  {
    name: "form math mglyph",
    input: "<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>",
  },
  {
    name: "template breakout",
    input: "<template><style></template><img src=x onerror=alert(1)></style></template>",
  },
  { name: "xmp breakout", input: '<xmp><p title="</xmp><img src=x onerror=alert(1)>">' },
  { name: "plaintext", input: "<plaintext><img src=x onerror=alert(1)>" },
  { name: "textarea breakout", input: "<textarea></textarea><img src=x onerror=alert(1)>" },
  { name: "title breakout", input: '<title><a title="</title><img src=x onerror=alert(1)>">' },
  { name: "noembed breakout", input: '<noembed><a title="</noembed><img src onerror=alert(1)>">' },
  {
    name: "noframes breakout",
    input: '<noframes><a title="</noframes><img src onerror=alert(1)>">',
  },
  {
    name: "style img inside",
    input: "<style><img src=x onerror=alert(1)></style>",
    gone: ["alert"],
  },
  { name: "listing", input: "<listing>&lt;img src=x onerror=alert(1)&gt;</listing>" },
  { name: "table foster parenting", input: "<table><img src=x onerror=alert(1)><tr><td>x" },
  { name: "unclosed attribute", input: '<a href="https://x.example title=x onclick=alert(1)>x' },
  { name: "attribute without quotes", input: "<a title=x onclick=alert(1) href=#>x</a>" },

  // Dangerous elements.
  { name: "iframe src", input: '<iframe src="javascript:alert(1)"></iframe>' },
  { name: "iframe srcdoc", input: '<iframe srcdoc="<script>alert(1)</script>"></iframe>' },
  { name: "object data", input: '<object data="javascript:alert(1)"></object>' },
  { name: "object fallback", input: '<object data="x.swf"><img src=x onerror=alert(1)></object>' },
  { name: "embed", input: '<embed src="javascript:alert(1)">' },
  { name: "applet", input: '<applet code="x.class"></applet>' },
  { name: "frameset", input: '<frameset><frame src="javascript:alert(1)"></frameset>' },
  { name: "portal", input: '<portal src="https://evil.example"></portal>' },
  {
    name: "form action",
    input: '<form action="https://evil.example"><input name="password"></form>',
  },
  { name: "button formaction", input: '<button formaction="javascript:alert(1)">x</button>' },
  { name: "base href", input: '<base href="https://evil.example/">' },
  {
    name: "meta refresh",
    input: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  },
  { name: "link stylesheet", input: '<link rel="stylesheet" href="https://evil.example/x.css">' },
  { name: "link import", input: '<link rel="import" href="https://evil.example/x.html">' },
  {
    name: "style import",
    input: "<style>@import 'https://evil.example/x.css';</style>",
    gone: ["@import"],
  },
  {
    name: "style expression",
    input: "<style>body{background:url(javascript:alert(1))}</style>",
    gone: ["alert"],
  },

  // Style attributes.
  {
    name: "style expression attr",
    input: '<div style="width:expression(alert(1))">x</div>',
    gone: ["alert"],
  },
  {
    name: "style url javascript",
    input: '<div style="background:url(javascript:alert(1))">x</div>',
    gone: ["alert"],
  },
  { name: "style behavior", input: '<div style="behavior:url(x.htc)">x</div>', gone: ["behavior"] },
  {
    name: "style overlay",
    input: '<div style="position:fixed;inset:0;z-index:9999">x</div>',
    gone: ["fixed"],
  },
  {
    name: "span style url",
    input: '<span style="background-image:url(https://evil.example/t.png)">x</span>',
    gone: ["evil"],
  },
  { name: "pre style escaped", input: '<pre style="colo\\72:red;background:u\\72l(x)">x</pre>' },

  // URL schemes.
  { name: "a javascript", input: '<a href="javascript:alert(1)">x</a>', gone: ["alert"] },
  { name: "a entity scheme", input: '<a href="&#106;avascript:alert(1)">x</a>', gone: ["alert"] },
  {
    name: "a hex entity scheme",
    input: '<a href="&#x6A;&#x61;vascript:alert(1)">x</a>',
    gone: ["alert"],
  },
  {
    name: "a entity no semicolon",
    input: '<a href="&#106&#97vascript:alert(1)">x</a>',
    gone: ["alert"],
  },
  { name: "a tab in scheme", input: '<a href="jav&#x09;ascript:alert(1)">x</a>', gone: ["alert"] },
  {
    name: "a newline in scheme",
    input: '<a href="jav&#x0A;ascript:alert(1)">x</a>',
    gone: ["alert"],
  },
  { name: "a colon entity", input: '<a href="javascript&colon;alert(1)">x</a>', gone: ["alert"] },
  { name: "a leading space", input: '<a href=" javascript:alert(1)">x</a>', gone: ["alert"] },
  {
    name: "a leading control",
    input: '<a href="&#x01;javascript:alert(1)">x</a>',
    gone: ["alert"],
  },
  { name: "a mixed case", input: '<a href="JaVaScRiPt:alert(1)">x</a>', gone: ["alert"] },
  { name: "a vbscript", input: '<a href="vbscript:msgbox(1)">x</a>', gone: ["msgbox"] },
  {
    name: "a data html",
    input: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
    gone: ["base64"],
  },
  { name: "a file", input: '<a href="file:///etc/passwd">x</a>', gone: ["passwd"] },
  { name: "a blob", input: '<a href="blob:https://x.example/1">x</a>', gone: ["blob:"] },
  {
    name: "a ping",
    input: '<a href="https://ok.example" ping="https://evil.example">x</a>',
    gone: ["evil"],
  },
  {
    name: "a target blank",
    input: '<a href="https://ok.example" target="_blank">x</a>',
    gone: ["_blank"],
  },
  {
    name: "a rel opener",
    input: '<a href="https://ok.example" rel="opener">x</a>',
    gone: ['opener"'],
  },
  { name: "markdown entity scheme", input: "[x](&#106;avascript:alert(1))", gone: ["alert"] },
  { name: "markdown uppercase scheme", input: "[x](JAVASCRIPT:alert(1))", gone: ["JAVASCRIPT:"] },
  { name: "markdown angle scheme", input: "[x](<javascript:alert(1)>)", gone: ["href"] },
  { name: "markdown spaced scheme", input: "[x]( javascript:alert(1))", gone: ["href"] },
  { name: "markdown reference link", input: "[x][r]\n\n[r]: javascript:alert(1)", gone: ["href"] },
  { name: "markdown autolink", input: "<javascript:alert(1)>", gone: ["href"] },
  { name: "markdown data link", input: "[x](data:text/html,<script>alert(1)</script>)" },
  { name: "markdown vbscript link", input: "[x](vbscript:msgbox(1))", gone: ["href"] },
  { name: "markdown image javascript", input: "![x](javascript:alert(1))", gone: ["src"] },
  {
    name: "markdown image data svg",
    input: "![x](data:image/svg+xml;base64,PHN2Zz4=)",
    gone: ["src"],
  },
  {
    name: "img data uri",
    input: '<img src="data:image/png;base64,iVBORw0KGgo=">',
    gone: ["data:"],
  },
  {
    name: "img srcset",
    input: '<img src="a.png" srcset="javascript:alert(1) 1x">',
    gone: ["srcset"],
  },
  {
    name: "img lowsrc dynsrc",
    input: '<img lowsrc="javascript:alert(1)" dynsrc="javascript:alert(1)">',
  },
  { name: "link title quotes", input: '[x](https://ok.example "a\\" onmouseover=\\"alert(1)")' },
  { name: "image title quotes", input: '![x](a.png "a\\" onerror=\\"alert(1)")' },
  {
    name: "blockquote cite",
    input: '<blockquote cite="javascript:alert(1)">x</blockquote>',
    gone: ["alert"],
  },
  { name: "xlink href on a", input: '<a xlink:href="javascript:alert(1)">x</a>', gone: ["alert"] },
  {
    name: "background attr",
    input: '<table background="javascript:alert(1)"><tr><td>x</td></tr></table>',
  },

  // DOM clobbering.
  { name: "img name", input: '<img name="cookie" src="a.png">', gone: ["cookie"] },
  { name: "a id cookie", input: '<a id="cookie" href="#">x</a>', gone: ["cookie"] },
  {
    name: "form clobber",
    input: '<form id="x"><input name="attributes"></form>',
    gone: ["attributes"],
  },
  { name: "heading __proto__", input: '<h1 id="__proto__">x</h1>' },
  { name: "heading document", input: '<h2 id="document">x</h2>' },
  { name: "markdown heading constructor", input: "## constructor" },
  { name: "div id", input: '<div id="defaultView">x</div>', gone: ["defaultView"] },

  // Markdown-specific.
  {
    name: "code fence with HTML",
    input: "```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```",
  },
  { name: "indented code with HTML", input: "    <script>alert(1)</script>" },
  { name: "inline code with HTML", input: "`<img src=x onerror=alert(1)>`" },
  { name: "heading with HTML", input: "# Title <img src=x onerror=alert(1)>" },
  { name: "footnote with HTML", input: "a[^1]\n\n[^1]: <img src=x onerror=alert(1)>" },
  { name: "table cell with HTML", input: "| a |\n|---|\n| <img src=x onerror=alert(1)> |" },
  {
    name: "task list extra input",
    input: '- [ ] <input type="text" name="x" value="y" checked onclick="alert(1)">',
  },
  {
    name: "markdown inside HTML block",
    input: "<div>\n\n[x](javascript:alert(1))\n\n</div>",
    gone: ["href"],
  },
  { name: "emphasis around tag", input: "*<img src=x onerror=alert(1)>*" },
  {
    name: "long attribute",
    input: `<a href="https://ok.example/${"a".repeat(20000)}" title="${"t".repeat(20000)}">x</a>`,
  },
  { name: "utf-7", input: "+ADw-script+AD4-alert(1)+ADw-/script+AD4-" },
  { name: "bom before tag", input: "﻿<script>alert(1)</script>", gone: ["alert"] },
  { name: "null bytes", input: "<img src=x on\u0000error=alert(1)>" },
  { name: "mdx import", input: "import X from 'y'\n\nexport const z = 1" },
  { name: "mdx expression", input: "{alert(1)}" },
  { name: "mdx component", input: "<Component onClick={() => alert(1)} />" },
  { name: "mdx lowercase component", input: "<div onClick={alert(1)}>x</div>" },
];

/** Puts a payload inside common Markdown containers. */
const CONTEXTS: readonly ((payload: string) => string)[] = [
  (p) => p,
  (p) => `before\n\n${p}\n\nafter`,
  (p) => `- ${p.replace(/\n/g, "\n  ")}`,
  (p) => `> ${p.replace(/\n/g, "\n> ")}`,
  (p) => `Text[^n].\n\n[^n]: ${p.replace(/\n/g, "\n    ")}`,
  (p) => `<details><summary>s</summary>\n\n${p}\n\n</details>`,
];

const ONE_LINE: readonly ((payload: string) => string)[] = [
  (p) => `## ${p}`,
  (p) => `| h |\n|---|\n| ${p.replace(/[\\|]/g, "\\$&")} |`,
  (p) => `**${p}**`,
];

const FORBIDDEN_TAG =
  /<(?:script|style|iframe|frame|object|embed|applet|portal|form|button|select|textarea|base|meta|link|svg|math|noscript|template|xmp|plaintext|noembed|noframes|title|video|audio|source|picture)\b/i;

/** A start tag with only double-quoted attribute values, as rehype-stringify writes them. */
const START_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(?:\s+[^\s"'>/=]+(?:="[^"]*")?)*\s*\/?>/y;
const END_TAG = /<\/[a-zA-Z][a-zA-Z0-9-]*>/y;

/**
 * A string-level check that does not depend on any parser. It walks the output from left to
 * right: text has its `<` escaped, so every `<` must start a well-formed end tag or a start tag
 * with quoted values (whose contents are skipped, since `<` is literal inside a quoted value).
 * Returns malformed tags, tags with an `on*` attribute, and forbidden elements.
 */
function badTags(html: string): string[] {
  const bad: string[] = [];
  let at = html.indexOf("<");
  while (at !== -1) {
    START_TAG.lastIndex = at;
    END_TAG.lastIndex = at;
    const start = START_TAG.exec(html);
    const end = start === null ? END_TAG.exec(html) : null;
    if (start !== null) {
      const tag = start[0];
      if (FORBIDDEN_TAG.test(tag)) bad.push(tag);
      else if (/\son[a-z]*\s*(?:=|\s|\/?>)/i.test(tag.replace(/="[^"]*"/g, ""))) bad.push(tag);
      at = html.indexOf("<", at + tag.length);
    } else if (end !== null) {
      if (FORBIDDEN_TAG.test(end[0].replace("</", "<"))) bad.push(end[0]);
      at = html.indexOf("<", at + end[0].length);
    } else {
      bad.push(html.slice(at, at + 60));
      at = html.indexOf("<", at + 1);
    }
  }
  return bad;
}

async function check(input: string, gone: readonly string[] = []): Promise<string> {
  const { html } = await renderMarkdown(input);
  assertSafeHtml(html, JSON.stringify(input.slice(0, 200)));
  expect(badTags(html)).toEqual([]);
  for (const text of gone) expect(html, input).not.toContain(text);
  return html;
}

describe("string-level tag check", () => {
  it("sees handlers, forbidden and malformed tags, and ignores text and attribute values", () => {
    expect(badTags('<img src="x" onerror="a">')).toHaveLength(1);
    expect(badTags("<img src=x onerror>")).toHaveLength(1);
    expect(badTags('<img src="x" onerror>')).toHaveLength(1);
    expect(badTags("<p>a</p><script>x</script>")).toEqual(["<script>", "</script>"]);
    expect(
      badTags('<p title="x onclick=y <img src=x onerror=a>">&#x3C;img onerror=x></p>'),
    ).toEqual([]);
  });
});

describe("XSS corpus", () => {
  it("has a broad corpus", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(80);
  });

  it.each(CORPUS)("$name", async ({ input, gone }) => {
    await check(input, gone);
  });

  it.each(CORPUS)("$name, inside Markdown containers", async ({ input }) => {
    for (const wrap of CONTEXTS) await check(wrap(input));
    if (!input.includes("\n")) for (const wrap of ONE_LINE) await check(wrap(input));
  });
});

describe("XSS corpus specifics", () => {
  it("renders a javascript: link as inert text", async () => {
    expect(await check("[x](javascript:alert(1))")).toBe("<p><a>x</a></p>");
    expect(await check("<javascript:alert(1)>")).toBe("<p><a>javascript:alert(1)</a></p>");
  });

  it("removes script and style bodies instead of showing them", async () => {
    expect((await check("<script>alert(1)</script>\n\nok")).trim()).toBe("<p>ok</p>");
    expect((await check("<style>body{}</style>\n\nok")).trim()).toBe("<p>ok</p>");
  });

  it("keeps a code fence's HTML as escaped text", async () => {
    expect(await check("```html\n<img src=x onerror=alert(1)>\n```")).toBe(
      '<pre><code class="language-html">&#x3C;img src=x onerror=alert(1)>\n</code></pre>',
    );
  });

  it("makes any input a disabled checkbox with no name or value", async () => {
    const out = await check('<input type="text" name="x" value="y" checked onclick="alert(1)">');
    expect(out).toBe('<input checked type="checkbox" disabled aria-label="Task item">');
  });

  it("keeps a link title with quotes inside the attribute", async () => {
    const out = await check('[x](https://ok.example "a\\" onmouseover=\\"alert(1)")');
    expect(out).toBe(
      '<p><a href="https://ok.example" title="a&#x22; onmouseover=&#x22;alert(1)" rel="nofollow noopener noreferrer">x</a></p>',
    );
  });

  it("drops text attributes that carry markup (mXSS belt)", async () => {
    expect(await check('<p title="</noscript><img src=x onerror=alert(1)>">x</p>')).toBe(
      "<p>x</p>",
    );
    expect(await check('<img alt="--><img src=x onerror=alert(1)>" src="a.png">')).toBe(
      '<img src="a.png" loading="lazy">',
    );
    expect(await check('<p title="]]><img src=x onerror=alert(1)>">x</p>')).toBe("<p>x</p>");
  });

  it("keeps ordinary tag mentions in text attributes", async () => {
    expect(await check("## The `<details>` element\n")).toContain(
      'aria-label="Link to section: The <details> element"',
    );
    expect(await check('<img alt="a <b> tag" src="a.png">')).toBe(
      '<img alt="a <b> tag" src="a.png" loading="lazy">',
    );
  });

  it("leaves MDX inert", async () => {
    expect(await check("{alert(1)}")).toBe("<p>{alert(1)}</p>");
    expect(await check("import X from 'y'")).toBe("<p>import X from 'y'</p>");
    expect(await check("<Component onClick={() => alert(1)} />")).not.toContain("<component");
  });
});
