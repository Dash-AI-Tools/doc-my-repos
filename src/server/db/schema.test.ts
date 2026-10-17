import { getTableConfig, type PgColumn } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  apiSpecs,
  apiTokens,
  askSettings,
  askUsage,
  codeOwners,
  docComments,
  documents,
  repos,
  siteBranding,
  syncRuns,
  users,
} from "./schema";

function column(table: Parameters<typeof getTableConfig>[0], name: string): PgColumn {
  const col = getTableConfig(table).columns.find((c) => c.name === name);
  if (!col) throw new Error(`missing column ${name}`);
  return col;
}

function uniques(table: Parameters<typeof getTableConfig>[0]): string[][] {
  return getTableConfig(table).uniqueConstraints.map((u) => u.columns.map((c) => c.name));
}

describe("db schema", () => {
  it("keys comments by GitHub repo id and path, with no foreign key to repos or documents", () => {
    const cfg = getTableConfig(docComments);
    expect(cfg.name).toBe("doc_comments");
    expect(
      cfg.foreignKeys
        .map((f) => f.reference().foreignTable)
        .map((t) => getTableConfig(t).name)
        .sort(),
    ).toEqual(["doc_comments", "users", "users"]);
    expect(column(docComments, "github_repo_id").notNull).toBe(true);
    expect(column(docComments, "path").notNull).toBe(true);
    expect(column(docComments, "parent_id").notNull).toBe(false);
    expect(column(docComments, "author_id").notNull).toBe(false);
    expect(column(docComments, "author_label").notNull).toBe(true);
    expect(column(docComments, "body").notNull).toBe(true);
    expect(column(docComments, "as_org").default).toBe(false);
    expect(column(docComments, "deleted_by_admin").default).toBe(false);
    expect(cfg.checks.map((c) => c.name).sort()).toEqual([
      "doc_comments_body_length",
      "doc_comments_reply_not_resolved",
    ]);
  });

  it("keeps no text column that could hold a question, answer or excerpt on ask_usage", () => {
    const textColumns = getTableConfig(askUsage)
      .columns.filter((c) => c.dataType === "string")
      .map((c) => c.name)
      .sort();
    expect(textColumns).toEqual(["outcome", "provider"]);
    expect(getTableConfig(askSettings).checks.map((c) => c.name)).toEqual([
      "ask_settings_single_row",
    ]);
    expect(column(askSettings, "enabled").default).toBe(false);
  });

  it("defines the core tables", () => {
    expect(
      [repos, documents, codeOwners, syncRuns, siteBranding].map((t) => getTableConfig(t).name),
    ).toEqual(["repos", "documents", "code_owners", "sync_runs", "site_branding"]);
  });

  it("restricts repos.visibility to public and private and requires it", () => {
    const col = column(repos, "visibility");
    expect(col.notNull).toBe(true);
    expect(col.enumValues).toEqual(["public", "private"]);
  });

  it("makes repos unique by owner/name and by GitHub id", () => {
    expect(uniques(repos)).toEqual(expect.arrayContaining([["owner", "name"], ["github_id"]]));
  });

  it("makes document paths unique per repo", () => {
    expect(uniques(documents)).toContainEqual(["repo_id", "path"]);
  });

  it("keeps documents.type free-form: nullable text, no enum", () => {
    const col = column(documents, "type");
    expect(col.dataType).toBe("string");
    expect(col.notNull).toBe(false);
    expect(col.enumValues).toBeUndefined();
    expect(column(documents, "status").enumValues).toBeUndefined();
  });

  it("stores frontmatter and headings as jsonb and tags as a text array", () => {
    expect(column(documents, "frontmatter").getSQLType()).toBe("jsonb");
    expect(column(documents, "frontmatter").notNull).toBe(true);
    expect(column(documents, "headings").getSQLType()).toBe("jsonb");
    expect(column(documents, "tags").getSQLType()).toBe("text[]");
  });

  it("stores the markdown body as required text", () => {
    const col = column(documents, "body");
    expect(col.getSQLType()).toBe("text");
    expect(col.notNull).toBe(true);
  });

  it("cascades repo deletion to documents and code owners", () => {
    for (const table of [documents, codeOwners]) {
      const fks = getTableConfig(table).foreignKeys.map((fk) => fk.reference());
      expect(fks).toHaveLength(1);
      expect(fks[0]?.foreignTable).toBe(repos);
      expect(getTableConfig(table).foreignKeys[0]?.onDelete).toBe("cascade");
    }
  });

  it("keeps API specs unique per (repo, path) and cascades repo deletion to them", () => {
    expect(uniques(apiSpecs)).toContainEqual(["repo_id", "path"]);
    const fks = getTableConfig(apiSpecs).foreignKeys;
    expect(fks).toHaveLength(1);
    expect(fks[0]?.reference().foreignTable).toBe(repos);
    expect(fks[0]?.onDelete).toBe("cascade");
    expect(column(apiSpecs, "spec").getSQLType()).toBe("jsonb");
    expect(column(apiSpecs, "spec").notNull).toBe(true);
    expect(column(apiSpecs, "api_version").notNull).toBe(false);
  });

  it("preserves code owner rule order per repo", () => {
    expect(column(codeOwners, "position").notNull).toBe(true);
    expect(uniques(codeOwners)).toContainEqual(["repo_id", "position"]);
  });

  it("keeps the tree SHA and sync state on repos", () => {
    const tree = column(repos, "tree_sha");
    expect(tree.getSQLType()).toBe("text");
    expect(tree.notNull).toBe(false);

    const status = column(repos, "sync_status");
    expect(status.notNull).toBe(true);
    expect(status.default).toBe("pending");
    expect(status.enumValues).toEqual(["pending", "ok", "error"]);

    const synced = column(repos, "last_synced_at");
    expect(synced.getSQLType()).toBe("timestamp with time zone");
    expect(synced.notNull).toBe(false);
  });

  it("keeps the selection fingerprint and branch-head state next to the tree SHA", () => {
    for (const name of ["selection_fingerprint", "head_etag", "commit_sha"]) {
      const col = column(repos, name);
      expect(col.getSQLType()).toBe("text");
      expect(col.notNull).toBe(false);
      expect(col.hasDefault).toBe(false);
    }
  });

  it("stores README and CODEOWNERS path/SHA pairs as nullable text", () => {
    for (const name of ["readme_path", "readme_sha", "codeowners_path", "codeowners_sha"]) {
      const col = column(repos, name);
      expect(col.getSQLType()).toBe("text");
      expect(col.notNull).toBe(false);
    }
  });

  it("stores the star place as a nullable integer with no default (null = not starred)", () => {
    const col = column(repos, "star_position");
    expect(col.getSQLType()).toBe("integer");
    expect(col.notNull).toBe(false);
    expect(col.hasDefault).toBe(false);
  });

  it("has no default for repos.visibility so the sync must supply it", () => {
    expect(column(repos, "visibility").hasDefault).toBe(false);
  });

  it("records trigger, timing and outcome on sync runs", () => {
    expect(column(syncRuns, "trigger").notNull).toBe(true);
    expect(column(syncRuns, "trigger").enumValues).toEqual([
      "webhook",
      "manual",
      "schedule",
      "startup",
    ]);
    expect(column(syncRuns, "started_at").notNull).toBe(true);
    expect(column(syncRuns, "finished_at").notNull).toBe(false);
  });

  it("keeps only a hash and a short prefix of an API token, unique per hash", () => {
    expect(getTableConfig(apiTokens).name).toBe("api_tokens");
    const names = getTableConfig(apiTokens).columns.map((c) => c.name);
    expect(names).toContain("token_hash");
    expect(names).toContain("prefix");
    // Nothing that could hold the token itself.
    expect(names.filter((n) => /^(token|secret|value|plain|plaintext|raw)$/.test(n))).toEqual([]);
    expect(uniques(apiTokens)).toContainEqual(["token_hash"]);
    for (const name of ["user_id", "name", "token_hash", "prefix", "expires_at", "created_at"]) {
      expect(column(apiTokens, name).notNull, name).toBe(true);
    }
    for (const name of ["revoked_at", "last_used_at"]) {
      expect(column(apiTokens, name).notNull, name).toBe(false);
    }
    expect(getTableConfig(apiTokens).checks.map((c) => c.name)).toContain("api_tokens_name_length");
  });

  it("keeps users.tokens_valid_after nullable with no default", () => {
    expect(column(users, "tokens_valid_after").notNull).toBe(false);
    expect(column(users, "tokens_valid_after").default).toBeUndefined();
  });

  it("keeps branding to one row with nullable settings and logo bytes", () => {
    expect(getTableConfig(siteBranding).name).toBe("site_branding");
    expect(column(siteBranding, "id").getSQLType()).toBe("smallint");
    for (const name of ["org_name", "page_title", "primary_color", "accent_color"]) {
      expect(column(siteBranding, name).notNull).toBe(false);
    }
    expect(column(siteBranding, "colored_header").notNull).toBe(true);
    expect(column(siteBranding, "colored_header").default).toBe(false);
    expect(column(siteBranding, "invert_logo_on_dark").notNull).toBe(true);
    expect(column(siteBranding, "invert_logo_on_dark").default).toBe(true);
    expect(column(siteBranding, "logo").getSQLType()).toBe("bytea");
    expect(column(siteBranding, "logo_version").notNull).toBe(true);
    expect(column(siteBranding, "logo_version").default).toBe(0);
    const checks = getTableConfig(siteBranding).checks.map((c) => c.name);
    expect(checks).toContain("site_branding_single_row");
  });
});
