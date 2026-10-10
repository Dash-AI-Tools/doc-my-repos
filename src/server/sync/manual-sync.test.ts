import { describe, expect, it, vi } from "vitest";

import { ConfigError } from "../config/load";
import type { SyncRepoResult } from "../db/schema";
import { captureOutput, recordingLogger } from "../test-logger";
import type { SyncAllResult, SyncOneResult, SyncOneTarget } from "./engine";
import {
  MAX_BODY_BYTES,
  fromRequestSync,
  handleManualSync,
  methodNotAllowed,
  type ManualSyncDeps,
  type ManualSyncOneResult,
  type ManualSyncService,
} from "./manual-sync";
import { REPO_BUSY_MESSAGE, type RunStats, type SyncErrorInfo } from "./runs";

const SECRET = "SENTINEL-sync-secret-4f9a1c7e";
const TOKEN = "ghs_SENTINELinstallationToken";
const NOW = Date.parse("2026-10-10T12:00:00Z");

// ---------------------------------------------------------------------------------------------
// Fixtures

function entry(over: Partial<SyncRepoResult> = {}): SyncRepoResult {
  return {
    repo: "acme/handbook",
    githubId: 101,
    status: "ok",
    error: null,
    errorKind: null,
    retryable: false,
    retryAfter: null,
    added: 3,
    updated: 1,
    identical: 2,
    removed: 0,
    skipped: 0,
    skippedFiles: [{ path: "docs/secret-path.md", reason: "too_large" }],
    failedFiles: [],
    failedFilesTotal: 0,
    warnings: [],
    warningsTotal: 0,
    replacedRepos: [],
    ...over,
  } as SyncRepoResult;
}

const STATS = { reposTotal: 1, reposOk: 1, docsAdded: 3 } as unknown as RunStats;

function ranRun(status: "success" | "partial" | "failed", entries: SyncRepoResult[]) {
  return {
    ran: true as const,
    runId: 7,
    value: entries,
    written: true,
    status,
    stats: STATS,
    durationMs: 42,
  };
}

function allResult(
  status: "success" | "partial" | "failed",
  entries: SyncRepoResult[],
  fatal: SyncErrorInfo | null = null,
): SyncAllResult {
  return {
    run: ranRun(status, entries),
    discovery: null,
    discoveredGithubIds: [],
    removals: [],
    drained: [],
    fatal,
  };
}

function oneResult(
  status: "success" | "partial" | "failed",
  result: SyncRepoResult | null,
): SyncOneResult {
  return {
    status: "synced",
    run: ranRun(status, result === null ? [] : [result]),
    repo: {} as never,
    result,
    discovery: {} as never,
  };
}

function info(over: Partial<SyncErrorInfo> = {}): SyncErrorInfo {
  return {
    kind: "installation_unavailable",
    message: "GitHub App installation unavailable",
    retryable: true,
    retryAt: null,
    fatal: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// Harness

function harness(
  over: { all?: SyncAllResult; one?: ManualSyncOneResult; secret?: string | null } = {},
) {
  const service = {
    syncAll: vi.fn<ManualSyncService["syncAll"]>(async () => over.all ?? allResult("success", [])),
    syncOne: vi.fn<ManualSyncService["syncOne"]>(
      async () => over.one ?? oneResult("success", entry()),
    ),
  };
  const logs = recordingLogger();
  const deps = {
    readSecret: vi.fn(() => (over.secret === undefined ? SECRET : over.secret)),
    getService: vi.fn(() => service),
    now: () => NOW,
    log: logs.log,
  } satisfies ManualSyncDeps;
  return { service, deps, logs };
}

type H = ReturnType<typeof harness>;

function post(
  body?: BodyInit | null,
  headers: Record<string, string> = {},
  url = "http://x/api/sync",
) {
  return new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, ...headers },
    body: body ?? null,
  });
}

async function call(h: H, request: Request) {
  const response = await handleManualSync(request, h.deps);
  const text = await response.text();
  return { response, text, json: JSON.parse(text) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function untouched(h: H) {
  expect(h.service.syncAll).not.toHaveBeenCalled();
  expect(h.service.syncOne).not.toHaveBeenCalled();
  expect(h.deps.getService).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------------------------

describe("authorized requests", () => {
  it("syncs everything for an empty body and summarizes per repository", async () => {
    const h = harness({
      all: allResult("partial", [
        entry(),
        entry({
          repo: "acme/metrics",
          githubId: 202,
          status: "error",
          error: "GitHub rejected a request",
          errorKind: "client_error",
        }),
      ]),
    });
    const { response, json } = await call(h, post());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.service.syncAll).toHaveBeenCalledExactlyOnceWith({ trigger: "manual" });
    expect(h.service.syncOne).not.toHaveBeenCalled();
    expect(json).toMatchObject({
      ok: true,
      scope: "all",
      run: { id: 7, status: "partial", durationMs: 42, stats: STATS },
    });
    expect(json.repositories).toHaveLength(2);
    expect(json.repositories[0]).toEqual({
      repo: "acme/handbook",
      githubId: 101,
      status: "ok",
      error: null,
      errorKind: null,
      retryable: false,
      retryAfter: null,
      added: 3,
      updated: 1,
      identical: 2,
      removed: 0,
      skipped: 0,
      failedFilesTotal: 0,
      warningsTotal: 0,
    });
    expect(json.repositories[1]).toMatchObject({
      status: "error",
      error: "GitHub rejected a request",
      errorKind: "client_error",
    });
  });

  it.each([
    ["whitespace", "  \n"],
    ["an empty object", "{}"],
  ])("syncs everything for %s", async (_name, body) => {
    const h = harness();
    expect((await call(h, post(body))).response.status).toBe(200);
    expect(h.service.syncAll).toHaveBeenCalledOnce();
  });

  it("accepts the lowercase bearer scheme", async () => {
    const h = harness();
    const request = post(null, { authorization: `bearer ${SECRET}` });
    expect((await call(h, request)).response.status).toBe(200);
  });

  it.each<[string, string, SyncOneTarget]>([
    ["a name", '{"repo":"handbook"}', { name: "handbook" }],
    ["owner/name", '{"repo":"acme/Hand.book_1-x"}', { owner: "acme", name: "Hand.book_1-x" }],
    ["a GitHub id", '{"githubId":101}', { githubId: 101 }],
  ])("syncs one repository by %s", async (_name, body, target) => {
    const h = harness();
    const { response, json } = await call(h, post(body, { "content-type": "application/json" }));
    expect(response.status).toBe(200);
    expect(h.service.syncOne).toHaveBeenCalledExactlyOnceWith(target, { trigger: "manual" });
    expect(h.service.syncAll).not.toHaveBeenCalled();
    expect(json).toMatchObject({ ok: true, scope: "repo", run: { status: "success" } });
    expect(json.repositories).toHaveLength(1);
  });

  it("answers 404 for an unknown repository and for one that is not selected", async () => {
    const unknown = harness({
      one: { status: "not_found", discovery: {} as never },
    });
    const a = await call(unknown, post('{"repo":"nope"}'));
    expect(a.response.status).toBe(404);
    expect(a.json).toMatchObject({ ok: false, error: "repository_not_found" });

    for (const reason of ["excluded", "archived", "not_listed"] as const) {
      const h = harness({
        one: { status: "not_configured", reason, discovery: {} as never },
      });
      const b = await call(h, post('{"githubId":5}'));
      expect(b.response.status).toBe(404);
      expect(b.json).toMatchObject({ error: "repository_not_configured", reason });
    }
  });
});

describe("unauthorized requests", () => {
  const cases: [string, Record<string, string>][] = [
    ["a missing header", { authorization: "" }],
    ["a wrong secret", { authorization: "Bearer wrong-wrong-wrong-wrong" }],
    ["a prefix of the secret", { authorization: `Bearer ${SECRET.slice(0, -1)}` }],
    ["the bare secret", { authorization: SECRET }],
    ["another scheme", { authorization: `Basic ${SECRET}` }],
    ["a doubled space", { authorization: `Bearer  ${SECRET}` }],
    ["an empty bearer", { authorization: "Bearer " }],
    ["the secret in another header", { authorization: "", "x-sync-secret": SECRET }],
  ];

  async function unauthorized(headers: Record<string, string>, body?: BodyInit, url?: string) {
    const h = harness();
    const request = new Request(url ?? "http://x/api/sync", {
      method: "POST",
      headers: Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== "")),
      body: body ?? null,
    });
    return { h, ...(await call(h, request)) };
  }

  it.each(cases)("rejects %s with 401 and syncs nothing", async (_name, headers) => {
    const { h, response, text } = await unauthorized(headers);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(text).toBe('{"error":"unauthorized"}');
    untouched(h);
  });

  it("gives missing and wrong secrets the same response (no oracle)", async () => {
    const missing = await unauthorized({});
    const wrong = await unauthorized({ authorization: `Bearer ${SECRET}x` });
    expect(missing.text).toBe(wrong.text);
    expect(missing.response.status).toBe(wrong.response.status);
    expect([...missing.response.headers]).toEqual([...wrong.response.headers]);
  });

  it("ignores a secret in the query string or the body", async () => {
    const q = await unauthorized(
      {},
      undefined,
      `http://x/api/sync?secret=${SECRET}&token=${SECRET}`,
    );
    expect(q.response.status).toBe(401);
    untouched(q.h);
    const b = await unauthorized({}, JSON.stringify({ secret: SECRET }));
    expect(b.response.status).toBe(401);
    untouched(b.h);
  });

  it("authenticates before reading the body", async () => {
    const h = harness();
    const request = new Request("http://x/api/sync", { method: "POST", body: "{not json" });
    const touched = vi.fn();
    Object.defineProperty(request, "body", { get: () => (touched(), null) });
    for (const method of ["text", "json", "arrayBuffer", "formData", "blob"] as const) {
      Object.defineProperty(request, method, { value: touched });
    }
    const { response } = await call(h, request);
    expect(response.status).toBe(401);
    expect(touched).not.toHaveBeenCalled();
    untouched(h);
  });

  it("answers 401 before 400 or 413 when both apply", async () => {
    const bad = await unauthorized({}, "{not json");
    expect(bad.response.status).toBe(401);
    const big = await unauthorized({}, "x".repeat(MAX_BODY_BYTES + 1));
    expect(big.response.status).toBe(401);
  });

  it("fails closed with a fixed 500 when no usable secret is configured", async () => {
    for (const secret of [null]) {
      const h = harness({ secret });
      const { response, json, text } = await call(h, post());
      expect(response.status).toBe(500);
      expect(json.error).toBe("misconfigured");
      expect(text).not.toContain(SECRET);
      untouched(h);
    }
  });
});

describe("invalid bodies (after authentication)", () => {
  const invalid: [string, BodyInit][] = [
    ["invalid JSON", "{not json"],
    ["truncated JSON", '{"repo":'],
    ["a JSON null", "null"],
    ["a JSON array", '["handbook"]'],
    ["a JSON string", '"handbook"'],
    ["an unknown key", '{"repo":"handbook","force":true}'],
    ["an unknown key alone", '{"all":true}'],
    ["repo and githubId together", '{"repo":"handbook","githubId":1}'],
    ["a non-string repo", '{"repo":5}'],
    ["a null repo", '{"repo":null}'],
    ["an empty repo", '{"repo":""}'],
    ["a blank repo", '{"repo":"  "}'],
    ["a repo with three parts", '{"repo":"a/b/c"}'],
    ["a repo with an empty owner", '{"repo":"/b"}'],
    ["a repo with a traversal", '{"repo":"../x"}'],
    ["a repo with spaces", '{"repo":"a b"}'],
    ["a repo with a query", '{"repo":"a?b"}'],
    ["a string githubId", '{"githubId":"101"}'],
    ["a zero githubId", '{"githubId":0}'],
    ["a negative githubId", '{"githubId":-1}'],
    ["a fractional githubId", '{"githubId":1.5}'],
    ["an unsafe githubId", '{"githubId":9007199254740993}'],
    ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
  ];

  it.each(invalid)("rejects %s with 400", async (_name, body) => {
    const h = harness();
    const { response, json, text } = await call(h, post(body));
    expect(response.status).toBe(400);
    expect(json.error).toBe("invalid_request");
    expect(text).not.toContain(SECRET);
    untouched(h);
  });

  it("caps the body: 413 by declared length and by streamed size", async () => {
    const declared = harness();
    const a = await call(declared, post("{}", { "content-length": String(MAX_BODY_BYTES + 1) }));
    expect(a.response.status).toBe(413);
    untouched(declared);

    const streamed = harness();
    const b = await call(streamed, post(JSON.stringify({ repo: "a".repeat(MAX_BODY_BYTES) })));
    expect(b.response.status).toBe(413);
    untouched(streamed);

    const exact = harness();
    const pad = " ".repeat(MAX_BODY_BYTES - 2);
    expect((await call(exact, post(`{}${pad}`))).response.status).toBe(200);
  });
});

describe("outcome mapping", () => {
  it("answers 202 when the request was coalesced into a running sync (task 6.4)", async () => {
    const one = harness({ one: { status: "coalesced" } });
    const a = await call(one, post('{"repo":"handbook"}'));
    expect(a.response.status).toBe(202);
    expect(a.json).toEqual({
      ok: true,
      scope: "repo",
      status: "coalesced",
      message: "A sync is already running; it will sync again to include this request.",
    });

    // Every repository busy in a full sync: each was marked and its holder reruns.
    const busy = entry({ status: "skipped", error: REPO_BUSY_MESSAGE, added: 0 });
    const all = harness({ all: allResult("success", [busy, { ...busy, githubId: 2 }]) });
    const b = await call(all, post());
    expect(b.response.status).toBe(202);
    expect(b.json).toMatchObject({
      ok: true,
      status: "coalesced",
      repositories: [{ status: "skipped" }, { status: "skipped" }],
    });
  });

  it("answers 409 when a never-synced repository could not take the request", async () => {
    const one = harness({ one: { status: "busy" } });
    const a = await call(one, post('{"githubId":7}'));
    expect(a.response.status).toBe(409);
    expect(a.json).toMatchObject({ ok: false, error: "repository_busy" });

    // A busy entry from a single run (no longer produced by requestSync) still maps to 409.
    const busy = entry({ status: "skipped", error: REPO_BUSY_MESSAGE, added: 0 });
    const legacy = harness({ one: oneResult("success", busy) });
    expect((await call(legacy, post('{"repo":"handbook"}'))).response.status).toBe(409);
  });

  it("keeps 200 when only some repositories were busy", async () => {
    const busy = entry({ status: "skipped", error: REPO_BUSY_MESSAGE });
    const h = harness({ all: allResult("success", [entry(), busy]) });
    const { response, json } = await call(h, post());
    expect(response.status).toBe(200);
    expect(json.repositories.map((r: { status: string }) => r.status)).toEqual(["ok", "skipped"]);
  });

  it("answers 200 for success with no repositories and for unchanged repositories", async () => {
    expect((await call(harness(), post())).response.status).toBe(200);
    const h = harness({ all: allResult("success", [entry({ status: "unchanged" })]) });
    expect((await call(h, post())).response.status).toBe(200);
  });

  it("answers 503 with Retry-After when GitHub rate-limited the run", async () => {
    const fatal = info({
      kind: "rate_limited",
      message: "GitHub rate limit exhausted; retry after 2026-10-10T12:01:30.000Z",
      retryAt: NOW + 90_000,
    });
    const h = harness({
      all: allResult("failed", [entry({ status: "skipped", error: fatal.message })], fatal),
    });
    const { response, json, text } = await call(h, post());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("90");
    expect(json).toMatchObject({
      ok: false,
      error: { kind: "rate_limited", retryable: true },
    });
    expect(text).not.toContain(SECRET);
  });

  it("takes Retry-After from per-repository retry times and caps it at an hour", async () => {
    const soon = entry({
      status: "error",
      retryable: true,
      retryAfter: new Date(NOW + 20_000).toISOString(),
    });
    const later = entry({
      status: "error",
      retryable: true,
      retryAfter: new Date(NOW + 10 * 3600_000).toISOString(),
    });
    const a = await call(harness({ all: allResult("failed", [soon]) }), post());
    expect(a.response.headers.get("retry-after")).toBe("20");
    const b = await call(harness({ all: allResult("failed", [soon, later]) }), post());
    expect(b.response.headers.get("retry-after")).toBe("3600");
  });

  it("answers 503 for retryable failures and 502 for others", async () => {
    const retryable = harness({ all: allResult("failed", [], info()) });
    const a = await call(retryable, post());
    expect(a.response.status).toBe(503);
    expect(a.response.headers.get("retry-after")).toBeNull();

    const hard = harness({
      all: allResult(
        "failed",
        [],
        info({
          kind: "app_credentials",
          message: "GitHub App credentials rejected (check the App id and private key)",
          retryable: false,
        }),
      ),
    });
    const b = await call(hard, post());
    expect(b.response.status).toBe(502);
    expect(b.json.error.kind).toBe("app_credentials");

    const repoFail = harness({
      all: allResult("failed", [
        entry({ status: "error", error: "tree truncated", errorKind: "tree_truncated" }),
      ]),
    });
    expect((await call(repoFail, post())).response.status).toBe(502);
  });

  it("maps a single-repository failure and a failed listing", async () => {
    const failed = entry({ status: "error", error: "network error", retryable: true });
    const a = await call(harness({ one: oneResult("failed", failed) }), post('{"repo":"x"}'));
    expect(a.response.status).toBe(503);
    expect(a.json).toMatchObject({ ok: false, repositories: [{ status: "error" }] });

    const rate = info({ kind: "rate_limited", retryAt: NOW + 5_000 });
    const listing: SyncOneResult = {
      status: "discovery_failed",
      run: ranRun("failed", []),
      error: rate,
      discovery: {} as never,
    };
    const b = await call(harness({ one: listing }), post('{"githubId":3}'));
    expect(b.response.status).toBe(503);
    expect(b.response.headers.get("retry-after")).toBe("5");
  });

  it("answers 503 when the run could not start", async () => {
    for (const reason of ["lock_failed", "reaped", "aborted"] as const) {
      const all = harness({
        all: { ...allResult("success", []), run: { ran: false, runId: 1, reason } },
      });
      const a = await call(all, post());
      expect(a.response.status).toBe(503);
      expect(a.response.headers.get("retry-after")).toBe("5");
      expect(a.json).toMatchObject({ error: "sync_not_started", reason });
    }
    const one = harness({
      one: {
        ...oneResult("success", entry()),
        run: { ran: false, runId: 1, reason: "lock_failed" },
      } as SyncOneResult,
    });
    expect((await call(one, post('{"repo":"x"}'))).response.status).toBe(503);
  });
});

describe("errors never leak", () => {
  it("answers 500 with a fixed body for a configuration error and logs only problem names", async () => {
    const h = harness();
    h.deps.getService.mockImplementation(() => {
      throw new ConfigError([
        "SYNC_SECRET: must be at least 16 characters",
        "docmyrepos.config.yml: repos.0: is not a string",
      ]);
    });
    const { response, json, text } = await call(h, post());
    expect(response.status).toBe(500);
    expect(json.error).toBe("misconfigured");
    expect(text).not.toContain("SYNC_SECRET");
    expect(text).not.toContain("docmyrepos.config.yml");
    expect(h.service.syncAll).not.toHaveBeenCalled();
    expect(h.logs.find("sync_api.config_invalid")).toEqual([
      expect.objectContaining({
        level: "error",
        problems: [
          "SYNC_SECRET: must be at least 16 characters",
          "docmyrepos.config.yml: repos.0: is not a string",
        ],
      }),
    ]);
  });

  it("answers 500 with a fixed body when the sync throws, without echoing the error", async () => {
    const h = harness();
    const leaky = new Error(
      `connect failed postgres://app:${SECRET}@db/x with token ${TOKEN} and key -----BEGIN PRIVATE KEY-----`,
    );
    h.service.syncAll.mockRejectedValue(leaky);
    const { response, json, text } = await call(h, post());
    expect(response.status).toBe(500);
    expect(json.error).toBe("internal_error");
    const printed = [text, ...h.logs.lines].join("\n");
    for (const secret of [SECRET, TOKEN, "BEGIN PRIVATE KEY", "postgres://"]) {
      expect(printed).not.toContain(secret);
    }
    expect(h.logs.find("sync_api.failed")).toEqual([
      expect.objectContaining({ level: "error", reason: "unexpected", errorName: "Error" }),
    ]);
  });

  it("never logs or returns the secret or a token on any path", async () => {
    const output = captureOutput();
    try {
      const texts: string[] = [];
      const run = async (h: H, request: Request) => texts.push((await call(h, request)).text);
      await run(harness(), post());
      await run(harness(), post('{"repo":"handbook"}'));
      await run(harness(), post(null, { authorization: "Bearer nope-nope-nope-nope" }));
      await run(harness(), post("{bad"));
      await run(harness({ secret: null }), post());
      const throwing = harness();
      throwing.service.syncAll.mockRejectedValue(new Error(`${SECRET} ${TOKEN}`));
      await run(throwing, post());
      const config = harness();
      config.deps.getService.mockImplementation(() => {
        throw new ConfigError(["GITHUB_APP_PRIVATE_KEY: is not a PEM private key"]);
      });
      await run(config, post());
      // Default logger: JSON lines on stdout/stderr.
      await handleManualSync(post(), {
        ...config.deps,
        log: undefined,
      });
      const printed = [...texts, output.text(), ...config.logs.lines].join("\n");
      expect(printed).not.toContain(SECRET);
      expect(printed).not.toContain(TOKEN);
      expect(output.records().map((r) => r.event)).toContain("sync_api.config_invalid");
    } finally {
      output.restore();
    }
  });
});

describe("methodNotAllowed", () => {
  it("answers 405 with Allow: POST", async () => {
    const response = methodNotAllowed();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
  });
});

describe("fromRequestSync", () => {
  it("maps requestSync results to what the handler answers", () => {
    const last = oneResult("success", entry());
    expect(fromRequestSync({ status: "done", passes: 2, result: last, handedOff: false })).toBe(
      last,
    );
    expect(fromRequestSync({ status: "coalesced", passes: 0 })).toEqual({ status: "coalesced" });
    expect(fromRequestSync({ status: "busy", passes: 0 })).toEqual({ status: "busy" });
    expect(fromRequestSync({ status: "aborted", passes: 1, result: last })).toBe(last);
    expect(fromRequestSync({ status: "aborted", passes: 0, result: null })).toEqual({
      status: "busy",
    });
  });
});
