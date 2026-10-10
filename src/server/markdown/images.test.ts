import { describe, expect, it } from "vitest";

import { assetUrl } from "../../lib/routes";
import { parseAssetTarget, rawAssetSegments } from "../assets/path";
import { assertSafeHtml } from "./assert-safe-html";
import { resolveImage, type ImageResolution } from "./images";
import type { LinkContext } from "./links";
import { renderMarkdown } from "./pipeline";

function ctx(overrides: Partial<LinkContext> = {}): LinkContext {
  return {
    owner: "acme",
    repo: "portal",
    defaultBranch: "main",
    docsFolder: "docs",
    path: "docs/guides/setup.md",
    docPaths: new Set(["docs/guides/setup.md", "docs/index.md"]),
    ...overrides,
  };
}

function asset(src: string, overrides: Partial<LinkContext> = {}): string {
  const result = resolveImage(src, ctx(overrides));
  if (result.kind !== "asset") {
    throw new Error(`expected asset for ${src}, got ${JSON.stringify(result)}`);
  }
  return result.src;
}

function reason(src: string, overrides: Partial<LinkContext> = {}): string | null {
  const result: ImageResolution = resolveImage(src, ctx(overrides));
  return result.kind === "broken" ? result.reason : null;
}

describe("resolveImage: repository images", () => {
  it("resolves relative paths against the document's folder", () => {
    expect(asset("./img/arch.png")).toBe("/api/asset/acme/portal/docs/guides/img/arch.png");
    expect(asset("img/arch.png")).toBe("/api/asset/acme/portal/docs/guides/img/arch.png");
    expect(asset("../a.png")).toBe("/api/asset/acme/portal/docs/a.png");
    expect(asset("../../logo.svg")).toBe("/api/asset/acme/portal/logo.svg");
    expect(asset("./x/../y/./z.gif")).toBe("/api/asset/acme/portal/docs/guides/y/z.gif");
  });

  it("resolves the spec scenario: ./img/arch.png in a private repo document", () => {
    expect(asset("./img/arch.png", { path: "docs/index.md" })).toBe(
      "/api/asset/acme/portal/docs/img/arch.png",
    );
  });

  it("resolves /-rooted paths against the docs root", () => {
    expect(asset("/img/a.png")).toBe("/api/asset/acme/portal/docs/img/a.png");
    expect(asset("/guides/../img/a.png")).toBe("/api/asset/acme/portal/docs/img/a.png");
  });

  it("falls back to the repository root for GitHub-style /docs/... paths", () => {
    expect(asset("/docs/img/a.png")).toBe("/api/asset/acme/portal/docs/img/a.png");
    expect(
      asset("/docs/img/a.png", { docsFolder: "handbook/docs", path: "handbook/docs/x.md" }),
    ).toBe("/api/asset/acme/portal/handbook/docs/docs/img/a.png");
    expect(
      asset("/handbook/docs/img/a.png", {
        docsFolder: "handbook/docs",
        path: "handbook/docs/x.md",
      }),
    ).toBe("/api/asset/acme/portal/handbook/docs/img/a.png");
  });

  it("resolves /-rooted paths in the README, or without a docs folder, against the repo root", () => {
    expect(asset("/img/logo.png", { path: "README.md" })).toBe(
      "/api/asset/acme/portal/img/logo.png",
    );
    expect(asset("./.github/logo.png", { path: "README.md" })).toBe(
      "/api/asset/acme/portal/.github/logo.png",
    );
    expect(asset("/img/a.png", { docsFolder: null, path: "notes/a.md" })).toBe(
      "/api/asset/acme/portal/img/a.png",
    );
  });

  it("decodes once and re-encodes each segment", () => {
    expect(asset("./my%20diagram.png")).toBe("/api/asset/acme/portal/docs/guides/my%20diagram.png");
    expect(asset("./my diagram.png")).toBe("/api/asset/acme/portal/docs/guides/my%20diagram.png");
    expect(asset("./caf%C3%A9.png")).toBe("/api/asset/acme/portal/docs/guides/caf%C3%A9.png");
    expect(asset("./a%23b.png")).toBe("/api/asset/acme/portal/docs/guides/a%23b.png");
    expect(asset("./%2e%2e/a.png")).toBe("/api/asset/acme/portal/docs/a.png");
    expect(asset("./A.PNG")).toBe("/api/asset/acme/portal/docs/guides/A.PNG");
  });

  it("drops the query and fragment", () => {
    expect(asset("./logo.png?raw=true")).toBe("/api/asset/acme/portal/docs/guides/logo.png");
    expect(asset("./logo.png#dark")).toBe("/api/asset/acme/portal/docs/guides/logo.png");
  });

  it("encodes owner and repo", () => {
    expect(asset("a.png", { owner: "Acme", repo: "my.repo" })).toBe(
      "/api/asset/Acme/my.repo/docs/guides/a.png",
    );
  });

  it("produces URLs the proxy accepts as the same path", () => {
    for (const src of ["./my diagram.png", "../a%20b/c.png", "/x/%C3%BC.svg", "./a%23b.png"]) {
      const url = asset(src);
      const segments = rawAssetSegments(new URL(url, "http://h").pathname);
      const target = segments && parseAssetTarget(segments);
      expect(target?.path, src).toBe(
        decodeURIComponent(url.slice("/api/asset/acme/portal/".length)),
      );
    }
  });
});

describe("resolveImage: left untouched", () => {
  it.each([
    "https://example.com/a.png",
    "http://example.com/a.png",
    "HTTPS://example.com/a.png",
    "//cdn.example.com/a.png",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "ftp://example.com/a.png",
    "",
    "   ",
  ])("%j", (src) => {
    expect(resolveImage(src, ctx())).toEqual({ kind: "untouched" });
  });
});

describe("resolveImage: broken", () => {
  it.each<[string, string]>([
    ["../../../a.png", "outside_root"],
    ["/../a.png", "outside_root"],
    ["%2e%2e/%2e%2e/%2e%2e/a.png", "outside_root"],
    ["./a\\b.png", "invalid"],
    ["..\\..\\a.png", "invalid"],
    ["./a%5cb.png", "invalid"],
    ["./a%2fb.png", "invalid"],
    ["./a%2Fb.png", "invalid"],
    ["./a%00.png", "invalid"],
    ["./a\u0000.png", "invalid"],
    ["./a\n.png", "invalid"],
    ["./a%0a.png", "invalid"],
    ["./a%zz.png", "invalid"],
    ["./a%252e.png", "invalid"],
    ["./%252e%252e/a.png", "invalid"],
    ["./%ef%bc%8e%ef%bc%8e/a.png", "invalid"],
    ["./.git/a.png", "invalid"],
    ["./.../a.png", "invalid"],
    ["./a%e2%80%aegnp.svg", "invalid"],
    ["./img/", "not_a_file"],
    [".", "not_a_file"],
    ["..", "not_a_file"],
    ["?x=1", "not_a_file"],
    ["#frag", "not_a_file"],
    ["./doc.md", "not_an_image"],
    ["./page.html", "not_an_image"],
    ["./script.js", "not_an_image"],
    ["./noext", "not_an_image"],
    ["./diagram.drawio", "not_an_image"],
    [`./${"a".repeat(2100)}.png`, "too_long"],
    [`./${"a".repeat(1100)}.png`, "too_long"],
  ])("%j is %s", (src, why) => {
    expect(reason(src)).toBe(why);
  });

  it("never throws", () => {
    const weird = ["\ud800.png", "%", "%%%", "/".repeat(5000), "./ .png"];
    for (const src of weird) expect(() => resolveImage(src, ctx())).not.toThrow();
  });
});

describe("renderMarkdown: image rewriting", () => {
  const links = ctx();

  async function html(markdown: string, options: { links?: LinkContext | undefined } = { links }) {
    const out = (await renderMarkdown(markdown, options)).html;
    assertSafeHtml(out);
    return out;
  }

  it("rewrites a Markdown image and keeps it through the sanitizer", async () => {
    const out = await html("![Architecture](./img/arch.png)");
    expect(out).toContain(
      '<img src="/api/asset/acme/portal/docs/guides/img/arch.png" alt="Architecture" loading="lazy">',
    );
    expect(out).not.toContain("referrerpolicy");
  });

  it("rewrites reference-style images", async () => {
    const out = await html("![Logo][logo]\n\n[logo]: ../img/logo.svg 'The logo'");
    expect(out).toContain('src="/api/asset/acme/portal/docs/img/logo.svg"');
    expect(out).toContain('title="The logo"');
  });

  it("rewrites an image inside a link and the link separately", async () => {
    const out = await html("[![shot](./shot.png)](./setup.md)");
    expect(out).toContain('<a href="/acme/portal/docs/guides/setup">');
    expect(out).toContain('src="/api/asset/acme/portal/docs/guides/shot.png"');
  });

  it("rewrites raw HTML images the same way", async () => {
    const out = await html('<p align="center"><img src="./img/a.png" width="200" alt="A"></p>');
    expect(out).toContain('src="/api/asset/acme/portal/docs/guides/img/a.png"');
    expect(out).toContain('width="200"');
  });

  it("leaves external images as written, with no-referrer", async () => {
    const out = await html("![badge](https://img.shields.io/badge/x-y-green.svg)");
    expect(out).toContain('src="https://img.shields.io/badge/x-y-green.svg"');
    expect(out).toContain('referrerpolicy="no-referrer"');
  });

  it("removes data: and javascript: sources (sanitizer)", async () => {
    const out = await html(
      '![x](data:image/png;base64,AAAA)\n\n<img src="javascript:alert(1)" alt="j">\n\n<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="d">',
    );
    expect(out).not.toMatch(/data:|javascript:/i);
    expect(out).toContain('alt="j"');
  });

  it("drops the source of a traversal or non-image and keeps the alt text", async () => {
    const out = await html(
      "![up](../../../../etc/passwd.png) ![slash](./a%2f..%2f..%2fb.png) ![doc](./notes.md)",
    );
    expect(out).toContain('<img alt="up" loading="lazy">');
    expect(out).toContain('<img alt="slash" loading="lazy">');
    expect(out).toContain('<img alt="doc" loading="lazy">');
    expect(out).not.toContain("passwd");
  });

  it("strips srcset so no image bypasses the proxy", async () => {
    const out = await html('<img src="./a.png" srcset="https://evil.example/x.png 2x" alt="a">');
    expect(out).toContain('src="/api/asset/acme/portal/docs/guides/a.png"');
    expect(out).not.toContain("srcset");
    expect(out).not.toContain("evil.example");
  });

  it("only emits root-relative proxy URLs: never a token, host or query", async () => {
    const out = await html("![a](./a.png?token=abc) ![b](/b.png#x) <img src='c.png'>");
    const srcs = [...out.matchAll(/src="([^"]*)"/g)].map((m) => m[1]);
    expect(srcs).toEqual([
      "/api/asset/acme/portal/docs/guides/a.png",
      "/api/asset/acme/portal/docs/b.png",
      "/api/asset/acme/portal/docs/guides/c.png",
    ]);
  });

  it("does nothing without a link context", async () => {
    const out = await html("![a](./img/a.png)", {});
    expect(out).toContain('src="./img/a.png"');
  });

  it("keeps link rewriting working alongside", async () => {
    const out = await html("[setup](./setup.md) ![a](a.png) [gone](./gone.md)");
    expect(out).toContain('href="/acme/portal/docs/guides/setup"');
    expect(out).toContain('class="dmr-broken-link"');
    expect(out).toContain('src="/api/asset/acme/portal/docs/guides/a.png"');
  });

  it("assetUrl refuses dot and empty segments", () => {
    expect(assetUrl("a", "b", "x/../y.png")).toBeNull();
    expect(assetUrl("a", "b", "x//y.png")).toBeNull();
    expect(assetUrl("a", "b", "x/y.png")).toBe("/api/asset/a/b/x/y.png");
  });
});
