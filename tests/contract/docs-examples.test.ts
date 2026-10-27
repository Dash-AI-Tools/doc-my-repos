import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The host app example in `docs/reference/extension-api.md` is the code under
 * `docs-examples/host/`, which the project's type check compiles. Each code block that follows a
 * line naming a file (`src/docmyrepos.ts`:) must equal that file, so the documented example
 * always compiles.
 */
const SUITE = dirname(fileURLToPath(import.meta.url));
const DOC = resolve(SUITE, "../../docs/reference/extension-api.md");
const HOST = join(SUITE, "docs-examples", "host");

function namedBlocks(markdown: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const pattern = /^`([^`\n]+)`:\n\n```[a-z]*\n([\s\S]*?)```$/gm;
  for (const match of markdown.matchAll(pattern)) blocks.set(match[1] ?? "", match[2] ?? "");
  return blocks;
}

describe("the documented host app", () => {
  const blocks = namedBlocks(readFileSync(DOC, "utf8"));

  it("shows the complete example", () => {
    expect([...blocks.keys()].sort()).toEqual([
      "next.config.ts",
      "src/app/api/search/route.ts",
      "src/app/globals.css",
      "src/app/layout.tsx",
      "src/app/page.tsx",
      "src/docmyrepos.ts",
      "src/instrumentation.ts",
      "src/proxy.ts",
    ]);
  });

  for (const [path, code] of namedBlocks(readFileSync(DOC, "utf8"))) {
    it(`${path} is the compiled example file`, () => {
      expect(code).toBe(readFileSync(join(HOST, path), "utf8"));
    });
  }
});
