import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { HIGHLIGHT_END, HIGHLIGHT_START } from "@docmyrepos/core/internal/search";

import { ConfigError } from "./config/errors";
import type { Db } from "./db/client";
import { documents, repos } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { githubPublicReposOnly } from "./queries/visibility";
import { handleSearchRequest, methodNotAllowed } from "./search-api";

const url = (query: string) => `http://localhost/api/search${query}`;
const get = (query: string, init?: RequestInit) => new Request(url(query), init);

function failingDb(error: unknown): Db {
  return {
    execute() {
      throw error;
    },
    select() {
      throw error;
    },
  } as unknown as Db;
}

function osError(code: string): Error {
  return Object.assign(new Error("connect failed to postgres://user:secret@10.1.2.3:5432/db"), {
    code,
  });
}

/** For answers that never reach the database. */
const NO_DB = () => failingDb(new Error("the database must not be used"));

const FIELDS = ["href", "isPrivate", "key", "path", "repoLabel", "section", "snippet", "title"];

describe("GET /api/search without a database", () => {
  it.each(["", "?q=", "?q=%20%20", "?q=%00%01%02", "?limit=5"])(
    "answers an empty query (%j) with no hits and never touches the database",
    async (query) => {
      const db = vi.fn(() => failingDb(new Error("must not be used")));
      const res = await handleSearchRequest(get(query), { db });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ total: 0, hits: [], seeAll: "/search" });
      expect(db).not.toHaveBeenCalled();
    },
  );

  it("sends the headers of a private, JSON, non-sniffable answer", async () => {
    for (const res of [
      await handleSearchRequest(get(""), { db: NO_DB }),
      await handleSearchRequest(get("?q=x"), {
        db: () => failingDb(osError("ECONNREFUSED")),
        log: () => {},
      }),
    ]) {
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("vary")).toMatch(/Cookie/);
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])(
    "refuses %s with 405 and Allow: GET, before reading anything",
    async (method) => {
      const db = vi.fn(() => failingDb(new Error("must not be used")));
      const res = await handleSearchRequest(
        new Request(url("?q=deployment"), { method, ...(method === "POST" ? { body: "x" } : {}) }),
        { db },
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("");
      expect(db).not.toHaveBeenCalled();
    },
  );

  it("exposes the same 405 for the route's other methods", () => {
    expect(methodNotAllowed().status).toBe(405);
    expect(methodNotAllowed().headers.get("allow")).toBe("GET");
  });

  it("answers a database failure with a fixed body and logs only the kind", async () => {
    const log = vi.fn();
    const res = await handleSearchRequest(get("?q=secret%20query%20text"), {
      db: () => failingDb(osError("ECONNREFUSED")),
      log,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(log).toHaveBeenCalledExactlyOnceWith("search_api.failed", {
      reason: "database error (ECONNREFUSED)",
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|10\.1\.2\.3|postgres:/);
  });

  it("answers a configuration failure the same way", async () => {
    const log = vi.fn();
    const res = await handleSearchRequest(get("?q=x"), {
      db: () => {
        throw new ConfigError(["SYNC_SECRET: is not set"]);
      },
      log,
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"error":"unavailable"}');
    expect(log).toHaveBeenCalledWith("search_api.failed", { reason: "ConfigError" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("SYNC_SECRET");
  });

  it("never throws: an unexpected error is a 503 and the message is not logged", async () => {
    const log = vi.fn();
    const res = await handleSearchRequest(get("?q=needle"), {
      db: () => failingDb(new TypeError("x is not a function, needle")),
      log,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(log).toHaveBeenCalledExactlyOnceWith("search_api.failed", {
      reason: "unexpected error",
    });
  });

  it("survives a logger that throws", async () => {
    const res = await handleSearchRequest(get("?q=x"), {
      db: () => failingDb(osError("ECONNREFUSED")),
      log: () => {
        throw new Error("disk full");
      },
    });
    expect(res.status).toBe(503);
  });

  it("does no work for a request the client already abandoned", async () => {
    const db = vi.fn(() => failingDb(new Error("must not be used")));
    const res = await handleSearchRequest(get("?q=deployment", { signal: AbortSignal.abort() }), {
      db,
    });
    expect(res.status).toBe(503);
    expect(db).not.toHaveBeenCalled();
  });

  it("refuses searches beyond the in-process concurrency cap, with Retry-After", async () => {
    let release: (() => void) | undefined;
    const blocked = {
      execute: () =>
        new Promise((_, reject) => {
          release = () => reject(osError("ECONNRESET"));
        }),
    } as unknown as Db;
    const log = vi.fn();
    const first = handleSearchRequest(get("?q=one"), { db: () => blocked, maxInFlight: 1, log });
    const second = await handleSearchRequest(get("?q=two"), {
      db: () => blocked,
      maxInFlight: 1,
      log,
    });
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("1");
    expect(await second.json()).toEqual({ error: "unavailable" });
    release?.();
    expect((await first).status).toBe(503);
    // the slot is free again
    const third = await handleSearchRequest(get(""), { db: NO_DB, maxInFlight: 1 });
    expect(third.status).toBe(200);
    const releaseFirst = release;
    const fourth = handleSearchRequest(get("?q=four"), { db: () => blocked, maxInFlight: 1, log });
    // The fourth search reaches the database after the source resolves: wait for its query.
    await vi.waitFor(() => expect(release).not.toBe(releaseFirst));
    release?.();
    expect((await fourth).status).toBe(503);
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describeDb("GET /api/search on a real database", () => {
  let t: TestDatabase;

  async function repo(
    githubId: number,
    owner: string,
    name: string,
    visibility: "public" | "private",
  ) {
    const [row] = await t.db
      .insert(repos)
      .values({
        githubId,
        owner,
        name,
        visibility,
        defaultBranch: "main",
        docsPath: "docs",
        htmlUrl: `https://github.com/${owner}/${name}`,
      })
      .returning({ id: repos.id });
    if (row === undefined) throw new Error("insert failed");
    return row.id;
  }

  async function doc(
    repoId: number,
    path: string,
    title: string,
    body: string,
    extra: Partial<typeof documents.$inferInsert> = {},
  ) {
    await t.db.insert(documents).values({
      repoId,
      path,
      title,
      body,
      blobSha: `sha-${path}`,
      sizeBytes: body.length,
      ...extra,
    });
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    const api = await repo(1, "acme", "api", "public");
    const secret = await repo(2, "acme", "secret", "private");
    await doc(api, "docs/deployment.md", "Deployment", "Ship it.");
    await doc(api, "docs/ops.md", "Operations", "Runbook.", {
      headings: [
        { depth: 1, text: "Operations", slug: "operations" },
        { depth: 2, text: "Deployment checks", slug: "deployment-checks" },
      ],
    });
    await doc(
      api,
      "docs/html.md",
      "Markup <b>heavy</b>",
      "# Heading\n\n<script>alert(1)</script> <img src=x onerror=alert(2)> A deployment with **bold** and [a link](http://x.test).",
    );
    await doc(secret, "docs/private.md", "Private deploys", "Every deployment is logged.");
    for (let i = 1; i <= 25; i++) {
      await doc(
        api,
        `docs/log/entry-${String(i).padStart(2, "0")}.md`,
        `Entry ${i}`,
        "The changelog says so.",
      );
    }
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const call = async (
    query: string,
    deps: Partial<Parameters<typeof handleSearchRequest>[1]> = {},
  ) => {
    const res = await handleSearchRequest(get(query), { db: () => t.db, ...deps });
    return { res, body: await res.json() };
  };

  it("returns ranked hits with only the fields a palette row shows", async () => {
    const { res, body } = await call("?q=deployment");
    expect(res.status).toBe(200);
    expect(body.q).toBe("deployment");
    expect(body.total).toBe(4);
    expect(body.seeAll).toBe("/search?q=deployment");
    expect(Object.keys(body).sort()).toEqual(["hits", "q", "seeAll", "total"]);
    expect(body.hits[0]).toMatchObject({
      title: "Deployment",
      href: "/acme/api/docs/deployment",
      repoLabel: "acme/api",
      path: "docs/deployment.md",
      isPrivate: false,
    });
    for (const hit of body.hits) expect(Object.keys(hit).sort()).toEqual(FIELDS);
    const ops = body.hits.find((h: { title: string }) => h.title === "Operations");
    expect(ops).toMatchObject({
      href: "/acme/api/docs/ops#deployment-checks",
      section: "Deployment checks",
    });
    expect(body.hits.find((h: { title: string }) => h.title === "Private deploys").isPrivate).toBe(
      true,
    );
  });

  it("clamps limit to 1..10 and defaults to 8", async () => {
    const rows = async (query: string) => (await call(query)).body.hits.length;
    expect(await rows("?q=changelog")).toBe(8);
    expect(await rows("?q=changelog&limit=3")).toBe(3);
    expect(await rows("?q=changelog&limit=10")).toBe(10);
    expect(await rows("?q=changelog&limit=100")).toBe(10);
    expect(await rows("?q=changelog&limit=0")).toBe(1);
    expect(await rows("?q=changelog&limit=abc")).toBe(8);
    expect(await rows("?q=changelog&limit=-5")).toBe(8);
    expect(await rows("?q=changelog&limit=3&limit=9")).toBe(3);
    expect((await call("?q=changelog")).body.total).toBe(25);
  });

  it("ignores paging and OKF filters, honours the repository filter", async () => {
    expect((await call("?q=changelog&page=2")).body.hits).toHaveLength(8);
    expect((await call("?q=deployment&type=Runbook&tag=x&status=y")).body.total).toBe(4);
    const secret = await call("?q=deployment&repo=ACME/Secret");
    expect(secret.body.hits.map((h: { title: string }) => h.title)).toEqual(["Private deploys"]);
    expect(secret.body.total).toBe(1);
  });

  it("answers every kind of hostile query with 200 and a list", async () => {
    for (const q of [
      '"unclosed & | ! ( ',
      ")(",
      "-",
      "OR",
      "or or or",
      "<script>alert(1)</script>",
      "%",
      "'; drop table documents; --",
      "a".repeat(5000),
      "\\",
      "*:*",
      "\u0000\u0001",
    ]) {
      const { res, body } = await call(`?q=${encodeURIComponent(q)}&repo=${encodeURIComponent(q)}`);
      expect(res.status, q.slice(0, 20)).toBe(200);
      expect(Array.isArray(body.hits), q.slice(0, 20)).toBe(true);
    }
    // a lone surrogate (invalid UTF-8 on the wire) and a malformed escape
    for (const raw of ["%ED%A0%80", "%", "%E0%A4%A", "%00"]) {
      const { res, body } = await call(`?q=${raw}&repo=${raw}`);
      expect(res.status, raw).toBe(200);
      expect(Array.isArray(body.hits), raw).toBe(true);
    }
    // the table is intact
    expect((await call("?q=deployment")).body.total).toBe(4);
  });

  it("cuts the query to 256 characters in the echo and the link", async () => {
    const { body } = await call(`?q=${"a".repeat(1000)}`);
    expect(body.q).toBe("a".repeat(256));
    expect(body.seeAll).toBe(`/search?q=${"a".repeat(256)}`);
  });

  it("records search.performed with the result count and scope, never the query", async () => {
    const events: unknown[] = [];
    const res = await handleSearchRequest(get("?q=deployment%20SENTINEL-QUERY&repo=acme/secret"), {
      db: () => t.db,
      emit: (event) => events.push(event),
    });
    expect(res.status).toBe(200);
    expect(events).toEqual([
      { name: "search.performed", payload: { resultCount: expect.any(Number), scoped: true } },
    ]);
    expect(JSON.stringify(events)).not.toContain("SENTINEL");
  });

  it("goes through the shared visibility filter (flipped, the private repo disappears)", async () => {
    const open = await call("?q=deployment");
    const flipped = await call("?q=deployment", { options: { visibility: githubPublicReposOnly } });
    expect(open.body.hits.some((h: { isPrivate: boolean }) => h.isPrivate)).toBe(true);
    expect(flipped.body.hits.some((h: { isPrivate: boolean }) => h.isPrivate)).toBe(false);
    expect(flipped.body.total).toBe(3);
    const only = await call("?q=deployment&repo=acme/secret", {
      options: { visibility: githubPublicReposOnly },
    });
    expect(only.body).toMatchObject({ total: 0, hits: [] });
  });

  it("carries no markup in snippets: only the two highlight markers", async () => {
    const { body } = await call("?q=deployment");
    expect(body.hits.length).toBeGreaterThan(0);
    const allowed = new Set([HIGHLIGHT_START, HIGHLIGHT_END]);
    for (const hit of body.hits as { snippet: string }[]) {
      expect(hit.snippet).not.toMatch(/[<>]/);
      expect(hit.snippet).not.toMatch(/\bonerror\b|alert\(/);
      for (const ch of hit.snippet) {
        if (/[-]/.test(ch)) expect(allowed.has(ch)).toBe(true);
      }
    }
    const markup = (body.hits as { title: string; snippet: string }[]).find((h) =>
      h.title.startsWith("Markup"),
    );
    expect(markup?.snippet).toContain(HIGHLIGHT_START);
  });
});
