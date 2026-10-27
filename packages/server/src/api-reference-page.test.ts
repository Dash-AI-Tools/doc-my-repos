import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadApiReference } from "./api-reference-page";
import { ConfigError } from "./config/errors";
import type { Db } from "./db/client";
import { apiSpecs, repos } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";

const NOW = new Date("2026-10-10T12:00:00Z");

function neverQueried(): Db {
  throw new Error("the database must not be queried");
}

function failingDb(error: unknown): Db {
  return {
    select() {
      throw error;
    },
  } as unknown as Db;
}

describe("loadApiReference without a database", () => {
  it("answers not_found for invalid, reserved and empty parameters without querying", async () => {
    for (const [owner, name, segments] of [
      ["search", "x", ["openapi.yaml"]],
      ["api", "sync", ["openapi.yaml"]],
      ["acme", "../etc", ["openapi.yaml"]],
      ["acme", "api", []],
      ["acme", "api", [".."]],
      ["acme", "api", ["a/b"]],
      ["acme", "api", ["a\u0000b"]],
    ] as const) {
      expect(await loadApiReference(owner, name, segments, { db: neverQueried })).toEqual({
        status: "not_found",
      });
    }
  });

  it("returns the error state for an unreachable database and logs only the kind", async () => {
    const log = vi.fn();
    const refused = Object.assign(new Error("connect to postgres://u:secret@10.1.2.3:5432/db"), {
      code: "ECONNREFUSED",
    });
    const data = await loadApiReference("acme", "api", ["openapi.yaml"], {
      db: () => failingDb(refused),
      now: () => NOW,
      log,
    });
    expect(data).toEqual({ status: "error", loadedAt: NOW });
    expect(log).toHaveBeenCalledWith("api_reference.load_failed", {
      reason: "database error (ECONNREFUSED)",
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|10\.1\.2\.3|postgres:/);
  });

  it("returns the error state when the configuration is unusable", async () => {
    const data = await loadApiReference("acme", "api", ["openapi.yaml"], {
      db: () => {
        throw new ConfigError(["SYNC_SECRET: is not set"]);
      },
      now: () => NOW,
      log: () => {},
    });
    expect(data.status).toBe("error");
  });

  it("rethrows an unexpected error for the error boundary", async () => {
    const bug = new TypeError("x is not a function");
    await expect(
      loadApiReference("acme", "api", ["openapi.yaml"], { db: () => failingDb(bug) }),
    ).rejects.toBe(bug);
  });
});

describeDb("loadApiReference on a real database", () => {
  let t: TestDatabase;

  async function insertRepo(
    name: string,
    githubId: number,
    values: Partial<typeof repos.$inferInsert> = {},
  ): Promise<number> {
    const [row] = await t.db
      .insert(repos)
      .values({
        githubId,
        owner: "acme",
        name,
        defaultBranch: "main",
        visibility: "public",
        htmlUrl: `https://github.com/acme/${name}`,
        docsPath: "docs",
        syncStatus: "ok",
        ...values,
      })
      .returning({ id: repos.id });
    if (row === undefined) throw new Error("insert failed");
    return row.id;
  }

  const specRow = (repoId: number, path: string, title: string) => ({
    repoId,
    path,
    blobSha: `sha-${path}`,
    sizeBytes: 9,
    format: "openapi" as const,
    specVersion: "3.0.3",
    title,
    apiVersion: "1.2.0",
    operationCount: 2,
    spec: { openapi: "3.0.3", info: { title, version: "1.2.0" }, paths: {} },
  });

  beforeAll(async () => {
    t = await createTestDatabase();
    const svc = await insertRepo("svc", 1);
    const hidden = await insertRepo("hidden", 2, { isAllowed: false });
    await t.db
      .insert(apiSpecs)
      .values([
        specRow(svc, "api/Openapi.yaml", "Service API"),
        specRow(svc, "we ird/#spec.json", "Odd path"),
        specRow(hidden, "openapi.yaml", "Hidden API"),
      ]);
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  const load = (owner: string, name: string, segments: string[]) =>
    loadApiReference(owner, name, segments, { db: () => t.db, now: () => NOW });

  it("returns the spec, repository and source link for a found spec", async () => {
    const data = await load("acme", "svc", ["api", "Openapi.yaml"]);
    if (data.status !== "ok") throw new Error(`expected ok, got ${data.status}`);
    expect(data.loadedAt).toEqual(NOW);
    expect(data.repo).toMatchObject({ owner: "acme", name: "svc" });
    expect(data.spec).toMatchObject({
      title: "Service API",
      apiVersion: "1.2.0",
      format: "openapi",
      specVersion: "3.0.3",
      path: "api/Openapi.yaml",
      spec: { openapi: "3.0.3", info: { title: "Service API" } },
    });
    expect(data.sourceUrl).toBe("https://github.com/acme/svc/blob/main/api/Openapi.yaml");
    expect(data.url).toBe("/acme/svc/api-reference/api/Openapi.yaml");
  });

  it("encodes odd characters in the page URL and the source link", async () => {
    const data = await load("acme", "svc", ["we ird", "#spec.json"]);
    if (data.status !== "ok") throw new Error(`expected ok, got ${data.status}`);
    expect(data.url).toBe("/acme/svc/api-reference/we%20ird/%23spec.json");
    expect(data.sourceUrl).toBe("https://github.com/acme/svc/blob/main/we%20ird/%23spec.json");
  });

  it("redirects to the canonical spelling of owner, repository and path", async () => {
    expect(await load("ACME", "Svc", ["api", "Openapi.yaml"])).toEqual({
      status: "redirect",
      to: "/acme/svc/api-reference/api/Openapi.yaml",
    });
    expect(await load("acme", "svc", ["API", "openapi.YAML"])).toEqual({
      status: "redirect",
      to: "/acme/svc/api-reference/api/Openapi.yaml",
    });
  });

  it("answers not_found for a hidden repository, an unknown path and an unknown repository", async () => {
    expect(await load("acme", "hidden", ["openapi.yaml"])).toEqual({ status: "not_found" });
    expect(await load("acme", "svc", ["nope.yaml"])).toEqual({ status: "not_found" });
    expect(await load("acme", "svc", ["openapi.yaml"])).toEqual({ status: "not_found" });
    expect(await load("acme", "missing", ["openapi.yaml"])).toEqual({ status: "not_found" });
  });
});
