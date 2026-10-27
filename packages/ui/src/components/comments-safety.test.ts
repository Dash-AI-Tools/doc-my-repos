import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT, sourceFiles } from "../../../../tests/support/repo-files";

/**
 * document-comments task 4.3: comment text is untrusted, so no file of the feature may reach for
 * an HTML path (`dangerouslySetInnerHTML`, `innerHTML`, and friends) or build HTML strings. The
 * hostile-render cases live in `comments-section.test.tsx` ("markup as literal text").
 */

const ROOT = REPO_ROOT;
const FEATURE = [
  /^packages\/ui\/src\/components\/comment[-s].*\.tsx?$/,
  /^packages\/core\/src\/comments(-view)?\.ts$/,
  /^packages\/server\/src\/comments\/.*\.ts$/,
  /^packages\/server\/src\/doc-comments\.ts$/,
  /^packages\/server\/src\/queries\/comments\.ts$/,
  /^packages\/server\/src\/same-origin\.ts$/,
  /^src\/app\/api\/(admin\/)?comments\/.*\.ts$/,
];

const files = sourceFiles()
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
        "packages/ui/src/components/comments-client.tsx",
        "packages/ui/src/components/comment-text.tsx",
        "packages/core/src/comments.ts",
        "packages/server/src/comments/service.ts",
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
