import type { Element, Root } from "hast";
import { describe, expect, it } from "vitest";

import { assertSafeHtml, findUnsafeHtml } from "./assert-safe-html";
import { createProcessor, renderMarkdown, type RenderSlots } from "./pipeline";
import {
  anchorId,
  filterStyle,
  isAllowedUrl,
  isExternalUrl,
  rehypeSafeHtml,
  SANITIZE_SCHEMA,
  urlScheme,
} from "./sanitize";

async function html(source: string, slots?: RenderSlots): Promise<string> {
  const out = (await renderMarkdown(source, slots ? { slots } : {})).html;
  assertSafeHtml(out, source);
  return out;
}

function element(
  tagName: string,
  properties: Element["properties"] = {},
  children: Element["children"] = [],
): Element {
  return { type: "element", tagName, properties, children };
}

/** A rehype plugin that appends `nodes` to the tree, as a misbehaving slot would. */
function inject(...nodes: Element[]) {
  return () => (tree: Root) => {
    tree.children.push(...nodes);
  };
}

describe("filterStyle", () => {
  it("keeps what Shiki's dual themes emit", () => {
    expect(filterStyle("color:#D73A49;--shiki-dark:#F97583")).toBe(
      "color:#D73A49;--shiki-dark:#F97583",
    );
    expect(
      filterStyle(
        "background-color:#fff;--shiki-dark-bg:#24292e;color:#24292e;--shiki-dark:#e1e4e8",
      ),
    ).toBe("background-color:#fff;--shiki-dark-bg:#24292e;color:#24292e;--shiki-dark:#e1e4e8");
    expect(
      filterStyle(
        "color:#6A737D;font-style:italic;--shiki-dark:#6A737D;--shiki-dark-font-style:italic",
      ),
    ).toBe("color:#6A737D;font-style:italic;--shiki-dark:#6A737D;--shiki-dark-font-style:italic");
    expect(filterStyle("--shiki-light:#000; --shiki-light-font-weight: bold ;")).toBe(
      "--shiki-light:#000;--shiki-light-font-weight:bold",
    );
    expect(filterStyle("text-decoration:underline;font-weight:bold")).toBe(
      "text-decoration:underline;font-weight:bold",
    );
  });

  it.each([
    "background:url(javascript:alert(1))",
    "background-image:url(https://evil.example/x.png)",
    "color:expression(alert(1))",
    "width:expression(alert(1))",
    "behavior:url(x.htc)",
    "-moz-binding:url(x.xml#xss)",
    "position:fixed;top:0;left:0;width:100%;height:100%",
    "color:red",
    "color:rgb(0,0,0)",
    "color:var(--secret)",
    "color:#fff !important",
    "color:#ff\\0000",
    "colo\\72:#fff",
    "COLOR:#fff",
    "color:/**/#fff",
    "color:#fffff",
    "color:#ggg",
    "--shiki-dark:url(x)",
    "--shiki-dark:expression(alert(1))",
    "--other:#fff",
    "--shiki-:#fff",
    "--shiki-dark:red",
    "font-style:oblique 10deg",
    "font-family:evil",
    "content:'x'",
    "display:none",
    "opacity:0",
    "@import 'https://evil.example/x.css'",
    "constructor:#fff",
    "__proto__:#fff",
    "",
    ";;;",
  ])("removes %j entirely", (style) => {
    expect(filterStyle(style)).toBeUndefined();
  });

  it("keeps the safe declarations and drops the rest", () => {
    expect(filterStyle("color:#fff;background:url(javascript:alert(1));font-style:italic")).toBe(
      "color:#fff;font-style:italic",
    );
    expect(filterStyle('color:#fff";onmouseover="alert(1)')).toBeUndefined();
  });

  it("rejects very long styles and caps the declaration count", () => {
    expect(filterStyle(`color:#fff;${" ".repeat(600)}`)).toBeUndefined();
    const many = Array.from({ length: 30 }, () => "color:#fff").join(";");
    expect(filterStyle(many)?.split(";")).toHaveLength(16);
  });

  it("only produces a fixed character set", () => {
    const out = filterStyle("color:#AbC;--shiki-a-b-c-d:line-through;font-weight:normal") ?? "";
    expect(out).toMatch(/^[a-zA-Z0-9#:;-]+$/);
  });
});

describe("URL policy", () => {
  it.each([
    ["href", "https://example.com/a?b#c"],
    ["href", "http://example.com"],
    ["href", "mailto:me@example.com"],
    ["href", "#section"],
    ["href", "./other.md"],
    ["href", "../x/y.md"],
    ["href", "/abs/path"],
    ["href", "//cdn.example.com/x"],
    ["href", "?q=1"],
    ["href", "docs/a:b"],
    ["src", "https://example.com/a.png"],
    ["src", "img/a.png"],
    ["cite", "https://example.com"],
  ])("allows %s=%j", (attribute, url) => {
    expect(isAllowedUrl(attribute, url)).toBe(true);
  });

  it.each([
    ["href", "javascript:alert(1)"],
    ["href", "JAVASCRIPT:alert(1)"],
    ["href", "JaVaScRiPt:alert(1)"],
    ["href", " javascript:alert(1)"],
    ["href", "\u0001javascript:alert(1)"],
    ["href", "java\tscript:alert(1)"],
    ["href", "java\nscript:alert(1)"],
    ["href", "java\rscript:alert(1)"],
    ["href", "javascript\t:alert(1)"],
    ["href", "vbscript:msgbox(1)"],
    ["href", "data:text/html,<script>alert(1)</script>"],
    ["href", "file:///etc/passwd"],
    ["href", "blob:https://example.com/uuid"],
    ["href", "livescript:alert(1)"],
    ["href", "jar:https://x!/"],
    ["href", "intent://x#Intent;end"],
    ["href", "unknown:x/a"],
    ["src", "data:image/svg+xml,<svg onload=alert(1)>"],
    ["src", "mailto:x@y"],
    ["src", "javascript:alert(1)"],
    ["cite", "javascript:alert(1)"],
    ["href", "https://ok.example/\u0000"],
  ])("rejects %s=%j", (attribute, url) => {
    expect(isAllowedUrl(attribute, url)).toBe(false);
  });

  it("reads the scheme the way a browser does", () => {
    expect(urlScheme("  \tJaVa\nScRiPt:x")).toBe("javascript");
    expect(urlScheme("/a:b")).toBeNull();
    expect(urlScheme("#a:b")).toBeNull();
  });

  it("classifies external URLs, including protocol-relative and backslash forms", () => {
    expect(isExternalUrl("https://x.example")).toBe(true);
    expect(isExternalUrl("HTTP://x.example")).toBe(true);
    expect(isExternalUrl("https:x.example")).toBe(true);
    expect(isExternalUrl("//x.example")).toBe(true);
    expect(isExternalUrl("\\\\x.example")).toBe(true);
    expect(isExternalUrl("/\\x.example")).toBe(true);
    expect(isExternalUrl("/docs/a")).toBe(false);
    expect(isExternalUrl("#top")).toBe(false);
    expect(isExternalUrl("mailto:a@b")).toBe(false);
  });
});

describe("schema", () => {
  it("allows no event handlers, style or class globally, and no id or name", () => {
    const global = (SANITIZE_SCHEMA.attributes?.["*"] ?? []).map((a) =>
      typeof a === "string" ? a : a[0],
    );
    expect(global.sort()).toEqual(["align", "dir", "lang", "title"]);
  });

  it("restricts URL protocols", () => {
    expect(SANITIZE_SCHEMA.protocols).toEqual({
      href: ["http", "https", "mailto"],
      src: ["http", "https"],
      cite: ["http", "https"],
    });
  });

  it("does not allow foreign, embedding or form elements", () => {
    for (const tag of ["svg", "math", "iframe", "object", "embed", "form", "style", "script"]) {
      expect(SANITIZE_SCHEMA.tagNames).not.toContain(tag);
      expect(SANITIZE_SCHEMA.strip).toContain(tag);
    }
    expect(SANITIZE_SCHEMA.tagNames).not.toContain("picture");
    expect(SANITIZE_SCHEMA.tagNames).not.toContain("source");
  });
});

describe("legitimate content survives", () => {
  it("tables with alignment", async () => {
    const out = await html("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n");
    expect(out).toContain('<th align="left">a</th>');
    expect(out).toContain('<th align="center">b</th>');
    expect(out).toContain('<td align="right">3</td>');
  });

  it("task lists, as disabled checkboxes", async () => {
    const out = await html("- [x] done\n- [ ] todo\n");
    expect(out).toContain('<ul class="contains-task-list">');
    expect(out).toContain('<input type="checkbox" checked disabled> done');
    expect(out).toContain('<input type="checkbox" disabled> todo');
  });

  it("footnotes with back-links", async () => {
    const out = await html("Text[^note].\n\n[^note]: The note.\n");
    expect(out).toContain(
      '<a href="#user-content-fn-note" id="user-content-fnref-note" data-footnote-ref aria-describedby="footnote-label">1</a>',
    );
    expect(out).toContain('<section data-footnotes class="footnotes">');
    expect(out).toContain('<h2 class="sr-only" id="footnote-label">Footnotes</h2>');
    expect(out).toContain('<li id="user-content-fn-note">');
    expect(out).toContain(
      '<a href="#user-content-fnref-note" data-footnote-backref="" aria-label="Back to reference 1" class="data-footnote-backref">',
    );
  });

  it("code blocks with a language class, and HTML inside code as text", async () => {
    const out = await html("```ts\nconst a = '<script>alert(1)</script>';\n```\n");
    expect(out).toBe(
      "<pre><code class=\"language-ts\">const a = '&#x3C;script>alert(1)&#x3C;/script>';\n</code></pre>",
    );
  });

  it("odd but harmless language names keep or lose only the class", async () => {
    expect(await html("```c++\nx\n```\n")).toContain('class="language-c++"');
    expect(await html("```{.py}\nx\n```\n")).toBe("<pre><code>x\n</code></pre>");
  });

  it("inline code containing a script tag is text", async () => {
    expect(await html("Use `<script>alert(1)</script>` carefully.")).toBe(
      "<p>Use <code>&#x3C;script>alert(1)&#x3C;/script></code> carefully.</p>",
    );
  });

  it("heading anchors", async () => {
    expect(await html("## Getting Started\n")).toBe(
      '<h2 id="getting-started">Getting Started<a class="heading-anchor" href="#getting-started" aria-label="Link to section: Getting Started"></a></h2>',
    );
    expect(await html("## Über uns\n")).toContain('id="über-uns"');
  });

  it("images with relative and https sources", async () => {
    expect(await html("![Arch](./img/arch.png)")).toBe(
      '<p><img src="./img/arch.png" alt="Arch" loading="lazy"></p>',
    );
    expect(await html('![Logo](https://example.com/l.png "The logo")')).toBe(
      '<p><img src="https://example.com/l.png" alt="Logo" title="The logo" loading="lazy" referrerpolicy="no-referrer"></p>',
    );
    expect(await html('<img src="a.png" width="120" height="50%" align="right" alt="x">')).toBe(
      '<img src="a.png" width="120" height="50%" align="right" alt="x" loading="lazy">',
    );
  });

  it("safe links: https, mailto, relative, fragment", async () => {
    expect(await html("[a](https://example.com)")).toBe(
      '<p><a href="https://example.com" rel="nofollow noopener noreferrer">a</a></p>',
    );
    expect(await html("[a](mailto:me@example.com)")).toBe(
      '<p><a href="mailto:me@example.com">a</a></p>',
    );
    expect(await html("[a](../guide/setup.md)")).toBe('<p><a href="../guide/setup.md">a</a></p>');
    expect(await html("[a](#install)")).toBe('<p><a href="#install">a</a></p>');
    expect(await html('[a](https://example.com "Say \\"hi\\"")')).toBe(
      '<p><a href="https://example.com" title="Say &#x22;hi&#x22;" rel="nofollow noopener noreferrer">a</a></p>',
    );
  });

  it("protocol-relative links count as external", async () => {
    expect(await html('<a href="//evil.example/x">x</a>')).toBe(
      '<p><a href="//evil.example/x" rel="nofollow noopener noreferrer">x</a></p>',
    );
  });

  it("details, summary, kbd, sub, sup, strikethrough", async () => {
    const out = await html(
      "<details open><summary>More</summary>\n\nPress <kbd>Ctrl</kbd>+<kbd>C</kbd>, H<sub>2</sub>O, x<sup>2</sup>, ~~old~~.\n\n</details>\n",
    );
    expect(out).toContain("<details open><summary>More</summary>");
    expect(out).toContain("<kbd>Ctrl</kbd>+<kbd>C</kbd>");
    expect(out).toContain("H<sub>2</sub>O");
    expect(out).toContain("x<sup>2</sup>");
    expect(out).toContain("<del>old</del>");
  });

  it("centered README headers", async () => {
    expect(await html('<p align="center">Hi</p>\n')).toBe('<p align="center">Hi</p>');
    expect(await html('<div align="center" dir="rtl" lang="ar">x</div>\n')).toBe(
      '<div align="center" dir="rtl" lang="ar">x</div>',
    );
  });

  it("unwraps unknown elements and keeps their text", async () => {
    expect(await html("<mark>hi</mark> <u>there</u> <custom-el>x</custom-el>")).toBe(
      "<p>hi there x</p>",
    );
    expect(
      await html('<picture><source srcset="dark.png" media="x"><img src="a.png"></picture>'),
    ).toBe('<p><img src="a.png" loading="lazy"></p>');
  });
});

describe("Shiki-shaped output (contract for 7.3)", () => {
  const shikiPre = element(
    "pre",
    {
      className: ["shiki", "shiki-themes", "github-light", "github-dark"],
      style: "background-color:#fff;--shiki-dark-bg:#24292e;color:#24292e;--shiki-dark:#e1e4e8",
      tabIndex: 0,
    },
    [
      element("code", {}, [
        element("span", { className: ["line"] }, [
          element("span", { style: "color:#D73A49;--shiki-dark:#F97583" }, [
            { type: "text", value: "const" },
          ]),
          element("span", { style: "color:#24292E;background:url(x);--shiki-dark:#E1E4E8" }, [
            { type: "text", value: " a" },
          ]),
        ]),
      ]),
    ],
  );

  it("keeps classes, tabindex and filtered styles", async () => {
    const out = await html("x\n", { highlight: [inject(shikiPre)] });
    expect(out).toContain(
      '<pre class="shiki shiki-themes" style="background-color:#fff;--shiki-dark-bg:#24292e;color:#24292e;--shiki-dark:#e1e4e8" tabindex="0"><code><span class="line"><span style="color:#D73A49;--shiki-dark:#F97583">const</span><span style="color:#24292E;--shiki-dark:#E1E4E8"> a</span></span></code></pre>',
    );
  });

  it("does not allow style or class on other elements, or other classes", async () => {
    const out = await html(
      '<div style="color:#fff" class="fixed inset-0">a</div><p class="line">b</p><span class="fixed">c</span>\n',
    );
    expect(out).toBe("<div>a</div><p>b</p><span>c</span>");
  });
});

describe("ids and DOM clobbering", () => {
  it("renames heading slugs that are sensitive DOM names, and their anchor links", async () => {
    const out = await html("## Cookie\n\nSee [the cookie](#cookie).\n\n## Constructor\n");
    expect(out).toContain(
      '<h2 id="user-content-cookie">Cookie<a class="heading-anchor" href="#user-content-cookie"',
    );
    expect(out).toContain('<a href="#user-content-cookie">the cookie</a>');
    expect(out).toContain('<h2 id="user-content-constructor">');
    expect(anchorId("cookie")).toBe("user-content-cookie");
    expect(anchorId("getting-started")).toBe("getting-started");
  });

  it("keeps the stored slugs in the returned headings", async () => {
    const result = await renderMarkdown("## Cookie\n");
    expect(result.headings).toEqual([{ depth: 2, text: "Cookie", slug: "cookie" }]);
  });

  it.each([
    ['<h1 id="__proto__">x</h1>', '<h1 id="user-content-__proto__">x</h1>'],
    ['<h2 id="__next_f">x</h2>', '<h2 id="user-content-__next_f">x</h2>'],
    ['<h2 id="Location">x</h2>', '<h2 id="user-content-Location">x</h2>'],
    ['<h2 id="x y">x</h2>', "<h2>x</h2>"],
    ['<h2 id="a&quot;b">x</h2>', "<h2>x</h2>"],
    ['<h2 id="a.b">x</h2>', "<h2>x</h2>"],
    ['<a id="cookie" href="#x">x</a>', '<p><a href="#x">x</a></p>'],
    ['<img name="getElementById" src="a.png">', '<img src="a.png" loading="lazy">'],
    ['<img id="x" src="a.png">', '<img src="a.png" loading="lazy">'],
    ['<p id="footnote-label">x</p>', "<p>x</p>"],
    ['<span id="user-content-fn-1">x</span>', "<p><span>x</span></p>"],
  ])("%s", async (input, expected) => {
    expect(await html(`${input}\n`)).toBe(expected);
  });
});

describe("order: the sanitizer runs after every slot", () => {
  const evil = () => [
    element("script", {}, [{ type: "text", value: "alert(1)" }]),
    element("img", { src: "x", onError: "alert(1)", srcSet: "javascript:alert(1)" }),
    element("a", { href: "javascript:alert(1)", target: "_blank", rel: ["opener"] }, [
      { type: "text", value: "x" },
    ]),
    element("iframe", { srcDoc: "<script>alert(1)</script>" }),
    element("div", { style: "background:url(javascript:alert(1))", className: ["fixed"] }),
    element("h2", { id: "__proto__" }, [{ type: "text", value: "h" }]),
  ];

  it.each(["linkRewrite", "highlight", "mermaid"] as const)(
    "removes what the %s slot injects",
    async (slot) => {
      const out = await html("text\n", { [slot]: [inject(...evil())] });
      expect(out).toBe(
        '<p>text</p><img src="x" loading="lazy"><a>x</a><div></div><h2 id="user-content-__proto__">h</h2>',
      );
    },
  );

  it("removes raw HTML nodes a slot adds after rehype-raw", async () => {
    const raw = () => (tree: Root) => {
      (tree.children as unknown[]).push({ type: "raw", value: "<script>alert(1)</script>" });
    };
    expect(await html("text\n", { mermaid: [raw] })).toBe("<p>text</p>");
  });

  it("removes what an afterParse plugin smuggles through mdast hProperties", async () => {
    const plugin = () => (tree: { children: { data?: Record<string, unknown> }[] }) => {
      const first = tree.children[0];
      if (first) first.data = { hName: "script", hChildren: [{ type: "text", value: "x" }] };
    };
    expect(await html("text\n", { afterParse: [plugin] })).toBe("");
  });

  it("puts the sanitizer last, and the processor cannot be extended after it", () => {
    const processor = createProcessor();
    const plugins = processor.attachers.map(([plugin]) => plugin);
    expect(plugins.findIndex((plugin) => (plugin as unknown) === rehypeSafeHtml)).toBe(
      plugins.length - 2,
    );
    expect(() => processor.use(() => undefined)).toThrow(/frozen/);
  });
});

describe("assertSafeHtml oracle", () => {
  it("accepts safe output and flags unsafe HTML", () => {
    expect(findUnsafeHtml("<p>hi</p>")).toEqual([]);
    expect(findUnsafeHtml('<img src="x" onerror="alert(1)">')).toContain(
      "event handler onError on <img>",
    );
    expect(findUnsafeHtml('<a href="javascript:alert(1)">x</a>')).toContain(
      "scheme javascript: in href on <a>",
    );
    expect(findUnsafeHtml("<script>alert(1)</script>")).toContain("forbidden element <script>");
    expect(findUnsafeHtml('<a href="https://x">x</a>')).toContain(
      "external link without rel=noopener noreferrer",
    );
    expect(findUnsafeHtml('<span style="position:fixed">x</span>')).toContain(
      "style position:fixed",
    );
    expect(findUnsafeHtml('<h2 id="cookie">x</h2>')).toContain("sensitive id cookie");
    expect(findUnsafeHtml("<p>a<!-- x --></p>")).toContain("comment");
  });
});
