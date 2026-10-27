import { readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { REPO_ROOT, sourceFiles } from "../../../../tests/support/repo-files";

/**
 * Static guard for the single visibility enforcement point (spec repo-space "Single enforcement
 * point", design decision 5b, CLAUDE.md). No database: it parses every source file of the app and
 * the workspace packages and fails when code outside the allow-list reads `repos`, `documents` or
 * `code_owners` around the shared query layer, or when UI code reaches the database layer at all.
 *
 * Paths in the rules are LOGICAL: the layer a file belongs to, as `server/...` (the server package),
 * `lib/...` (the core package), `components/...` (UI components), `app/...` (route files and the
 * page bodies of the UI package). `LAYOUT` maps the physical folders onto them.
 *
 * Rule 1, protected tables: outside `ALLOWED_TABLE_ACCESS`, a file may not
 *   - value-import `repos`, `documents` or `codeOwners` from `server/db/schema` (type-only
 *     imports such as `Heading` are fine), import the schema as a namespace, or re-export it;
 *   - use Drizzle's relational API on them (`db.query.repos`);
 *   - name them in a `sql` template (`from repos`, `join documents`, `update code_owners`).
 * Rule 2, layering: nothing under `app`, `components` or `lib` imports anything from `server/db`
 *   (pages use the query layer), and nothing under `components` or `lib` imports `server/queries`
 *   or `server/runtime` (components have no database access; data comes in as props).
 * Rule 3, no back doors: only `server/db/schema.ts` may export the protected tables, so an
 *   allow-listed module cannot hand them to a page.
 * Tests (`*.test.ts(x)`) are exempt: they seed data and inspect rows.
 */

/** Physical folder (repository-relative) to logical layer, most specific first. */
const LAYOUT: readonly (readonly [string, string])[] = [
  ["packages/server/src/", "server/"],
  ["packages/core/src/", "lib/"],
  ["packages/ui/src/pages/", "app/"],
  ["packages/ui/packages/ui/src/components/", "components/"],
  ["packages/ui/src/", "components/"],
  ["src/app/", "app/"],
  ["packages/ui/src/components/", "components/"],
  ["src/", ""],
];

/** Where a logical path lives on disk, for scanning snippets as if they were in that layer. */
const PHYSICAL: readonly (readonly [string, string])[] = [
  ["server/", "packages/server/src/"],
  ["lib/", "packages/core/src/"],
  ["components/", "packages/ui/packages/ui/src/components/"],
  ["app/", "src/app/"],
];

const SCHEMA = "server/db/schema";

/** The tables every portal read must reach through `server/queries`. */
const PROTECTED_EXPORTS = new Set(["repos", "documents", "codeOwners", "docComments", "apiSpecs"]);
const PROTECTED_SQL_TABLES = ["repos", "documents", "code_owners", "doc_comments", "api_specs"];

/**
 * Where direct access to the protected tables is allowed, and why. Paths are logical.
 */
const ALLOWED_TABLE_ACCESS: readonly { prefix: string; why: string }[] = [
  { prefix: "server/db/", why: "the schema, client and migrations define the tables" },
  { prefix: "server/queries/", why: "the shared read layer that applies the visibility filter" },
  {
    prefix: "server/sync/",
    why: "the write side: sync, persistence, removal and rerun markers write these tables and read their own state (never served to visitors)",
  },
  {
    prefix: "server/webhooks/store.ts",
    why: "webhook write side: marks repositories errored or private, never served to visitors",
  },
  {
    prefix: "server/admin/",
    why: "admin write side: user management (users table only) and the repo allow/block toggle; admin repo reads go through the query layer with an explicit filter",
  },
  {
    prefix: "server/comments/",
    why: "comment write side: it writes and reads its own doc_comments rows (cap and rate counts under a lock), never serves them to visitors, and checks that the document is visible through the query layer before every insert",
  },
];

/** UI and shared-pure code that must not touch the database layer at all. */
const NO_DB_LAYER = ["app/", "components/", "lib/"];
/** Code that must not touch the query layer or runtime either (no database access). */
const NO_DATA_ACCESS = ["components/", "lib/"];

function isTest(rel: string): boolean {
  return /\.test\.tsx?$/.test(rel);
}

function allowed(rel: string): boolean {
  return ALLOWED_TABLE_ACCESS.some((a) => rel === a.prefix || rel.startsWith(a.prefix));
}

/** The logical path of a repository-relative file, or null when it is in no source root. */
function logicalOf(repoPath: string): string | null {
  for (const [physical, logical] of LAYOUT) {
    if (repoPath.startsWith(physical)) return logical + repoPath.slice(physical.length);
  }
  return null;
}

/** The absolute file for a logical path. */
function physicalOf(rel: string): string {
  const hit = PHYSICAL.find(([logical]) => rel.startsWith(logical));
  return join(REPO_ROOT, hit ? hit[1] + rel.slice(hit[0].length) : `src/${rel}`);
}

const INTERNAL = /^@docmyrepos\/(core|server|ui)(?:\/internal\/(.+))?$/;

/** Logical module path without extension, or null for an outside package. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let target: string;
  const pkg = INTERNAL.exec(specifier);
  if (pkg) target = join(REPO_ROOT, "packages", pkg[1] as string, "src", pkg[2] ?? "index");
  else if (specifier.startsWith("@/")) target = join(REPO_ROOT, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) target = resolve(dirname(fromFile), specifier);
  else return null;
  const logical = logicalOf(relative(REPO_ROOT, target).split("\\").join("/"));
  if (logical === null) return null;
  return logical.replace(/\.(tsx?|jsx?|mjs)$/, "").replace(/\/index$/, "");
}

function under(target: string | null, ...parts: string[]): boolean {
  if (target === null) return false;
  const base = posix.join(...parts);
  return target === base || target.startsWith(`${base}/`);
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

const SQL_TABLE = new RegExp(
  `\\b(?:from|join|update|into|table)\\s+(?:"?public"?\\.)?"?(?:${PROTECTED_SQL_TABLES.join("|")})"?(?![\\w"])`,
  "i",
);

/** Finds rule violations in one file. `rel` is the path relative to `src/` with `/` separators. */
function scanSource(rel: string, file: string, text: string): Violation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Violation[] = [];
  const report = (node: ts.Node, rule: string) =>
    out.push({
      file: rel,
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      rule,
    });
  const tableRules = !allowed(rel);
  const noDbLayer = NO_DB_LAYER.some((p) => rel.startsWith(p));
  const noData = NO_DATA_ACCESS.some((p) => rel.startsWith(p));

  const checkModule = (node: ts.Node, specifier: string) => {
    const target = resolveSpecifier(file, specifier);
    if (noDbLayer && under(target, "server", "db")) {
      report(node, `imports the database layer (${specifier}); use the query layer`);
    }
    if (noData && (under(target, "server", "queries") || under(target, "server", "runtime"))) {
      report(node, `imports data access (${specifier}); pass data in as props`);
    }
    return target === SCHEMA;
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const isSchema = checkModule(node, node.moduleSpecifier.text);
      const clause = node.importClause;
      if (isSchema && tableRules && clause && !clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          report(node, "imports the schema as a namespace");
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (!el.isTypeOnly && PROTECTED_EXPORTS.has(imported)) {
              report(el, `imports the ${imported} table; read through the query layer`);
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const fromSchema =
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        checkModule(node, node.moduleSpecifier.text);
      if (!node.isTypeOnly && rel !== "server/db/schema.ts") {
        if (fromSchema && node.exportClause === undefined) {
          report(node, "re-exports the schema");
        } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            const name = (el.propertyName ?? el.name).text;
            if (!el.isTypeOnly && PROTECTED_EXPORTS.has(name)) {
              report(el, `re-exports the ${name} table`);
            }
          }
        } else if (fromSchema) {
          report(node, "re-exports the schema");
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const isSchema = checkModule(node, node.arguments[0].text);
      if (isSchema && tableRules) report(node, "loads the schema dynamically");
    } else if (
      tableRules &&
      ts.isPropertyAccessExpression(node) &&
      PROTECTED_EXPORTS.has(node.name.text) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "query"
    ) {
      report(node, `uses db.query.${node.name.text}; read through the query layer`);
    } else if (tableRules && ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag.getText(source);
      if (/^sql(\.\w+)?$/.test(tag) && SQL_TABLE.test(node.template.getText(source))) {
        report(node, "names a protected table in SQL; read through the query layer");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("single enforcement point (static)", () => {
  it("allow-lists only server modules, each with a reason", () => {
    for (const a of ALLOWED_TABLE_ACCESS) {
      expect(a.prefix.startsWith("server/"), a.prefix).toBe(true);
      expect(a.why.length).toBeGreaterThan(10);
    }
  });

  it("finds no file that reads repos, documents or code_owners around the query layer", () => {
    const files = sourceFiles().filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"));
    expect(files.length).toBeGreaterThan(50);
    const violations: Violation[] = [];
    for (const file of files) {
      const rel = logicalOf(file);
      if (rel === null || isTest(rel)) continue;
      violations.push(
        ...scanSource(rel, join(REPO_ROOT, file), readFileSync(join(REPO_ROOT, file), "utf8")),
      );
    }
    expect(violations).toEqual([]);
  });

  it("scans real files: the query layer and the write side do use the tables", () => {
    // Guards against a scanner that silently matches nothing (wrong root or resolution).
    for (const rel of ["server/queries/repos.ts", "server/sync/persist.ts"]) {
      const file = physicalOf(rel);
      const text = readFileSync(file, "utf8");
      // Rules chosen as for a page, imports resolved from the real location.
      const asOutsider = scanSource("app/fake/page.tsx", file, text);
      expect(asOutsider.length, rel).toBeGreaterThan(0);
    }
  });
});

describe("scanSource", () => {
  const scan = (rel: string, text: string) => scanSource(rel, physicalOf(rel), text);
  const rules = (rel: string, text: string) => scan(rel, text).map((v) => v.rule);

  it("flags value imports of the protected tables, by alias, relative path or namespace", () => {
    expect(
      rules("app/page.tsx", `import { repos } from "@docmyrepos/server/internal/db/schema";`),
    ).toHaveLength(2);
    expect(rules("server/search/x.ts", `import { documents as d } from "../db/schema";`)).toEqual([
      "imports the documents table; read through the query layer",
    ]);
    expect(
      rules("server/search/x.ts", `import * as s from "@docmyrepos/server/internal/db/schema";`),
    ).toEqual(["imports the schema as a namespace"]);
    expect(rules("server/x.ts", `import { codeOwners } from "./db/schema.ts";`)).toHaveLength(1);
    expect(rules("server/x.ts", `const m = await import("./db/schema");`)).toHaveLength(1);
  });

  it("allows type-only imports and other schema exports outside UI code", () => {
    expect(rules("server/markdown/x.ts", `import type { Heading } from "../db/schema";`)).toEqual(
      [],
    );
    expect(
      rules(
        "server/markdown/x.ts",
        `import { type repos, SEARCH_TEXT_CONFIG } from "../db/schema";`,
      ),
    ).toEqual([]);
    expect(rules("server/x.ts", `import type { documents } from "./db/schema";`)).toEqual([]);
  });

  it("flags the relational API and raw SQL on the tables", () => {
    expect(rules("server/x.ts", `await db.query.documents.findMany();`)).toHaveLength(1);
    expect(rules("server/x.ts", 'await db.execute(sql`select * from "repos"`);')).toHaveLength(1);
    expect(
      rules("server/x.ts", "await db.execute(sql`SELECT 1 FROM public.code_owners`);"),
    ).toHaveLength(1);
    expect(rules("server/x.ts", "sql`select x from d join documents on true`;")).toHaveLength(1);
    expect(rules("server/x.ts", "sql`select x from repository_stats`;")).toEqual([]);
    expect(rules("app/page.tsx", "const copy = `Docs from repos across the org`;")).toEqual([]);
  });

  it("protects doc_comments: pages, components and other server modules cannot read it", () => {
    const named = `import { docComments } from "@docmyrepos/server/internal/db/schema";`;
    expect(rules("app/x/page.tsx", named)).toContain(
      "imports the docComments table; read through the query layer",
    );
    expect(rules("components/comments.tsx", named)).toContain(
      "imports the docComments table; read through the query layer",
    );
    expect(rules("server/search/x.ts", named)).toHaveLength(1);
    expect(rules("server/x.ts", "await db.query.docComments.findMany();")).toHaveLength(1);
    expect(
      rules("server/x.ts", 'await db.execute(sql`select * from "doc_comments"`);'),
    ).toHaveLength(1);
    expect(
      rules(
        "app/x/page.tsx",
        `import type { docComments } from "@docmyrepos/server/internal/db/schema";`,
      ),
    ).toHaveLength(1);
    expect(rules("server/comments/x.ts", named)).toEqual([]);
    expect(rules("server/queries/x.ts", named)).toEqual([]);
  });

  it("protects api_specs: only the sync write side and the query layer may touch it", () => {
    const named = `import { apiSpecs } from "@docmyrepos/server/internal/db/schema";`;
    expect(rules("app/x/page.tsx", named)).toContain(
      "imports the apiSpecs table; read through the query layer",
    );
    expect(rules("server/repo-page.ts", named)).toHaveLength(1);
    expect(rules("server/x.ts", "await db.query.apiSpecs.findMany();")).toHaveLength(1);
    expect(rules("server/x.ts", 'await db.execute(sql`select * from "api_specs"`);')).toHaveLength(
      1,
    );
    expect(rules("server/sync/persist.ts", named)).toEqual([]);
    expect(rules("server/queries/x.ts", named)).toEqual([]);
  });

  it("keeps UI code away from the database layer and components away from data access", () => {
    expect(
      rules("app/x/page.tsx", `import { getDb } from "@docmyrepos/server/internal/db/client";`),
    ).toHaveLength(1);
    expect(
      rules(
        "app/x/page.tsx",
        `import type { Heading } from "@docmyrepos/server/internal/db/schema";`,
      ),
    ).toHaveLength(1);
    expect(
      rules(
        "app/x/page.tsx",
        `import { getRepo } from "@docmyrepos/server/internal/queries/index";`,
      ),
    ).toEqual([]);
    expect(
      rules(
        "components/x.tsx",
        `import { getRepo } from "@docmyrepos/server/internal/queries/index";`,
      ),
    ).toHaveLength(1);
    expect(
      rules(
        "components/x.tsx",
        `import { getRuntime } from "@docmyrepos/server/internal/runtime";`,
      ),
    ).toHaveLength(1);
    expect(
      rules("lib/x.ts", `import { listRepos } from "@docmyrepos/server/internal/queries/repos";`),
    ).toHaveLength(1);
  });

  it("allows the allow-listed modules and forbids re-exporting the tables anywhere", () => {
    const text = `import { repos } from "../db/schema";\nsql\`select * from repos\`;`;
    expect(rules("server/queries/x.ts", text)).toEqual([]);
    expect(rules("server/sync/x.ts", text)).toEqual([]);
    expect(rules("server/webhooks/store.ts", text)).toEqual([]);
    expect(rules("server/webhooks/router.ts", text)).toHaveLength(2);
    expect(rules("server/comments/x.ts", text)).toEqual([]);
    expect(rules("server/queries/x.ts", `export { repos } from "../db/schema";`)).toEqual([
      "re-exports the repos table",
    ]);
    expect(rules("server/sync/x.ts", `export * from "../db/schema";`)).toEqual([
      "re-exports the schema",
    ]);
    expect(rules("server/db/schema.ts", `export { repos };`)).toEqual([]);
  });
});
