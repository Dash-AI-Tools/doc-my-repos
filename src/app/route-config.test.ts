import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT, walkFiles } from "../../tests/support/repo-files";

/**
 * Route files bind the UI package's pages; their segment config has to be written in the route
 * file itself, because Next.js reads it statically. Every page and layout that renders from the
 * database is rendered per request (Postgres changes whenever a sync finishes), so it must say
 * `force-dynamic`. The root layout, the not-found pages, `loading.tsx`, the error boundaries and
 * the e2e fixture pages need no config.
 */
const STATIC_OK = [
  /^src\/app\/layout\.tsx$/,
  /\/not-found\.tsx$/,
  /\/loading\.tsx$/,
  /^src\/app\/(global-)?error\.tsx$/,
  /^src\/app\/e2e\//,
];

const routeFiles = walkFiles(join(REPO_ROOT, "src", "app"))
  .map((file) => file.slice(REPO_ROOT.length).replace(/^\//, ""))
  .filter((file) => /\/(page|layout)\.tsx$/.test(file));

describe("route segment config", () => {
  it("finds the route files", () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  for (const file of routeFiles) {
    if (STATIC_OK.some((pattern) => pattern.test(file))) continue;
    it(`${file} is rendered per request`, () => {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(source).toMatch(/^export const dynamic = "force-dynamic";$/m);
    });
  }
});
