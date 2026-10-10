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
    const decoded = inner
      .replaceAll("&#x3C;", "<")
      .replaceAll("&#x26;", "&")
      .replaceAll("&#x3E;", ">");
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
