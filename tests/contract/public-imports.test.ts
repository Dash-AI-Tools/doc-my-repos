import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { walkFiles } from "../support/repo-files";

/**
 * The contract suite proves the core can be extended through its public API alone, so none of
 * its files may import anything else of the core: no `internal` entrypoint, no file of a
 * package by path and nothing from the open-source app.
 */
const SUITE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SUITE, "../..");

/**
 * Shared helpers the suite may import: they stand in for the outside world (GitHub, a model
 * provider, the file tree), and are held to the same rule.
 */
const SHARED = ["repo-files", "fake-github", "fake-provider"].map((name) =>
  join("tests", "support", name),
);

export const PUBLIC_ENTRYPOINTS = [
  /^@docmyrepos\/core$/,
  /^@docmyrepos\/server$/,
  /^@docmyrepos\/server\/(proxy|next|migrate)$/,
  /^@docmyrepos\/ui$/,
  /^@docmyrepos\/ui\/pages\/[a-z0-9-]+$/,
  /^@docmyrepos\/ui\/styles\.css$/,
];

/** The problems of one file's imports: non-public core entrypoints and paths out of the suite. */
export function importProblems(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  const check = (spec: string) => {
    if (spec.startsWith("@docmyrepos/")) {
      if (!PUBLIC_ENTRYPOINTS.some((re) => re.test(spec))) problems.push(`${spec} is not public`);
    } else if (spec.startsWith("@/")) {
      problems.push(`${spec} is the open-source app`);
    } else if (spec.startsWith(".")) {
      const target = relative(REPO, resolve(dirname(file), spec));
      const inSuite = !relative(SUITE, resolve(dirname(file), spec)).startsWith("..");
      if (!inSuite && !SHARED.includes(target)) {
        problems.push(`${spec} leaves the contract suite`);
      }
    }
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      check(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isPropertyAccessExpression(node.expression) &&
          /^(mock|doMock|importActual)$/.test(node.expression.name.text))) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      check(node.arguments[0].text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteral(literal)) check(literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

describe("the contract suite uses the public API only", () => {
  const files = [
    ...walkFiles(SUITE).filter((f) => /\.tsx?$/.test(f)),
    ...SHARED.map((path) => join(REPO, `${path}.ts`)),
  ];

  it("finds its files", () => {
    expect(files.length).toBeGreaterThan(2);
  });

  it("imports no internal entrypoint, package file or app module", () => {
    const problems = files.flatMap((file) =>
      importProblems(file, readFileSync(file, "utf8")).map((p) => `${relative(REPO, file)}: ${p}`),
    );
    expect(problems).toEqual([]);
  });

  it("would catch each kind of forbidden import", () => {
    const file = join(SUITE, "probe.test.ts");
    expect(
      importProblems(
        file,
        [
          'import { getDb } from "@docmyrepos/server/internal/db/client";',
          'import { app } from "@/docmyrepos";',
          'import { x } from "../../packages/server/src/workspace";',
          'vi.mock("@docmyrepos/core/internal/routes");',
          'type T = import("@docmyrepos/server/internal/workspace").Workspace;',
          'import { createApp } from "@docmyrepos/server";',
          'import { createProxy } from "@docmyrepos/server/proxy";',
          'import { HomePage } from "@docmyrepos/ui/pages/home";',
          'import { host } from "./host";',
        ].join("\n"),
      ),
    ).toEqual([
      "@docmyrepos/server/internal/db/client is not public",
      "@/docmyrepos is the open-source app",
      "../../packages/server/src/workspace leaves the contract suite",
      "@docmyrepos/core/internal/routes is not public",
      "@docmyrepos/server/internal/workspace is not public",
    ]);
  });
});
