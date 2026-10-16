import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * document-comments task 4.3: comment text is untrusted, so no file of the feature may reach for
 * an HTML path (`dangerouslySetInnerHTML`, `innerHTML`, and friends) or build HTML strings. The
 * hostile-render cases live in `comments-section.test.tsx` ("markup as literal text").
 */

const ROOT = join(__dirname, "..", "..");
const FEATURE = [
  /^src\/components\/comment[-s].*\.tsx?$/,
  /^src\/lib\/comments(-view)?\.ts$/,
  /^src\/server\/comments\/.*\.ts$/,
  /^src\/server\/doc-comments\.ts$/,
  /^src\/server\/queries\/comments\.ts$/,
  /^src\/server\/same-origin\.ts$/,
  /^src\/app\/api\/(admin\/)?comments\/.*\.ts$/,
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
  .filter((f) => !/\.test\.tsx?$/.test(f) && !f.endsWith("comments-fixtures.ts"));

const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
  ["innerHTML / outerHTML", /\b(inner|outer)HTML\b/],
  ["insertAdjacentHTML", /insertAdjacentHTML/],
  ["document.write", /document\.write/],
  ["DOMParser / createContextualFragment", /DOMParser|createContextualFragment/],
  // A string or template literal that starts an HTML tag: building markup by hand.
  ["an HTML string literal", /[`'"]\s*<\/?[a-zA-Z][^`'"]*[`'"]/],
];

describe("comment feature files", () => {
  it("finds the feature files", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "src/components/comments-client.tsx",
        "src/components/comment-text.tsx",
        "src/lib/comments.ts",
        "src/server/comments/service.ts",
      ]),
    );
  });

  for (const [label, pattern] of FORBIDDEN) {
    it(`do not use ${label}`, () => {
      const hits = files.filter((file) => {
        // Comments in the source may mention these names; only code counts.
        const code = readFileSync(join(ROOT, file), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1");
        return pattern.test(code);
      });
      expect(hits).toEqual([]);
    });
  }
});
