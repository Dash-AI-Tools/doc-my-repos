import { afterAll, beforeAll, expect, it } from "vitest";

import { ConfigError } from "./config/load";
import { repos } from "./db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "./db/test-db";
import { handleHealthRequest } from "./health-api";
import { UNAVAILABLE_STATUS_BODY } from "./status-api";

const get = (init?: RequestInit) => new Request("http://localhost/api/health", init);

it("answers an unusable configuration with the same fixed 503 as /api/status", async () => {
  const res = await handleHealthRequest(get(), {
    db: () => {
      throw new ConfigError(["GITHUB_APP_ID: missing"]);
    },
    log: () => undefined,
  });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual(UNAVAILABLE_STATUS_BODY);
});

it("refuses other methods with 405", async () => {
  const res = await handleHealthRequest(get({ method: "POST" }), {
    db: () => {
      throw new Error("must not be used");
    },
  });
  expect(res.status).toBe(405);
});

describeDb("GET /api/health on a real database", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
    await t.db.insert(repos).values({
      githubId: 21,
      owner: "acme",
      name: "secret-private-repo",
      defaultBranch: "main",
      treeSha: "sentinel-tree-sha",
      selectionFingerprint: "v2:sentinel-fp",
      visibility: "private",
      htmlUrl: "https://github.com/acme/secret-private-repo",
    });
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("answers 200 with only the verdict: no repository names or counts", async () => {
    const res = await handleHealthRequest(get(), { db: () => t.db });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: "ok" });
    expect(text).not.toContain("acme");
    expect(text).not.toContain("secret-private-repo");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
