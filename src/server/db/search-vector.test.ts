import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getTableConfig, IndexedColumn, type PgColumn } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vitest";

import { documents, SEARCH_TEXT_CONFIG, type Heading } from "./schema";

const drizzleDir = fileURLToPath(new URL("../../../drizzle/", import.meta.url));

type JournalEntry = { idx: number; tag: string };

function migrations(): { idx: number; tag: string; sql: string }[] {
  const journal = JSON.parse(readFileSync(`${drizzleDir}meta/_journal.json`, "utf8")) as {
    entries: JournalEntry[];
  };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => ({ ...e, sql: stripComments(readFileSync(`${drizzleDir}${e.tag}.sql`, "utf8")) }));
}

// Drop `--` line comments (including drizzle's statement breakpoints) so only SQL is checked.
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function searchVectorColumn(): PgColumn {
  const col = getTableConfig(documents).columns.find((c) => c.name === "search_vector");
  if (!col) throw new Error("missing column search_vector");
  return col;
}

function indexByName(name: string) {
  const index = getTableConfig(documents).indexes.find((i) => i.config.name === name);
  if (!index) throw new Error(`missing index ${name}`);
  return index.config;
}

function indexColumnNames(columns: unknown[]): string[] {
  return columns.map((c) => {
    if (!(c instanceof IndexedColumn)) throw new Error("expected a plain column in the index");
    return c.name ?? "";
  });
}

// Every GENERATED ALWAYS AS (...) STORED expression across the migration chain.
function generatedExpressions(sql: string): string[] {
  return [...sql.matchAll(/GENERATED ALWAYS AS \((.*?)\) STORED/gs)].map((m) => m[1] ?? "");
}

const WRAPPER = "docmyrepos_immutable_array_to_string";

describe("documents.search_vector", () => {
  it("is a tsvector column generated always by Postgres", () => {
    const col = searchVectorColumn();
    expect(col.getSQLType()).toBe("tsvector");
    expect(col.notNull).toBe(true);
    expect(col.generated?.type).toBe("always");
  });

  it("cannot be written through Drizzle inserts but is readable", () => {
    expectTypeOf<typeof documents.$inferInsert>().not.toHaveProperty("searchVector");
    expectTypeOf<typeof documents.$inferSelect>().toHaveProperty("searchVector");
  });

  it("has a GIN index on the vector", () => {
    const config = indexByName("documents_search_vector_idx");
    expect(config.method).toBe("gin");
    expect(indexColumnNames(config.columns)).toEqual(["search_vector"]);
  });

  it("has a btree index on (repo_id, type)", () => {
    const config = indexByName("documents_repo_id_type_idx");
    expect(config.method).toBe("btree");
    expect(indexColumnNames(config.columns)).toEqual(["repo_id", "type"]);
  });

  it("indexes no other documents columns", () => {
    expect(
      getTableConfig(documents)
        .indexes.map((i) => i.config.name)
        .sort(),
    ).toEqual(["documents_repo_id_type_idx", "documents_search_vector_idx"]);
  });

  it("uses the language-neutral simple config", () => {
    expect(SEARCH_TEXT_CONFIG).toBe("simple");
  });
});

describe("search_vector migrations", () => {
  const chain = migrations();
  const all = chain.map((m) => m.sql).join("\n");
  const expressions = generatedExpressions(all);

  it("defines exactly one generated expression, for search_vector", () => {
    expect(expressions).toHaveLength(1);
    expect(all).toMatch(/ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS/);
  });

  it("creates the immutable wrapper before the migration that uses it", () => {
    const definedIn = chain.findIndex((m) =>
      new RegExp(`CREATE FUNCTION "public"\\."${WRAPPER}"\\(text\\[\\], text\\)`).test(m.sql),
    );
    const usedIn = chain.findIndex((m) => generatedExpressions(m.sql).length > 0);
    expect(definedIn).toBeGreaterThanOrEqual(0);
    expect(usedIn).toBeGreaterThan(definedIn);
  });

  it("declares the wrapper IMMUTABLE and PARALLEL SAFE for text[] only", () => {
    const fn = chain
      .map((m) => m.sql)
      .find((s) => s.includes(`CREATE FUNCTION "public"."${WRAPPER}"`));
    expect(fn).toMatch(/\bIMMUTABLE\b/);
    expect(fn).toMatch(/\bPARALLEL SAFE\b/);
    expect(fn).toMatch(/LANGUAGE sql/);
    expect(fn).not.toMatch(/anyarray/);
  });

  it("never calls array_to_string directly in a generated expression", () => {
    for (const expr of expressions) {
      expect(expr).toContain(`public.${WRAPPER}("tags", ' ')`);
      expect(expr).not.toMatch(/(?<![\w.])array_to_string\(/);
    }
  });

  it("passes the regconfig explicitly to every tsvector function", () => {
    for (const expr of expressions) {
      // to_tsvector(text) without a regconfig is only STABLE and would follow the server's
      // default_text_search_config; the explicit two-argument form is IMMUTABLE.
      const calls = expr.match(/\b(?:jsonb_)?to_tsvector\(/g) ?? [];
      const configured =
        expr.match(
          new RegExp(`\\b(?:jsonb_)?to_tsvector\\('${SEARCH_TEXT_CONFIG}'::regconfig,`, "g"),
        ) ?? [];
      expect(calls.length).toBe(5);
      expect(configured.length).toBe(calls.length);
    }
  });

  it("weights title A, headings B, description and tags C, body D", () => {
    const [expr = ""] = expressions;
    expect(expr).toContain(`coalesce("title", '')), 'A')`);
    expect(expr).toMatch(/jsonb_path_query_array\(coalesce\("headings".*?\), 'B'\)/);
    expect(expr).toContain(`coalesce("description", '')), 'C')`);
    expect(expr).toContain(`("tags", ' '), '')), 'C')`);
    expect(expr).toContain(`coalesce("body", '')), 'D')`);
  });

  it("indexes the text key of the stored heading objects", () => {
    // Fails to compile if Heading loses or renames `text`, which the jsonpath depends on.
    const key: keyof Heading = "text";
    const sample: Heading = { depth: 2, text: "Install", slug: "install" };
    expect(sample[key]).toBe("Install");
    const [expr = ""] = expressions;
    expect(expr).toContain(`'$[*].${key}'`);
  });
});
