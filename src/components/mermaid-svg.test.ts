// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { MAX_SVG_LENGTH, MermaidSvgError, sanitizeMermaidSvg } from "./mermaid-svg";

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${inner}</svg>`;

function parse(svg: string): Element {
  const root = new DOMParser().parseFromString(sanitizeMermaidSvg(svg), "text/html").body
    .firstElementChild;
  if (root === null) throw new Error("no root");
  return root;
}

function externalRefs(out: string): boolean {
  return /https?:\/\/(?!www\.w3\.org)|\/\/example|javascript:|<img|foreignobject|<image|onload|onclick|onerror/i.test(
    out,
  );
}

describe("sanitizeMermaidSvg", () => {
  it("passes benign SVG through with its text and shapes", () => {
    const out = parse(
      wrap(
        `<g class="node"><rect x="1" y="2" width="30" height="10" fill="url(#g1)"/><text><tspan>Hello</tspan></text></g><defs><linearGradient id="g1"><stop offset="0"/></linearGradient></defs><path d="M0 0L5 5" marker-end="url(#arrow)"/><style>#m .a{fill:#fff;stroke:url(#g1)}</style>`,
      ),
    );
    expect(out.querySelector("rect")?.getAttribute("fill")).toBe("url(#g1)");
    expect(out.querySelector("tspan")?.textContent).toBe("Hello");
    expect(out.querySelector("linearGradient")).not.toBeNull();
    expect(out.querySelector("path")?.getAttribute("marker-end")).toBe("url(#arrow)");
    expect(out.querySelector("style")?.textContent).toContain("fill:#fff");
  });

  it("keeps a use that points at a fragment", () => {
    const out = parse(wrap(`<symbol id="s"><circle r="1"/></symbol><use href="#s"/>`));
    expect(out.querySelector("use")?.getAttribute("href")).toBe("#s");
  });

  it.each([
    [
      "img inside foreignObject",
      wrap(`<foreignObject><div><img src="https://example.invalid/x.png"></div></foreignObject>`),
    ],
    ["svg image href", wrap(`<image href="https://example.invalid/x.png"/>`)],
    ["svg image xlink:href", wrap(`<image xlink:href="https://example.invalid/x.png"/>`)],
    ["img directly", wrap(`<img src="https://example.invalid/x.png">`)],
    ["use external", wrap(`<use href="https://example.invalid/a.svg#x"/>`)],
    ["use xlink external", wrap(`<use xlink:href="//example.invalid/a.svg#x"/>`)],
    ["style url", wrap(`<style>.a{fill:url(https://example.invalid/x)}</style>`)],
    ["style @import", wrap(`<style>@import url("https://example.invalid/x.css");</style>`)],
    ["style @import bare", wrap(`<style>@import "https://example.invalid/x.css";</style>`)],
    ["style escaped url", wrap(`<style>.a{background:\\75rl(https://example.invalid/x)}</style>`)],
    [
      "style image-set",
      wrap(`<style>.a{background:image-set("https://example.invalid/x" 1x)}</style>`),
    ],
    ["style attribute url", wrap(`<rect style="fill:url('https://example.invalid/x')"/>`)],
    ["presentation attribute url", wrap(`<rect filter="url(https://example.invalid/f.svg#a)"/>`)],
    ["onload", wrap(`<g onload="alert(1)"/>`)],
    ["onclick", wrap(`<rect onclick="alert(1)"/>`)],
    ["script", wrap(`<script>fetch("https://example.invalid")</script>`)],
    [
      "nested foreignObject with script",
      wrap(
        `<foreignObject><foreignObject><script>alert(1)</script></foreignObject></foreignObject>`,
      ),
    ],
    [
      "animate href",
      wrap(`<a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a>`),
    ],
    ["javascript href", wrap(`<a href="javascript:alert(1)"><text>x</text></a>`)],
    ["obfuscated javascript href", wrap(`<a href=" jav&#x09;ascript:alert(1)"><text>x</text></a>`)],
    [
      "iframe/object/embed/video",
      wrap(
        `<iframe src="https://example.invalid"></iframe><object data="https://example.invalid"></object><embed src="https://example.invalid"><video src="https://example.invalid"></video><audio src="https://example.invalid"></audio><link href="https://example.invalid">`,
      ),
    ],
    ["entity trick", wrap(`<image href="&#104;ttps://example.invalid/x.png"/>`)],
    ["style breakout", wrap(`<style></style><img src=x onerror=alert(1)><style></style>`)],
    ["html breakout", `<svg><p><img src="https://example.invalid/x"></p></svg>`],
  ])("removes %s", (_name, input) => {
    const out = sanitizeMermaidSvg(input);
    expect(externalRefs(out), out).toBe(false);
    const dom = parse(input);
    expect(
      dom.querySelectorAll(
        "img,image,foreignObject,iframe,object,embed,video,audio,source,link,script,animate,set",
      ),
    ).toHaveLength(0);
  });

  it("keeps anchors with http(s) links and drops others", () => {
    const out = parse(
      wrap(
        `<a href="https://example.com/a"><text>a</text></a><a href="data:text/html,x"><text>b</text></a>`,
      ),
    );
    const anchors = out.querySelectorAll("a");
    expect(anchors[0]?.getAttribute("href")).toBe("https://example.com/a");
    expect(anchors[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchors[1]?.hasAttribute("href")).toBe(false);
  });

  it("drops text and siblings around the root", () => {
    expect(sanitizeMermaidSvg(`hello <svg><text>a</text></svg><img src=x>`)).not.toContain("img");
  });

  it("throws a fixed error for non-svg, empty and oversized input", () => {
    for (const bad of ["", "<div>x</div>", "<<<>>>", "not svg at all"]) {
      expect(() => sanitizeMermaidSvg(bad)).toThrow(MermaidSvgError);
    }
    expect(() => sanitizeMermaidSvg(`<svg>${"a".repeat(MAX_SVG_LENGTH)}</svg>`)).toThrow(
      "The diagram could not be rendered safely.",
    );
  });

  it("survives malformed markup", () => {
    const out = sanitizeMermaidSvg(
      `<svg><g><text>a<rect</g><foreignObject><img src="https://e.invalid"`,
    );
    expect(out.startsWith("<svg")).toBe(true);
    expect(out).not.toContain("img");
  });

  it("fails closed or succeeds on very deep nesting, never with a raw error", () => {
    const input = `<svg>${"<g>".repeat(5000)}<text>x</text><img src="https://e.invalid"></svg>`;
    try {
      expect(sanitizeMermaidSvg(input)).not.toContain("<img");
    } catch (error) {
      expect(error).toBeInstanceOf(MermaidSvgError);
    }
  });

  it("is idempotent", () => {
    const once = sanitizeMermaidSvg(wrap(`<g><text>x</text></g><image href="https://e.invalid"/>`));
    expect(sanitizeMermaidSvg(once)).toBe(once);
  });
});
