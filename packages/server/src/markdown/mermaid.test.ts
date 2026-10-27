import { describe, expect, it } from "vitest";

import { assertSafeHtml } from "./assert-safe-html";
import {
  MAX_DIAGRAMS,
  MAX_SOURCE_BYTES,
  WARN_DIAGRAM_TOO_LARGE,
  WARN_TOO_MANY_DIAGRAMS,
} from "./mermaid";
import { renderMarkdown } from "./pipeline";
import { rehypeHighlight } from "./highlight";

async function render(source: string) {
  const result = await renderMarkdown(source);
  assertSafeHtml(result.html);
  return result;
}

const TAGGED = (src: string) =>
  `<pre class="dmr-mermaid"><code class="language-mermaid">${src}</code></pre>`;

describe("rehypeMermaid", () => {
  it("tags a mermaid fence", async () => {
    const { html, warnings } = await render("```mermaid\ngraph TD; A-->B\n```\n");
    expect(html).toBe(TAGGED("graph TD; A-->B\n"));
    expect(warnings).toEqual([]);
  });

  it("matches the language case-insensitively and normalizes the class", async () => {
    const { html } = await render("```Mermaid\ngraph TD\n```\n");
    expect(html).toBe(TAGGED("graph TD\n"));
  });

  it("uses only the first word of the info string", async () => {
    const { html } = await render('```mermaid title="Flow" theme=dark\ngraph TD\n```\n');
    expect(html).toBe(TAGGED("graph TD\n"));
  });

  it("tags ~~~ fences and indented fences", async () => {
    expect((await render("~~~mermaid\ngraph TD\n~~~\n")).html).toBe(TAGGED("graph TD\n"));
    expect((await render("   ```mermaid\n   graph TD\n   ```\n")).html).toBe(TAGGED("graph TD\n"));
  });

  it("tags blocks nested in lists and quotes", async () => {
    const { html } = await render(
      "> ```mermaid\n> graph TD\n> ```\n\n- item\n\n  ```mermaid\n  pie\n  ```\n",
    );
    expect(html.match(/class="dmr-mermaid"/g)).toHaveLength(2);
  });

  it("leaves other fences and indented code alone", async () => {
    const { html } = await render(
      "```ts\nconst a = 1;\n```\n\n```mermaidx\nx\n```\n\n```\nplain\n```\n\n    indented\n",
    );
    expect(html).not.toContain("dmr-mermaid");
    expect(html).toContain('class="language-ts"');
  });

  it("keeps the source exactly: blank lines, unicode and angle brackets as text", async () => {
    const src = 'graph TD\n\n  A["<b>héllo 日本 😀</b> & <script>alert(1)</script>"] --> B\n\n';
    const { html } = await render("```mermaid\n" + src + "```\n");
    expect(html).toContain("&#x3C;script>alert(1)&#x3C;/script>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    const inner = /<code class="language-mermaid">([\s\S]*)<\/code>/.exec(html)?.[1] ?? "";
    // One pass, so a decoded `&` is never decoded again.
    const decoded = inner.replace(
      /&#x(3C|26|3E);/g,
      (_, code: string) => ({ "3C": "<", "26": "&", "3E": ">" })[code]!,
    );
    expect(decoded).toBe(src);
  });

  it("leaves a source over the byte cap as a plain code block, with a warning", async () => {
    const big = "A-->B\n".repeat(Math.ceil(MAX_SOURCE_BYTES / 6) + 1);
    const { html, warnings } = await render("```mermaid\n" + big + "```\n");
    expect(html).not.toContain("dmr-mermaid");
    expect(html).toContain("language-mermaid");
    expect(warnings).toEqual([WARN_DIAGRAM_TOO_LARGE]);
  });

  it("counts the cap in bytes, not characters", async () => {
    const wide = "日".repeat(Math.floor(MAX_SOURCE_BYTES / 3) + 1);
    const { warnings } = await render("```mermaid\n" + wide + "\n```\n");
    expect(warnings).toEqual([WARN_DIAGRAM_TOO_LARGE]);
  });

  it("keeps the first MAX_DIAGRAMS diagrams and warns once for the rest", async () => {
    const doc = Array.from(
      { length: MAX_DIAGRAMS + 3 },
      (_, i) => `\`\`\`mermaid\ngraph TD; N${i}\n\`\`\`\n`,
    ).join("\n");
    const { html, warnings } = await render(doc);
    expect(html.match(/class="dmr-mermaid"/g)).toHaveLength(MAX_DIAGRAMS);
    expect(html.match(/class="language-mermaid"/g)).toHaveLength(MAX_DIAGRAMS + 3);
    expect(warnings).toEqual([WARN_TOO_MANY_DIAGRAMS]);
  });

  it("is independent of the highlight plugin", async () => {
    const src = "```mermaid\ngraph TD\n```\n\n```ts\nconst a = 1;\n```\n";
    const withHighlight = await renderMarkdown(src, { slots: { highlight: [rehypeHighlight] } });
    expect(withHighlight.html).toContain(TAGGED("graph TD\n"));
    expect(withHighlight.html).toContain("shiki");
  });
});

describe("sanitizer and Mermaid blocks", () => {
  it("keeps the class but strips event handlers and extra attributes", async () => {
    const { html } = await render(
      '<pre class="dmr-mermaid" onclick="alert(1)" style="position:fixed" id="x"><code class="language-mermaid" onmouseover="alert(1)">graph TD</code></pre>',
    );
    expect(html).toContain('<pre class="dmr-mermaid">');
    expect(html).not.toMatch(/onclick|onmouseover|position|id=/);
  });

  it("drops an inline svg an author puts next to a diagram", async () => {
    const { html } = await render(
      '```mermaid\ngraph TD\n```\n\n<svg onload="alert(1)"><script>alert(1)</script></svg>\n',
    );
    expect(html).not.toContain("<svg");
    expect(html).toContain("dmr-mermaid");
  });
});

describe("dmr-mermaid cap holds end to end", () => {
  const RAW = (src = "graph TD;A-->B") =>
    `<pre class="dmr-mermaid"><code class="language-mermaid">${src}</code></pre>`;
  const FENCE = (i: number) => "```mermaid\ngraph TD; N" + i + "\n```\n";
  const count = (html: string) => (html.match(/dmr-mermaid/g) ?? []).length;

  async function check(doc: string, expectedMax = MAX_DIAGRAMS) {
    const { html, warnings } = await render(doc);
    expect(count(html)).toBeLessThanOrEqual(expectedMax);
    // Every survivor has the exact plugin shape and is the only form of the class.
    expect(html.match(/class="dmr-mermaid"/g)?.length ?? 0).toBe(count(html));
    for (const m of html.matchAll(/<pre class="dmr-mermaid">/g)) {
      expect(html.slice((m.index ?? 0) + m[0].length)).toMatch(/^<code class="language-mermaid">/);
    }
    return { html, warnings };
  }

  it("caps 100 raw-HTML markers and warns", async () => {
    const { html, warnings } = await check((RAW() + "\n\n").repeat(100));
    expect(count(html)).toBe(MAX_DIAGRAMS);
    expect(warnings).toContain(WARN_TOO_MANY_DIAGRAMS);
  });

  it("caps mixed fences and raw HTML adding up past the limit", async () => {
    const doc = Array.from({ length: 15 }, (_, i) => FENCE(i) + "\n" + RAW() + "\n").join("\n");
    const { html, warnings } = await check(doc);
    expect(count(html)).toBe(MAX_DIAGRAMS);
    expect(warnings).toEqual([WARN_TOO_MANY_DIAGRAMS]);
  });

  it("does not let a nested pre smuggle a marker", async () => {
    const nested = `<pre><span>x</span>${RAW()}</pre>\n\n`;
    const { html } = await check(nested.repeat(100), 0);
    expect(count(html)).toBeLessThanOrEqual(MAX_DIAGRAMS);
    const deep = `<pre><pre><pre class="dmr-mermaid"><code class="language-mermaid">a</code></pre></pre></pre>`;
    expect(count((await check(deep.repeat(50))).html)).toBeLessThanOrEqual(MAX_DIAGRAMS);
  });

  it("caps markers inside blockquotes, lists, tables, details and footnotes", async () => {
    const parts = [
      `> ${RAW()}\n`,
      `- item\n\n  ${RAW()}\n`,
      `<table><tr><td>${RAW()}</td></tr></table>\n`,
      `<details><summary>s</summary>${RAW()}</details>\n`,
      `text[^1]\n\n[^1]: note\n\n    ${RAW()}\n`,
    ];
    const doc = Array.from({ length: 40 }, (_, i) => parts[i % parts.length]).join("\n");
    await check(doc);
  });

  it("leaves a raw-HTML diagram over the byte cap as plain code", async () => {
    const big = "A-->B\n".repeat(Math.ceil(MAX_SOURCE_BYTES / 6) + 1);
    const { html, warnings } = await check(RAW(big), 0);
    expect(count(html)).toBe(0);
    expect(html).toContain("language-mermaid");
    expect(warnings).toEqual([WARN_DIAGRAM_TOO_LARGE]);
  });

  it("drops odd class spellings", async () => {
    const odd = [
      `<pre class="DMR-Mermaid"><code class="language-mermaid">a</code></pre>`,
      `<pre class="foo dmr-mermaid"><code class="language-mermaid">a</code></pre>`,
      `<pre class="dmr-mermaid foo"><code>a</code></pre>`,
      `<pre class="dmr-mermaid"><code>a</code><code>b</code></pre>`,
      `<pre class="mermaid"><code class="language-mermaid">a</code></pre>`,
    ].join("\n\n");
    const { html } = await check(odd.repeat(1));
    expect(html).not.toMatch(/class="[^"]*foo[^"]*dmr|dmr-mermaid foo/);
    // Only the well-formed marker shapes (normalized by the plugin) can survive.
    expect(count(html)).toBeLessThanOrEqual(MAX_DIAGRAMS);
    const bad = await check(`<pre class="dmr-mermaid"><code>a</code><code>b</code></pre>`, 0);
    expect(count(bad.html)).toBe(0);
  });

  it("still tags fences within the caps next to hostile raw HTML", async () => {
    const { html } = await check(FENCE(1) + "\n" + RAW("x") + "\n");
    expect(count(html)).toBe(2);
  });
});
