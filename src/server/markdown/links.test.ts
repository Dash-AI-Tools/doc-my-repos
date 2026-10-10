import { describe, expect, it } from "vitest";

import { docPathCandidates, docRouteStem, docUrl } from "../../lib/routes";
import { assertSafeHtml } from "./assert-safe-html";
import {
  brokenLinkTitle,
  createLinkResolver,
  type LinkContext,
  MAX_BROKEN_TITLE_CHARS,
  MAX_HREF_CHARS,
  resolveLink,
} from "./links";
import { renderMarkdown } from "./pipeline";

const DOCS = [
  "docs/index.md",
  "docs/guides/index.md",
  "docs/guides/setup.md",
  "docs/guides/advanced/tuning.mdx",
  "docs/concepts/auth.md",
  "docs/tables/orders.md",
  "docs/api/README.md",
  "docs/Mixed/Case.md",
  "docs/dup/a.md",
  "docs/dup/A.md",
  "docs/with space/my doc.md",
  "docs/caf\u00e9/\u00fcber.md",
  "docs/UPPER.MD",
];

function ctx(overrides: Partial<LinkContext> = {}): LinkContext {
  return {
    owner: "acme",
    repo: "portal",
    defaultBranch: "main",
    docsFolder: "docs",
    path: "docs/guides/setup.md",
    docPaths: new Set(DOCS),
    ...overrides,
  };
}

function doc(href: string, overrides: Partial<LinkContext> = {}): string {
  const result = resolveLink(href, ctx(overrides));
  if (result.kind !== "doc")
    throw new Error(`expected doc for ${href}, got ${JSON.stringify(result)}`);
  return result.href;
}

function github(href: string, overrides: Partial<LinkContext> = {}): string {
  const result = resolveLink(href, ctx(overrides));
  if (result.kind !== "github") {
    throw new Error(`expected github for ${href}, got ${JSON.stringify(result)}`);
  }
  return result.href;
}

function brokenReason(href: string, overrides: Partial<LinkContext> = {}): string {
  const result = resolveLink(href, ctx(overrides));
  if (result.kind !== "broken") {
    throw new Error(`expected broken for ${href}, got ${JSON.stringify(result)}`);
  }
  return result.reason;
}

describe("routes", () => {
  it("builds one URL per document", () => {
    expect(docUrl("acme", "portal", "docs/guides/setup.md", "docs")).toBe(
      "/acme/portal/docs/guides/setup",
    );
    expect(docUrl("acme", "portal", "documentation/a/b.mdx", "documentation")).toBe(
      "/acme/portal/docs/a/b",
    );
    expect(docUrl("acme", "portal", "docs/guides/index.md", "docs")).toBe(
      "/acme/portal/docs/guides/index",
    );
    expect(docUrl("acme", "portal", "docs/UPPER.MD", "docs")).toBe("/acme/portal/docs/UPPER");
  });

  it("encodes every segment and keeps case", () => {
    expect(docUrl("a b", "r?", "docs/with space/my doc.md", "docs")).toBe(
      "/a%20b/r%3F/docs/with%20space/my%20doc",
    );
    expect(docUrl("acme", "portal", "docs/Mixed/Case.md", "docs")).toBe(
      "/acme/portal/docs/Mixed/Case",
    );
    expect(docUrl("acme", "portal", "docs/caf\u00e9/\u00fcber.md", "docs")).toBe(
      "/acme/portal/docs/caf%C3%A9/%C3%BCber",
    );
  });

  it("returns null for anything without a page", () => {
    expect(docUrl("o", "r", "README.md", "docs")).toBeNull();
    expect(docUrl("o", "r", "docs/img.png", "docs")).toBeNull();
    expect(docUrl("o", "r", "docs/.md", "docs")).toBeNull();
    expect(docUrl("o", "r", "docs/a/../b.md", "docs")).toBeNull();
    expect(docUrl("o", "r", "docsx/a.md", "docs")).toBeNull();
    expect(docUrl("o", "r", "docs/a.md", null)).toBeNull();
    expect(docUrl("o", "r", "docs/a.md", "")).toBeNull();
    expect(docRouteStem("docs/a//b.md", "docs")).toBeNull();
  });

  it("maps route segments back to stored paths", () => {
    expect(docPathCandidates("docs", ["guides", "setup"])).toEqual([
      "docs/guides/setup.md",
      "docs/guides/setup.mdx",
    ]);
    expect(docPathCandidates("docs", ["with space", "my doc"])).toEqual([
      "docs/with space/my doc.md",
      "docs/with space/my doc.mdx",
    ]);
  });

  it("rejects route segments that could leave the docs folder", () => {
    expect(docPathCandidates("docs", [])).toEqual([]);
    expect(docPathCandidates("docs", [".."])).toEqual([]);
    expect(docPathCandidates("docs", ["a", "..", "b"])).toEqual([]);
    expect(docPathCandidates("docs", ["a/b"])).toEqual([]);
    expect(docPathCandidates("docs", ["a\\b"])).toEqual([]);
    expect(docPathCandidates("docs", ["a\u0000"])).toEqual([]);
    expect(docPathCandidates(null, ["a"])).toEqual([]);
  });

  it("round trips every synced document", () => {
    for (const path of DOCS) {
      const url = docUrl("acme", "portal", path, "docs");
      expect(url).not.toBeNull();
      const segments = (url ?? "")
        .split("/")
        .slice(4)
        .map((s) => decodeURIComponent(s));
      const candidates = docPathCandidates("docs", segments);
      expect(candidates.some((c) => c.toLowerCase() === path.toLowerCase())).toBe(true);
    }
  });
});

describe("resolveLink: documents", () => {
  it("resolves a relative link to another doc (spec: ../concepts/auth.md)", () => {
    expect(doc("../concepts/auth.md")).toBe("/acme/portal/docs/concepts/auth");
  });

  it("resolves a bundle-root-absolute link against the docs root (spec: /tables/orders.md)", () => {
    expect(doc("/tables/orders.md")).toBe("/acme/portal/docs/tables/orders");
    expect(doc("/tables/orders.md", { path: "docs/deep/er/x.md" })).toBe(
      "/acme/portal/docs/tables/orders",
    );
  });

  it("resolves a bundle-root-absolute link from outside the docs tree (the README)", () => {
    expect(doc("/concepts/auth.md", { path: "README.md" })).toBe("/acme/portal/docs/concepts/auth");
  });

  it("falls back to the repository root for GitHub-style /docs/... links", () => {
    expect(doc("/docs/concepts/auth.md")).toBe("/acme/portal/docs/concepts/auth");
  });

  it("resolves sibling and nested relative links", () => {
    expect(doc("./setup.md")).toBe("/acme/portal/docs/guides/setup");
    expect(doc("setup.md")).toBe("/acme/portal/docs/guides/setup");
    expect(doc("advanced/tuning.mdx")).toBe("/acme/portal/docs/guides/advanced/tuning");
    expect(doc("./advanced/../advanced/./tuning.mdx")).toBe(
      "/acme/portal/docs/guides/advanced/tuning",
    );
  });

  it("resolves from the repo README with repo-relative paths", () => {
    expect(doc("docs/guides/setup.md", { path: "README.md" })).toBe(
      "/acme/portal/docs/guides/setup",
    );
    expect(doc("./docs/concepts/auth.md", { path: "README.md" })).toBe(
      "/acme/portal/docs/concepts/auth",
    );
  });

  it("treats .mdx like .md", () => {
    expect(doc("../guides/advanced/tuning.mdx")).toBe("/acme/portal/docs/guides/advanced/tuning");
    expect(doc("../UPPER.MD")).toBe("/acme/portal/docs/UPPER");
  });

  it("keeps a fragment, lowercased and passed through anchorId", () => {
    expect(doc("../concepts/auth.md#Token-Refresh")).toBe(
      "/acme/portal/docs/concepts/auth#token-refresh",
    );
    expect(doc("../concepts/auth.md#constructor")).toBe(
      "/acme/portal/docs/concepts/auth#user-content-constructor",
    );
    expect(doc("../concepts/auth.md#__proto__")).toBe(
      "/acme/portal/docs/concepts/auth#user-content-__proto__",
    );
    expect(doc("../concepts/auth.md#d%C3%A9ploiement")).toBe(
      "/acme/portal/docs/concepts/auth#d%C3%A9ploiement",
    );
  });

  it("drops fragments that cannot be a heading id", () => {
    for (const fragment of [
      "",
      "a b",
      "a%20b",
      "%zz",
      "x'y",
      "<b>",
      "a%00b",
      "a/b",
      "x".repeat(1500),
    ]) {
      expect(doc(`../concepts/auth.md#${fragment}`)).toBe("/acme/portal/docs/concepts/auth");
    }
  });

  it("drops the query string", () => {
    expect(doc("../concepts/auth.md?plain=1")).toBe("/acme/portal/docs/concepts/auth");
    expect(doc("../concepts/auth.md?x=1#Sec")).toBe("/acme/portal/docs/concepts/auth#sec");
  });

  it("decodes percent-escapes once and re-encodes each segment", () => {
    expect(doc("../with%20space/my%20doc.md", { path: "docs/guides/setup.md" })).toBe(
      "/acme/portal/docs/with%20space/my%20doc",
    );
    expect(doc("../with space/my doc.md")).toBe("/acme/portal/docs/with%20space/my%20doc");
  });

  it("handles unicode file names, raw and encoded", () => {
    expect(doc("../caf\u00e9/\u00fcber.md")).toBe("/acme/portal/docs/caf%C3%A9/%C3%BCber");
    expect(doc("../caf%C3%A9/%C3%BCber.md")).toBe("/acme/portal/docs/caf%C3%A9/%C3%BCber");
  });

  it("matches the exact case first", () => {
    expect(doc("../dup/a.md")).toBe("/acme/portal/docs/dup/a");
    expect(doc("../dup/A.md")).toBe("/acme/portal/docs/dup/A");
  });

  it("falls back to a unique case-insensitive match", () => {
    expect(doc("../mixed/case.md")).toBe("/acme/portal/docs/Mixed/Case");
    expect(doc("../CONCEPTS/AUTH.MD")).toBe("/acme/portal/docs/concepts/auth");
  });

  it("does not guess between several case variants", () => {
    expect(brokenReason("../dup/a.MD")).toBe("missing_doc");
  });
});

describe("resolveLink: folders", () => {
  it("links a folder to its index.md", () => {
    expect(doc("../guides/")).toBe("/acme/portal/docs/guides/index");
    expect(doc("./")).toBe("/acme/portal/docs/guides/index");
    expect(doc(".")).toBe("/acme/portal/docs/guides/index");
    expect(doc("../guides")).toBe("/acme/portal/docs/guides/index");
  });

  it("links the docs root to the root index.md", () => {
    expect(doc("/")).toBe("/acme/portal/docs/index");
    expect(doc("..")).toBe("/acme/portal/docs/index");
    expect(doc("../")).toBe("/acme/portal/docs/index");
  });

  it("falls back to README.md in a folder", () => {
    expect(doc("../api/")).toBe("/acme/portal/docs/api/README");
    expect(doc("/api")).toBe("/acme/portal/docs/api/README");
  });

  it("prefers index.md to README.md", () => {
    const docPaths = new Set(["docs/x/README.md", "docs/x/index.md", "docs/a.md"]);
    expect(doc("x/", { path: "docs/a.md", docPaths })).toBe("/acme/portal/docs/x/index");
  });

  it("uses a folder index with a fragment", () => {
    expect(doc("../guides/#Intro")).toBe("/acme/portal/docs/guides/index#intro");
  });

  it("sends a folder without an index to the GitHub tree", () => {
    expect(github("../concepts/")).toBe("https://github.com/acme/portal/tree/main/docs/concepts");
    expect(github("../../src/")).toBe("https://github.com/acme/portal/tree/main/src");
    expect(github("../../")).toBe("https://github.com/acme/portal/tree/main");
    expect(github("../../.")).toBe("https://github.com/acme/portal/tree/main");
  });
});

describe("resolveLink: GitHub fallback", () => {
  it("maps non-synced repo files to the blob URL", () => {
    expect(github("../../src/main.ts")).toBe(
      "https://github.com/acme/portal/blob/main/src/main.ts",
    );
    expect(github("../../LICENSE")).toBe("https://github.com/acme/portal/blob/main/LICENSE");
    expect(github("../img/arch.png")).toBe(
      "https://github.com/acme/portal/blob/main/docs/img/arch.png",
    );
    expect(github("../assets/spec.pdf")).toBe(
      "https://github.com/acme/portal/blob/main/docs/assets/spec.pdf",
    );
  });

  it("treats markdown outside the docs tree as a plain repo file", () => {
    expect(github("../../README.md")).toBe("https://github.com/acme/portal/blob/main/README.md");
    expect(github("../../CHANGELOG.md")).toBe(
      "https://github.com/acme/portal/blob/main/CHANGELOG.md",
    );
    expect(github("../../docsx/a.md")).toBe("https://github.com/acme/portal/blob/main/docsx/a.md");
  });

  it("treats every markdown link as a repo file when there is no docs folder", () => {
    expect(github("other.md", { docsFolder: null, path: "README.md", docPaths: new Set() })).toBe(
      "https://github.com/acme/portal/blob/main/other.md",
    );
  });

  it("encodes each segment, branch included", () => {
    expect(github("../../src/a b/c#d.ts")).toBe(
      "https://github.com/acme/portal/blob/main/src/a%20b/c",
    );
    expect(github("../../src/a%20b/%C3%A9.ts")).toBe(
      "https://github.com/acme/portal/blob/main/src/a%20b/%C3%A9.ts",
    );
    expect(github("../../src/main.ts", { defaultBranch: "release/1.0 x" })).toBe(
      "https://github.com/acme/portal/blob/release/1.0%20x/src/main.ts",
    );
    expect(github("../../src/main.ts", { defaultBranch: "" })).toBe(
      "https://github.com/acme/portal/blob/HEAD/src/main.ts",
    );
    expect(github("../../x", { owner: "o/x", repo: "r?" })).toBe(
      "https://github.com/o%2Fx/r%3F/blob/main/x",
    );
  });

  it("keeps a line fragment as written and drops query strings", () => {
    expect(github("../../src/main.ts#L10-L20")).toBe(
      "https://github.com/acme/portal/blob/main/src/main.ts#L10-L20",
    );
    expect(github("../../src/main.ts?plain=1#L3")).toBe(
      "https://github.com/acme/portal/blob/main/src/main.ts#L3",
    );
    expect(github("../../src/main.ts#a b")).toBe(
      "https://github.com/acme/portal/blob/main/src/main.ts",
    );
  });

  it("falls back to GitHub for a synced doc that has no page", () => {
    const docPaths = new Set(["notes/a.md"]);
    expect(github("notes/a.md", { path: "README.md", docPaths })).toBe(
      "https://github.com/acme/portal/blob/main/notes/a.md",
    );
  });
});

describe("resolveLink: broken", () => {
  it("marks a missing markdown file in the docs tree (spec: file does not exist)", () => {
    expect(brokenReason("../concepts/missing.md")).toBe("missing_doc");
    expect(brokenReason("/nope/x.mdx")).toBe("missing_doc");
    expect(brokenReason("missing.md#sec")).toBe("missing_doc");
    expect(brokenReason("../../docs/gone.md")).toBe("missing_doc");
  });

  it("marks a link that escapes the repository root", () => {
    expect(brokenReason("../../../x.md")).toBe("outside_root");
    expect(brokenReason("../../../../etc/passwd")).toBe("outside_root");
    expect(brokenReason("../x.md", { path: "README.md" })).toBe("outside_root");
    expect(brokenReason("..", { path: "README.md" })).toBe("outside_root");
  });

  it("does not clamp: no .. reaches any output URL", () => {
    for (const href of ["../../../x", "../../..", "a/../../../../b.md"]) {
      expect(brokenReason(href)).toBe("outside_root");
    }
  });

  it("does not let a bundle-root-absolute link climb out of the docs root", () => {
    expect(brokenReason("/../README.md")).toBe("outside_root");
    expect(brokenReason("/a/../../x.md")).toBe("outside_root");
  });

  it("decodes before normalizing, so encoded traversal is caught", () => {
    expect(github("%2e%2e/%2e%2e/etc/passwd")).toBe(
      "https://github.com/acme/portal/blob/main/etc/passwd",
    );
    expect(brokenReason("%2e%2e/%2e%2e/%2e%2e/etc/passwd")).toBe("outside_root");
    expect(brokenReason("..%2f..%2f..%2fetc/passwd")).toBe("invalid");
    expect(brokenReason("%2E%2E%2F%2E%2E%2Fx.md")).toBe("invalid");
  });

  it("rejects backslashes, raw and encoded", () => {
    expect(brokenReason("..\\..\\x.md")).toBe("invalid");
    expect(brokenReason("a\\b.md")).toBe("invalid");
    expect(brokenReason("\\\\evil.example\\x")).toBe("invalid");
    expect(brokenReason("/\\evil.example")).toBe("invalid");
    expect(brokenReason("a%5Cb.md")).toBe("invalid");
    expect(brokenReason("a%5cb.md")).toBe("invalid");
  });

  it("rejects control characters, raw and encoded", () => {
    expect(brokenReason("a\u0000b.md")).toBe("invalid");
    expect(brokenReason("a%00b.md")).toBe("invalid");
    expect(brokenReason("a\nb.md")).toBe("invalid");
    expect(brokenReason("a\tb.md")).toBe("invalid");
    expect(brokenReason("a%0Ab.md")).toBe("invalid");
    expect(brokenReason("a\u007fb.md")).toBe("invalid");
    expect(brokenReason("a\u0085b.md")).toBe("invalid");
    expect(brokenReason("a\u2028b.md")).toBe("invalid");
  });

  it("rejects malformed escapes and lone surrogates", () => {
    expect(brokenReason("100%.md")).toBe("invalid");
    expect(brokenReason("%E0%A4%A.md")).toBe("invalid");
    expect(brokenReason("%C3.md")).toBe("invalid");
    expect(brokenReason("a\ud800b.md")).toBe("invalid");
  });

  it("caps very long relative hrefs", () => {
    expect(brokenReason(`${"a".repeat(MAX_HREF_CHARS)}.md`)).toBe("too_long");
    expect(brokenReason(`${"../".repeat(2000)}x.md`)).toBe("too_long");
    expect(resolveLink(`${"a".repeat(MAX_HREF_CHARS - 3)}.md`, ctx()).kind).toBe("broken");
  });

  it("never throws", () => {
    const hostile = [
      "%",
      "%%",
      "#%",
      "?%",
      "\ud800",
      "a/\udfff",
      "/".repeat(5000),
      "../".repeat(50),
    ];
    for (const href of hostile) {
      expect(() => resolveLink(href, ctx())).not.toThrow();
    }
  });
});

describe("resolveLink: left alone", () => {
  const untouched = [
    "",
    "   ",
    "#section",
    "#",
    "?plain=1",
    "https://example.com/a.md",
    "http://example.com",
    "HTTPS://EXAMPLE.COM",
    "mailto:a@b.example",
    "tel:+123",
    "javascript:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<b>",
    "vbscript:x",
    "ftp://example.com/x",
    "file:///etc/passwd",
    "C:\\Windows\\x",
    "foo:bar.md",
    "//evil.example/x.md",
    "//evil.example",
  ];
  it.each(untouched)("%j", (href) => {
    expect(resolveLink(href, ctx())).toEqual({ kind: "untouched" });
  });
});

describe("createLinkResolver", () => {
  it("can be reused across hrefs", () => {
    const resolve = createLinkResolver(ctx());
    expect(resolve("../concepts/auth.md")).toEqual(resolve("../concepts/auth.md"));
    expect(resolve("../concepts/auth.md").kind).toBe("doc");
    expect(resolve("../x.md").kind).toBe("broken");
  });
});

describe("brokenLinkTitle", () => {
  it("removes control characters and caps the length", () => {
    expect(brokenLinkTitle("a\u0000\nb\u2028c")).toBe("Broken link: abc");
    const long = brokenLinkTitle("x".repeat(1500));
    expect(long).toBe(`Broken link: ${"x".repeat(MAX_BROKEN_TITLE_CHARS)}\u2026`);
  });

  it("does not split a surrogate pair", () => {
    const title = brokenLinkTitle("\u{1f600}".repeat(500));
    expect(title).toBe(`Broken link: ${"\u{1f600}".repeat(MAX_BROKEN_TITLE_CHARS)}\u2026`);
  });
});

/* ------------------------------------------------------------------ pipeline ----------- */

async function render(source: string, overrides: Partial<LinkContext> = {}) {
  const result = await renderMarkdown(source, { links: ctx(overrides) });
  assertSafeHtml(result.html, "links");
  return result.html;
}

describe("renderMarkdown with links", () => {
  it("rewrites the spec scenarios end to end", async () => {
    const html = await render(
      "[auth](../concepts/auth.md) and [orders](/tables/orders.md#Schema)\n",
    );
    expect(html).toBe(
      '<p><a href="/acme/portal/docs/concepts/auth">auth</a> and ' +
        '<a href="/acme/portal/docs/tables/orders#schema">orders</a></p>',
    );
  });

  it("leaves links untouched when no context is given", async () => {
    const result = await renderMarkdown("[a](../concepts/auth.md)\n");
    expect(result.html).toBe('<p><a href="../concepts/auth.md">a</a></p>');
  });

  it("renders a broken link without failing, and the class survives the sanitizer", async () => {
    const result = await renderMarkdown("before [gone](../missing.md) after\n\n# Heading\n", {
      links: ctx(),
    });
    assertSafeHtml(result.html, "broken");
    expect(result.warnings).toEqual([]);
    expect(result.html).toContain(
      '<a class="dmr-broken-link" title="Broken link: ../missing.md">gone</a>',
    );
    expect(result.html).not.toContain('href="../missing');
    expect(result.html).toContain('<h1 id="heading">Heading');
    expect(result.headings).toHaveLength(1);
  });

  it("adds the GitHub URL for non-synced files, rel added by the sanitizer", async () => {
    const html = await render("[src](../../src/main.ts) [dir](../../src/)\n");
    expect(html).toBe(
      '<p><a href="https://github.com/acme/portal/blob/main/src/main.ts" rel="nofollow noopener noreferrer">src</a> ' +
        '<a href="https://github.com/acme/portal/tree/main/src" rel="nofollow noopener noreferrer">dir</a></p>',
    );
  });

  it("leaves images untouched (task 7.5)", async () => {
    const html = await render("![alt](./img/arch.png)\n");
    expect(html).toContain('src="./img/arch.png"');
  });

  it("rewrites reference-style links and autolinks", async () => {
    const ref = await render("[auth][a]\n\n[a]: ../concepts/auth.md\n");
    expect(ref).toContain('<a href="/acme/portal/docs/concepts/auth">auth</a>');
    const auto = await render("<https://example.com/x> and https://example.com/y\n");
    expect(auto).toContain('href="https://example.com/x"');
    expect(auto).toContain('href="https://example.com/y"');
    expect(auto).not.toContain("dmr-broken-link");
  });

  it("rewrites raw HTML anchors the same way", async () => {
    const html = await render('<a href="../concepts/auth.md">x</a> <a href="../nope.md">y</a>\n');
    expect(html).toContain('<a href="/acme/portal/docs/concepts/auth">x</a>');
    expect(html).toContain('<a class="dmr-broken-link" title="Broken link: ../nope.md">y</a>');
  });

  it("skips anchors without href and with empty href", async () => {
    const html = await render('<a name="x">n</a> <a href="">e</a> <a>bare</a>\n');
    expect(html).not.toContain("dmr-broken-link");
    expect(html).toContain("bare");
  });

  it("rewrites links in headings, tables, lists and footnotes", async () => {
    const html = await render(
      [
        "## See [auth](../concepts/auth.md)",
        "",
        "| a | b |",
        "|---|---|",
        "| [x](../concepts/auth.md) | [y](../nope.md) |",
        "",
        "- [item](../tables/orders.md)",
        "  - [nested](../../src/a.ts)",
        "",
        "Text[^1]",
        "",
        "[^1]: Note [auth](../concepts/auth.md).",
        "",
      ].join("\n"),
    );
    expect(html.match(/href="\/acme\/portal\/docs\/concepts\/auth"/g)).toHaveLength(3);
    expect(html).toContain('<a href="/acme/portal/docs/tables/orders">item</a>');
    expect(html).toContain("https://github.com/acme/portal/blob/main/src/a.ts");
    expect(html).toContain('<a class="dmr-broken-link" title="Broken link: ../nope.md">y</a>');
    expect(html).toContain('id="user-content-fn-1"');
    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).toContain('href="#user-content-fnref-1"');
  });

  it("does not touch links inside code", async () => {
    const html = await render(
      "`[a](../nope.md)`\n\n```md\n[a](../concepts/auth.md)\n[b](../nope.md)\n```\n\n    [c](../nope.md)\n",
    );
    expect(html).not.toContain("dmr-broken-link");
    expect(html).not.toContain("/acme/portal/docs");
    expect(html).toContain("[a](../nope.md)");
    expect(html).toContain("[c](../nope.md)");
  });

  it("leaves fragment-only links to the sanitizer and keeps heading links working", async () => {
    const html = await render("# Constructor\n\n[up](#constructor) [x](#Not-There)\n");
    expect(html).toContain('<h1 id="user-content-constructor">');
    expect(html).toContain('<a href="#user-content-constructor">up</a>');
    expect(html).toContain('<a href="#Not-There">x</a>');
  });

  it("renames a sensitive heading id in the link to another doc", async () => {
    const html = await render("[c](../concepts/auth.md#Constructor)\n");
    expect(html).toContain('href="/acme/portal/docs/concepts/auth#user-content-constructor"');
  });

  it("drops unsafe schemes through the sanitizer", async () => {
    const html = await render(
      "[a](javascript:alert(1)) [b](mailto:a@b.example) [c](https://example.com) " +
        "[d](data:text/html,x) [e](//evil.example/x) [f](  JaVaScRiPt:alert(1))\n",
    );
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("data:");
    expect(html).toContain('href="mailto:a@b.example"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="//evil.example/x"');
  });

  it("never produces odd URLs for hostile hrefs", async () => {
    const hostile = [
      "..%2f..%2fetc/passwd",
      "..\\..\\etc\\passwd",
      "a%00b.md",
      "/\\evil.example",
      "\\\\evil.example",
      `${"a/".repeat(3000)}x.md`,
      "../../../../../../etc/passwd",
    ];
    for (const href of hostile) {
      const html = await render(`<a href="${href.replace(/"/g, "&quot;")}">x</a>\n`);
      expect(html).not.toMatch(/href="[^"]*(?:\.\.|\\|%2e|%00|%5c)/i);
      expect(html).not.toContain("href=");
      expect(html).toContain("dmr-broken-link");
    }
  });

  it("escapes a hostile href in the broken-link title", async () => {
    const html = await render('<a href="../x&quot; onmouseover=&quot;alert(1).md">x</a>\n');
    expect(html).not.toMatch(/"\s+onmouseover=/);
    expect(html).toContain("Broken link: ../x&#x22; onmouseover=&#x22;alert(1).md");
    expect(html).toContain("dmr-broken-link");
  });

  it("composes with other linkRewrite slot plugins, after the built-in rewrite", async () => {
    const seen: string[] = [];
    const spy = () => (tree: { children: unknown[] }) => {
      const walk = (nodes: unknown[]) => {
        for (const n of nodes) {
          const node = n as {
            tagName?: string;
            properties?: { href?: string };
            children?: unknown[];
          };
          if (node.tagName === "a" && node.properties?.href) seen.push(node.properties.href);
          if (node.children) walk(node.children);
        }
      };
      walk(tree.children);
    };
    await renderMarkdown("[a](../concepts/auth.md)\n", {
      links: ctx(),
      slots: { linkRewrite: [spy] },
    });
    expect(seen).toEqual(["/acme/portal/docs/concepts/auth"]);
  });

  it("renders a document with thousands of links without failing", async () => {
    const source = Array.from(
      { length: 2000 },
      (_, i) => `[l${i}](../concepts/auth.md#s${i})`,
    ).join("\n\n");
    const result = await renderMarkdown(source, { links: ctx() });
    expect(result.warnings).toEqual([]);
    expect(result.html.match(/\/acme\/portal\/docs\/concepts\/auth#s/g)).toHaveLength(2000);
  });
});
