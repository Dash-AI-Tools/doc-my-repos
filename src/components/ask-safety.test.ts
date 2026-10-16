import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ask-the-docs task 5.4: answers and the documents behind them are untrusted, so no Ask file may
 * reach for the HTML path, render an image from answer text, or build a link from model output.
 * This guard fails when a file does. Hostile-render cases live in `ask-chat.test.tsx`.
 */

const ROOT = join(__dirname, "..", "..");

const FEATURE = [
  /^src\/components\/ask-.*\.tsx?$/,
  /^src\/lib\/ask\/.*\.ts$/,
  /^src\/server\/ask\/.*\.ts$/,
  /^src\/server\/ask-page\.ts$/,
  /^src\/server\/admin\/ask\.ts$/,
  /^src\/app\/ask\/.*\.tsx?$/,
  /^src\/app\/admin\/ask\/.*\.tsx?$/,
  /^src\/app\/api\/ask\/.*\.ts$/,
  /^src\/app\/api\/admin\/ask\/.*\.ts$/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full).split("\\").join("/"));
  }
  return out;
}

const files = walk(join(ROOT, "src"))
  .filter((f) => FEATURE.some((re) => re.test(f)))
  .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes("/testing/"));

/** Source with comments removed, so a rule is not tripped by prose that names what it forbids. */
function code(file: string): string {
  return readFileSync(join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const UI = files.filter((f) => f.endsWith(".tsx"));

describe("Ask files are found", () => {
  it("covers the pieces that handle answer text", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "src/components/ask-answer.tsx",
        "src/components/ask-chat.tsx",
        "src/components/ask-settings-form.tsx",
        "src/lib/ask/answer.ts",
        "src/server/ask/handler.ts",
        "src/app/ask/page.tsx",
      ]),
    );
  });
});

const NEVER: ReadonlyArray<[string, RegExp]> = [
  ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
  ["innerHTML / outerHTML", /\b(inner|outer)HTML\b/],
  ["insertAdjacentHTML", /insertAdjacentHTML/],
  ["document.write", /document\.write/],
  ["DOMParser / createContextualFragment", /DOMParser|createContextualFragment/],
  ["eval / new Function", /\beval\s*\(|new\s+Function\s*\(/],
];

describe("no Ask file takes the HTML path", () => {
  for (const [label, pattern] of NEVER) {
    it(`never uses ${label}`, () => {
      expect(files.filter((file) => pattern.test(code(file)))).toEqual([]);
    });
  }
});

describe("no Ask component embeds content", () => {
  it("renders no image, frame, object, embed, script or SVG", () => {
    const embed = /<\s*(img|Image|iframe|object|embed|script|svg|video|audio|source)\b/;
    expect(UI.filter((file) => embed.test(code(file)))).toEqual([]);
  });

  it("sets no src, srcSet, srcDoc, style from data, or event-handler string", () => {
    const attr = /\b(src|srcSet|srcDoc|formAction)\s*=|\bon[A-Z][A-Za-z]*\s*=\s*["']/;
    expect(UI.filter((file) => attr.test(code(file)))).toEqual([]);
  });
});

/** The only href expressions an Ask component may contain. Anything else must be added here, on review. */
const ALLOWED_HREFS: ReadonlyArray<RegExp> = [
  // A citation marker points at the page's own reference list, by a number the sanitizer checked.
  /^`#\$\{idPrefix\}-ref-\$\{node\.n\}`$/,
  // A reference link: server-built, and passed through `safeHref` (same-site paths only).
  /^href$/,
  // The search for a question that found nothing: encoded, bounded text in the query string.
  /^`\/search\?q=\$\{encodeURIComponent\(message\.question\.slice\(0,200\)\)\}`$/,
  // The panel's expand link: the repo scope the reader picked, encoded.
  /^repo\?`\/ask\?repo=\$\{encodeURIComponent\(repo\)\}`:"\/ask"$/,
  // Fixed internal pages.
  /^\/(ask|admin\/[a-z]+)?$/,
];

/** The expression of every `href=` attribute: a balanced `{...}` or a quoted string, spaces removed. */
function hrefExpressions(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/\bhref=/g)) {
    let i = (match.index ?? 0) + match[0].length;
    const open = source[i];
    let end = i + 1;
    if (open === "{") {
      let depth = 0;
      for (end = i; end < source.length; end += 1) {
        if (source[end] === "{") depth += 1;
        else if (source[end] === "}" && --depth === 0) break;
      }
      i += 1;
    } else if (open === '"' || open === "'") {
      end = source.indexOf(open, i + 1);
      i += 1;
    }
    out.push(source.slice(i, end).replace(/\s+/g, ""));
  }
  return out;
}

describe("no Ask component builds a link from model output", () => {
  const hrefs = UI.flatMap((file) =>
    hrefExpressions(code(file)).map((expression) => ({ file, expression })),
  );

  it("finds the links that exist", () => {
    expect(hrefs.length).toBeGreaterThan(2);
  });

  it("allows only the known href expressions", () => {
    const unknown = hrefs.filter((h) => !ALLOWED_HREFS.some((re) => re.test(h.expression)));
    expect(unknown).toEqual([]);
  });

  it("builds the reference href variable only through safeHref", () => {
    const chat = code("src/components/ask-chat.tsx");
    expect(chat).toMatch(/function safeHref\(/);
    expect(chat).toMatch(/const href = safeHref\(ref\.href\)/);
    expect(chat.match(/\bhref=\{href\}/g)).toHaveLength(1);
  });

  it("makes the answer renderer's only anchor the citation marker", () => {
    const answer = code("src/components/ask-answer.tsx");
    expect(answer.match(/<a\b/g)).toHaveLength(1);
    expect(answer).not.toMatch(/<Link\b/);
  });

  it("gives the answer tree no node that could be an image or a link", () => {
    const source = code("src/lib/ask/answer.ts");
    const inline = /export type Inline =([\s\S]*?);\s*\nexport type Block/.exec(source)?.[1] ?? "";
    const block =
      /export type Block =([\s\S]*?);\s*\nexport const MAX_ANSWER_CHARS/.exec(source)?.[1] ?? "";
    const kinds = (text: string) => [...text.matchAll(/type: "([a-z]+)"/g)].map((m) => m[1]);
    expect(kinds(inline)).toEqual(["text", "strong", "em", "code", "cite"]);
    expect(kinds(block)).toEqual(["paragraph", "list", "code"]);
  });
});
