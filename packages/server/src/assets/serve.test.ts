import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { repos } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { createGitHubClient, GitHubError, type GitHubClient } from "../github/client";
import { findAssetRepo, type AssetRepo } from "../queries/assets";
import { githubPublicReposOnly } from "../queries/visibility";
import { FakeGitHub } from "../../../../tests/support/fake-github";
import {
  captureOutput,
  recordingLogger,
  type CapturedOutput,
  type RecordingLogger,
} from "../test-logger";
import { createAssetCache, type AssetCache } from "./cache";
import { createFetchGate, type FetchGate } from "./fetch-gate";
import {
  assetEtag,
  type AssetDeps,
  type AssetResponse,
  etagMatches,
  handleAssetRequest,
  serveAsset,
  type ServeAssetOptions,
} from "./serve";
import { GIF, HTML, JPEG, PNG, SVG, SVG_WITH_SCRIPT, WEBP } from "./test-images";

const TOKEN = "ghs_SENTINEL_asset_token_7c1e9b";

const REPOS: AssetRepo[] = [
  { githubId: 1, owner: "acme", name: "handbook", defaultBranch: "main", visibility: "private" },
  { githubId: 2, owner: "acme", name: "site", defaultBranch: "trunk", visibility: "public" },
  { githubId: 3, owner: "acme", name: "empty", defaultBranch: "", visibility: "public" },
  { githubId: 4, owner: "acme", name: "dropped", defaultBranch: "main", visibility: "public" },
];

function makeFake(): FakeGitHub {
  return new FakeGitHub({
    owner: "acme",
    token: TOKEN,
    repos: [
      {
        id: 1,
        name: "handbook",
        visibility: "private",
        files: {
          "docs/img/arch.png": PNG,
          "docs/img/photo.jpg": JPEG,
          "docs/img/anim.gif": GIF,
          "docs/img/pic.webp": WEBP,
          "docs/img/diagram.svg": SVG,
          "docs/img/evil.svg": SVG_WITH_SCRIPT,
          "docs/img/fake.png": HTML,
          "docs/img/svg-as.png": SVG,
          "docs/img/jpeg-as.png": JPEG,
          "docs/img/my diagram.png": PNG,
          "docs/img/big.png": new Uint8Array(4096).fill(7),
          "docs/guide.md": "# Guide",
        },
      },
      { id: 2, name: "site", files: { "docs/img/arch.png": GIF, "logo.png": PNG } },
      { id: 4, name: "dropped", files: { "a.png": PNG } },
    ],
  });
}

interface Setup {
  fake: FakeGitHub;
  github: GitHubClient;
  cache: AssetCache;
  clock: { now: number };
  getDeps: ReturnType<typeof vi.fn<() => AssetDeps | Promise<AssetDeps>>>;
  logs: RecordingLogger;
  serve(
    path: string,
    init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
    options?: ServeAssetOptions,
  ): Promise<AssetResponse>;
}

function setup(over: Partial<AssetDeps> = {}): Setup {
  const fake = makeFake();
  const github = createGitHubClient({
    getToken: fake.getToken,
    fetch: fake.fetch,
    sleep: async () => undefined,
    maxAttempts: 2,
    maxWaitMs: 1000,
  });
  const clock = { now: 1_700_000_000_000 };
  const cache = createAssetCache({ now: () => clock.now });
  const deps: AssetDeps = {
    findRepo: async (owner, name) =>
      REPOS.find(
        (r) =>
          r.owner.toLowerCase() === owner.toLowerCase() &&
          r.name.toLowerCase() === name.toLowerCase(),
      ) ?? null,
    isConfigured: (name) => name !== "dropped",
    github,
    cache,
    ...over,
  };
  const getDeps = vi.fn<() => AssetDeps | Promise<AssetDeps>>(() => deps);
  const logs = recordingLogger();
  return {
    fake,
    github,
    cache,
    clock,
    getDeps,
    logs,
    serve: (path, init = {}, options = {}) =>
      serveAsset(
        {
          method: init.method ?? "GET",
          headers: new Headers(init.headers ?? {}),
          signal: init.signal,
        },
        path.split("/"),
        getDeps,
        { log: logs.log, ...options },
      ),
  };
}

function bodyText(res: AssetResponse): string {
  if (res.body === null) return "";
  return typeof res.body === "string" ? res.body : Buffer.from(res.body).toString("latin1");
}

function expectSecurityHeaders(res: AssetResponse) {
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["content-security-policy"]).toMatch(/^default-src 'none';.*sandbox$/);
  expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
}

function contentRequests(fake: FakeGitHub) {
  return fake.requestsTo(/\/contents\//);
}

describe("serveAsset: images", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  it("serves a private repo image with verified type, nosniff, CSP and private caching", async () => {
    const res = await s.serve("acme/handbook/docs/img/arch.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-length"]).toBe(String(PNG.length));
    expect(res.headers["cache-control"]).toBe("private, max-age=300");
    expect(res.headers.etag).toBe(assetEtag(PNG));
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers.vary).toBeUndefined();
    expectSecurityHeaders(res);
    expect(Buffer.from(res.body as Uint8Array).equals(Buffer.from(PNG))).toBe(true);

    const [request] = contentRequests(s.fake);
    expect(request).toMatchObject({
      method: "GET",
      path: "/repos/acme/handbook/contents/docs/img/arch.png",
      query: "ref=main",
      authorized: true,
    });
  });

  it("serves a repo image from its default branch, never storable by a shared cache", async () => {
    // Even a repository that is public on GitHub: whether a visitor may have the image depends on
    // who they are (public access), so only the browser may keep it.
    const res = await s.serve("acme/site/logo.png");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, max-age=300");
    expect(contentRequests(s.fake)[0]?.query).toBe("ref=trunk");
  });

  it.each([
    ["docs/img/photo.jpg", "image/jpeg"],
    ["docs/img/anim.gif", "image/gif"],
    ["docs/img/pic.webp", "image/webp"],
    ["docs/img/my%20diagram.png", "image/png"],
  ])("serves %s as %s", async (path, type) => {
    const res = await s.serve(`acme/handbook/${path}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe(type);
  });

  it("matches owner and repo ignoring case and fetches the canonical name", async () => {
    const res = await s.serve("ACME/HandBook/docs/img/arch.png");
    expect(res.status).toBe(200);
    expect(contentRequests(s.fake)[0]?.path).toBe(
      "/repos/acme/handbook/contents/docs/img/arch.png",
    );
  });

  it("serves SVG as image/svg+xml in a sandbox without scripts", async () => {
    for (const path of ["docs/img/diagram.svg", "docs/img/evil.svg"]) {
      const res = await s.serve(`acme/handbook/${path}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/svg+xml");
      expect(res.headers["content-security-policy"]).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
      expect(res.headers["content-security-policy"]).not.toMatch(/script-src|unsafe-eval/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("answers HEAD with headers and no body", async () => {
    const res = await s.serve("acme/handbook/docs/img/arch.png", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-length"]).toBe(String(PNG.length));
  });
});

describe("serveAsset: refused content", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  it.each([
    "docs/guide.md",
    "index.html",
    "app.js",
    "notes.txt",
    "data.json",
    "x.svgz",
    "Makefile",
  ])("refuses %s with 415 before any lookup or upstream call", async (path) => {
    const res = await s.serve(`acme/handbook/${path}`);
    expect(res.status).toBe(415);
    expectSecurityHeaders(res);
    expect(s.getDeps).not.toHaveBeenCalled();
    expect(s.fake.requests).toEqual([]);
  });

  it.each([
    ["HTML renamed .png", "docs/img/fake.png"],
    ["SVG renamed .png", "docs/img/svg-as.png"],
    ["JPEG renamed .png", "docs/img/jpeg-as.png"],
  ])("refuses %s with 415", async (_name, path) => {
    const res = await s.serve(`acme/handbook/${path}`);
    expect(res.status).toBe(415);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(bodyText(res)).toBe("Not a supported image.");
  });

  it("refuses an image over the size cap with 413", async () => {
    const res = await s.serve("acme/handbook/docs/img/big.png", {}, { maxBytes: 1024 });
    expect(res.status).toBe(413);
  });
});

describe("serveAsset: path traversal and invalid input", () => {
  const corpus = [
    "acme/handbook/../secret.png",
    "acme/handbook/docs/../../x.png",
    "acme/handbook/%2e%2e/x.png",
    "acme/handbook/%2E%2E%2Fx.png",
    "acme/handbook/%252e%252e/x.png",
    "acme/handbook/%252e%252e%252fx.png",
    "acme/handbook/docs\\x.png",
    "acme/handbook/..%5cx.png",
    "acme/handbook/x%00.png",
    "acme/handbook/x\u0000.png",
    "acme/handbook/%ef%bc%8e%ef%bc%8e/x.png",
    "acme/handbook/%e2%80%a5/x.png",
    "acme/handbook//etc/x.png",
    "acme/handbook/docs//x.png",
    "acme/handbook/docs/",
    "acme/handbook/./x.png",
    "acme/handbook/.../x.png",
    "acme/handbook/.git/config",
    "acme/handbook/.git/x.png",
    "acme/handbook/node_modules/../x.png",
    "acme/handbook/docs%2fx.png",
    `acme/handbook/${"a/".repeat(80)}x.png`,
    `acme/handbook/${"a".repeat(1100)}.png`,
    "../acme/handbook/x.png",
    "acme/../handbook/x.png",
    "acme/%2e%2e/x.png",
    "ac%2fme/handbook/x.png",
  ];

  it.each(corpus)("refuses %j with 400 and never looks anything up", async (path) => {
    const s = setup();
    const res = await s.serve(path);
    expect(res.status).toBe(400);
    expectSecurityHeaders(res);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(bodyText(res)).toBe("Invalid asset path.");
    expect(s.getDeps).not.toHaveBeenCalled();
    expect(s.fake.requests).toEqual([]);
  });
});

describe("serveAsset: repositories", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  it("answers an unknown repo exactly like a missing file (no existence oracle)", async () => {
    const unknown = await s.serve("acme/secret-repo/docs/img/arch.png");
    const missing = await s.serve("acme/handbook/docs/img/missing.png");
    expect(unknown.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(unknown).toEqual(missing);
    // The unknown repo cost no GitHub request.
    expect(contentRequests(s.fake).map((r) => r.path)).toEqual([
      "/repos/acme/handbook/contents/docs/img/missing.png",
    ]);
  });

  it("refuses a repo the config no longer selects, without an upstream call", async () => {
    const res = await s.serve("acme/dropped/a.png");
    expect(res.status).toBe(404);
    expect(s.fake.requests).toEqual([]);
  });

  it("refuses an empty repository", async () => {
    const res = await s.serve("acme/empty/a.png");
    expect(res.status).toBe(404);
    expect(s.fake.requests).toEqual([]);
  });

  it("maps upstream 403 to 404", async () => {
    s.fake.fail({ path: /\/contents\//, status: 403 });
    expect((await s.serve("acme/handbook/docs/img/arch.png")).status).toBe(404);
  });
});

describe("serveAsset: conditional requests and cache", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  it("answers a matching If-None-Match with 304 and the cache headers", async () => {
    const etag = assetEtag(PNG);
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const res = await s.serve("acme/handbook/docs/img/arch.png", {
        headers: { "if-none-match": header },
      });
      expect(res.status).toBe(304);
      expect(res.body).toBeNull();
      expect(res.headers.etag).toBe(etag);
      expect(res.headers["cache-control"]).toBe("private, max-age=300");
      expectSecurityHeaders(res);
    }
    const other = await s.serve("acme/handbook/docs/img/arch.png", {
      headers: { "if-none-match": '"different"' },
    });
    expect(other.status).toBe(200);
  });

  it("never sends the browser's conditional headers upstream", async () => {
    const original = s.fake.fetch;
    const seen: Headers[] = [];
    const github = createGitHubClient({
      getToken: s.fake.getToken,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return original(input, init);
      }) as typeof fetch,
    });
    const t = setup({ github, cache: null });
    await t.serve("acme/handbook/docs/img/arch.png", {
      headers: { "if-none-match": '"x"', cookie: "session=abc", authorization: "Bearer user" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.get("if-none-match")).toBeNull();
    expect(seen[0]?.get("cookie")).toBeNull();
    expect(seen[0]?.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("serves repeated requests from the cache", async () => {
    await s.serve("acme/handbook/docs/img/arch.png");
    const second = await s.serve("acme/handbook/docs/img/arch.png");
    expect(second.status).toBe(200);
    expect(contentRequests(s.fake)).toHaveLength(1);
  });

  it("caches a missing file briefly, and refetches after expiry", async () => {
    await s.serve("acme/handbook/docs/img/missing.png");
    await s.serve("acme/handbook/docs/img/missing.png");
    expect(contentRequests(s.fake)).toHaveLength(1);
    s.clock.now += 61_000;
    await s.serve("acme/handbook/docs/img/missing.png");
    expect(contentRequests(s.fake)).toHaveLength(2);
  });

  it("expires images after five minutes, picking up upstream changes", async () => {
    await s.serve("acme/site/logo.png");
    s.fake.setFile(2, "logo.png", JPEG);
    s.clock.now += 299_000;
    expect((await s.serve("acme/site/logo.png")).status).toBe(200);
    s.clock.now += 2_000;
    expect((await s.serve("acme/site/logo.png")).status).toBe(415);
    expect(contentRequests(s.fake)).toHaveLength(2);
  });

  it("never serves one repository's cached image for another", async () => {
    const a = await s.serve("acme/handbook/docs/img/arch.png");
    const b = await s.serve("acme/site/docs/img/arch.png");
    expect(a.headers["content-type"]).toBe("image/png");
    expect(b.status).toBe(415); // site's arch.png is a GIF named .png
    expect(contentRequests(s.fake)).toHaveLength(2);
  });

  it("refuses a repository removed after its images were cached", async () => {
    const present = new Set(["handbook"]);
    const t = setup({
      findRepo: async (_owner, name) =>
        present.has(name) ? (REPOS.find((r) => r.name === name) ?? null) : null,
    });
    expect((await t.serve("acme/handbook/docs/img/arch.png")).status).toBe(200);
    present.delete("handbook");
    expect((await t.serve("acme/handbook/docs/img/arch.png")).status).toBe(404);
  });

  it("does not cache upstream failures", async () => {
    s.fake.fail({ path: /\/contents\//, status: 500, times: 2 });
    expect((await s.serve("acme/handbook/docs/img/arch.png")).status).toBe(502);
    expect((await s.serve("acme/handbook/docs/img/arch.png")).status).toBe(200);
  });

  it("etagMatches handles lists, weak tags and absence", () => {
    expect(etagMatches(null, '"a"')).toBe(false);
    expect(etagMatches('"a"', '"a"')).toBe(true);
    expect(etagMatches('W/"a"', '"a"')).toBe(true);
    expect(etagMatches(' "b" , "a" ', '"a"')).toBe(true);
    expect(etagMatches('"b"', '"a"')).toBe(false);
  });
});

describe("serveAsset: upstream failures", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  it("maps a missing file to 404", async () => {
    const res = await s.serve("acme/handbook/docs/img/nope.png");
    expect(res.status).toBe(404);
    expect(bodyText(res)).toBe("Not found.");
  });

  it("maps a long rate limit to 503 with Retry-After, without waiting", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 120;
    s.fake.fail({
      path: /\/contents\//,
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    });
    const res = await s.serve("acme/handbook/docs/img/arch.png");
    expect(res.status).toBe(503);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(100);
    expect(contentRequests(s.fake)).toHaveLength(1);
    expect(s.logs.find("asset.upstream_failed")).toEqual([
      expect.objectContaining({ level: "warn", reason: "rate_limited" }),
    ]);
  });

  it("maps a 429 with retry-after to 503 with Retry-After", async () => {
    s.fake.fail({ path: /\/contents\//, status: 429, headers: { "retry-after": "30" } });
    const res = await s.serve("acme/handbook/docs/img/arch.png");
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("31");
  });

  it("maps GitHub 5xx to 502 after its retries", async () => {
    s.fake.fail({ path: /\/contents\//, status: 502 });
    const res = await s.serve("acme/handbook/docs/img/arch.png");
    expect(res.status).toBe(502);
    expect(contentRequests(s.fake)).toHaveLength(2);
    expect(s.logs.find("asset.upstream_failed")).toEqual([
      expect.objectContaining({ reason: "github_error", errorKind: "server", status: 502 }),
    ]);
  });

  it("maps a timeout to 504", async () => {
    const hanging = createGitHubClient({
      getToken: async () => TOKEN,
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as typeof fetch,
    });
    const t = setup({ github: hanging });
    const res = await t.serve("acme/handbook/docs/img/arch.png", {}, { timeoutMs: 30 });
    expect(res.status).toBe(504);
    expect(t.logs.find("asset.upstream_failed")).toEqual([
      expect.objectContaining({ reason: "timeout" }),
    ]);
  });

  it("stops when the client has gone away", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await s.serve("acme/handbook/docs/img/arch.png", { signal: controller.signal });
    expect(res.status).toBe(504);
    expect(contentRequests(s.fake)).toHaveLength(0);
  });

  it("answers 503 with a fixed text, and no lookup, while GitHub is not configured", async () => {
    const t = setup();
    t.getDeps.mockImplementation(async () => {
      throw Object.assign(new Error(`GitHub is not configured (missing: github_private_key)`), {
        name: "NotConfiguredError",
      });
    });
    const res = await t.serve("acme/handbook/docs/img/arch.png");
    expect(res.status).toBe(503);
    expect(String(res.body)).toBe("The image is temporarily unavailable. Try again later.");
    expect(t.logs.find("asset.not_configured")).toEqual([
      expect.objectContaining({ level: "warn" }),
    ]);
    expect(t.logs.find("asset.lookup_failed")).toEqual([]);
  });

  it("answers 500 when the runtime or database fails, logging fixed text only", async () => {
    const t = setup();
    t.getDeps.mockImplementation(() => {
      throw new Error(`config broken: GITHUB_APP_PRIVATE_KEY=${TOKEN}`);
    });
    const res = await t.serve("acme/handbook/docs/img/arch.png");
    expect(res.status).toBe(500);
    expect(t.logs.find("asset.lookup_failed")).toEqual([
      expect.objectContaining({ level: "error", errorName: "Error" }),
    ]);
    expect(t.logs.lines.join("")).not.toContain(TOKEN);
    const u = setup({
      findRepo: async () => {
        throw new Error(`connect ECONNREFUSED postgres://u:${TOKEN}@db`);
      },
    });
    expect((await u.serve("acme/handbook/docs/img/arch.png")).status).toBe(500);
  });
});

/** A `getFile` whose calls the test releases one by one. */
function controlledGithub() {
  interface Call {
    path: string;
    signal: AbortSignal | undefined;
    maxBytes: number | undefined;
    finish(bytes: Uint8Array): void;
    fail(error: unknown): void;
  }
  const calls: Call[] = [];
  let running = 0;
  let peak = 0;
  const github: AssetDeps["github"] = {
    getFile: (_owner, _repo, path, options) =>
      new Promise((resolve, reject) => {
        running += 1;
        peak = Math.max(peak, running);
        const settle = () => {
          running -= 1;
        };
        const call: Call = {
          path,
          signal: options?.signal,
          maxBytes: options?.maxBytes,
          finish: (bytes) => {
            settle();
            resolve({ notModified: false, data: bytes, etag: null });
          },
          fail: (error) => {
            settle();
            reject(error);
          },
        };
        options?.signal?.addEventListener("abort", () => call.fail(new GitHubError("aborted")), {
          once: true,
        });
        calls.push(call);
      }),
  };
  return { github, calls, running: () => running, peak: () => peak };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("serveAsset: upstream fetch gate", () => {
  function gated(gate: FetchGate = createFetchGate()) {
    const upstream = controlledGithub();
    const s = setup({ github: upstream.github, gate });
    return { ...s, upstream, gate };
  }

  it("shares one upstream fetch between concurrent requests for the same image", async () => {
    const t = gated();
    const requests = Array.from({ length: 12 }, () => t.serve("acme/handbook/docs/img/arch.png"));
    await settle();
    expect(t.upstream.calls).toHaveLength(1);
    t.upstream.calls[0]!.finish(PNG);
    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status)).toEqual(Array.from({ length: 12 }, () => 200));
    for (const res of responses) {
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers.etag).toBe(assetEtag(PNG));
      expectSecurityHeaders(res);
    }
    // cached once: the next request needs no upstream call
    expect((await t.serve("acme/handbook/docs/img/arch.png")).status).toBe(200);
    expect(t.upstream.calls).toHaveLength(1);
    expect(t.gate.stats()).toEqual({ inFlight: 0, queued: 0, reservedBytes: 0, flights: 0 });
  });

  it("does not merge different images or different repositories with the same path", async () => {
    const t = gated();
    const a = t.serve("acme/handbook/docs/img/arch.png");
    const b = t.serve("acme/handbook/docs/img/photo.jpg");
    const c = t.serve("acme/site/docs/img/arch.png");
    await settle();
    expect(t.upstream.calls.map((call) => call.path)).toEqual([
      "docs/img/arch.png",
      "docs/img/photo.jpg",
      "docs/img/arch.png",
    ]);
    t.upstream.calls[0]!.finish(PNG);
    t.upstream.calls[1]!.finish(JPEG);
    const otherPng = new Uint8Array([...PNG, 0]);
    t.upstream.calls[2]!.finish(otherPng);
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect([ra, rb, rc].map((r) => r.headers["content-type"])).toEqual([
      "image/png",
      "image/jpeg",
      "image/png",
    ]);
    expect(rc.headers.etag).toBe(assetEtag(otherPng));
    expect(rc.headers.etag).not.toBe(ra.headers.etag);
  });

  it("gives every merged request the same failure, and does not cache it", async () => {
    const t = gated();
    const requests = [1, 2, 3].map(() => t.serve("acme/handbook/docs/img/arch.png"));
    await settle();
    t.upstream.calls[0]!.fail(new GitHubError("server", 502));
    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status)).toEqual([502, 502, 502]);
    expect(t.gate.stats().inFlight).toBe(0);
    const retry = t.serve("acme/handbook/docs/img/arch.png");
    await settle();
    expect(t.upstream.calls).toHaveLength(2);
    t.upstream.calls[1]!.finish(PNG);
    expect((await retry).status).toBe(200);
  });

  it("runs at most the configured number of upstream fetches and queues the rest", async () => {
    const t = gated(createFetchGate({ maxInFlight: 3, maxQueue: 50 }));
    const requests = Array.from({ length: 10 }, (_, i) =>
      t.serve(`acme/handbook/docs/img/p${i}.png`),
    );
    await settle();
    expect(t.upstream.running()).toBe(3);
    expect(t.gate.stats()).toMatchObject({ inFlight: 3, queued: 7 });
    for (let done = 0; done < 10; done++) {
      await settle();
      t.upstream.calls[done]!.finish(PNG);
    }
    const responses = await Promise.all(requests);
    expect(responses.map((r) => r.status)).toEqual(Array.from({ length: 10 }, () => 200));
    expect(t.upstream.peak()).toBe(3);
    expect(t.upstream.calls).toHaveLength(10);
  });

  it("bounds in-flight bytes: the size limit is reserved for each running fetch", async () => {
    const t = gated(createFetchGate({ maxInFlight: 6, byteBudget: 20 * 1024 * 1024 }));
    const requests = Array.from({ length: 5 }, (_, i) =>
      t.serve(`acme/handbook/docs/img/p${i}.png`, {}, { maxBytes: 10 * 1024 * 1024 }),
    );
    await settle();
    expect(t.upstream.running()).toBe(2);
    expect(t.gate.stats().reservedBytes).toBe(20 * 1024 * 1024);
    expect(t.upstream.calls.every((call) => call.maxBytes === 10 * 1024 * 1024)).toBe(true);
    for (let done = 0; done < 5; done++) {
      await settle();
      t.upstream.calls[done]!.finish(PNG);
    }
    await Promise.all(requests);
    expect(t.upstream.peak()).toBe(2);
  });

  it("answers 503 with Retry-After when the queue is full, without calling GitHub", async () => {
    const t = gated(createFetchGate({ maxInFlight: 1, maxQueue: 2 }));
    const accepted = [0, 1, 2].map((i) => t.serve(`acme/handbook/docs/img/p${i}.png`));
    await settle();
    expect(t.gate.stats()).toMatchObject({ inFlight: 1, queued: 2 });
    const refused = await t.serve("acme/handbook/docs/img/overflow.png");
    expect(refused.status).toBe(503);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(refused.headers["cache-control"]).toBe("no-store");
    expect(bodyText(refused)).toBe("The image is temporarily unavailable. Try again later.");
    expectSecurityHeaders(refused);
    expect(t.upstream.calls.map((call) => call.path)).toEqual(["docs/img/p0.png"]);
    expect(t.logs.find("asset.upstream_failed")).toEqual([
      expect.objectContaining({ reason: "overloaded" }),
    ]);
    // a refusal is not cached: once there is room the same image is fetched
    for (let done = 0; done < 3; done++) {
      await settle();
      t.upstream.calls[done]!.finish(PNG);
    }
    await Promise.all(accepted);
    const later = t.serve("acme/handbook/docs/img/overflow.png");
    await settle();
    t.upstream.calls[3]!.finish(PNG);
    expect((await later).status).toBe(200);
  });

  it("answers 503 for a request that waited too long for a slot", async () => {
    const t = gated(createFetchGate({ maxInFlight: 1, maxQueue: 5 }));
    const first = t.serve("acme/handbook/docs/img/a.png");
    await settle();
    const res = await t.serve("acme/handbook/docs/img/b.png", {}, { queueTimeoutMs: 20 });
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(t.upstream.calls).toHaveLength(1);
    t.upstream.calls[0]!.finish(PNG);
    await first;
  });

  it("releases the slot when the upstream fetch fails", async () => {
    const t = gated(createFetchGate({ maxInFlight: 1, maxQueue: 5 }));
    const first = t.serve("acme/handbook/docs/img/a.png");
    const second = t.serve("acme/handbook/docs/img/b.png");
    await settle();
    t.upstream.calls[0]!.fail(new Error("socket hang up"));
    expect((await first).status).toBe(502);
    await settle();
    expect(t.upstream.calls).toHaveLength(2);
    t.upstream.calls[1]!.finish(PNG);
    expect((await second).status).toBe(200);
    expect(t.gate.stats()).toEqual({ inFlight: 0, queued: 0, reservedBytes: 0, flights: 0 });
  });

  it("releases the slot when the upstream fetch times out", async () => {
    const t = gated(createFetchGate({ maxInFlight: 1, maxQueue: 5 }));
    const res = await t.serve("acme/handbook/docs/img/a.png", {}, { timeoutMs: 20 });
    expect(res.status).toBe(504);
    expect(t.gate.stats().inFlight).toBe(0);
    const next = t.serve("acme/handbook/docs/img/b.png");
    await settle();
    t.upstream.calls[1]!.finish(PNG);
    expect((await next).status).toBe(200);
  });

  it("aborts the upstream fetch and frees its slot when the only client goes away", async () => {
    const t = gated(createFetchGate({ maxInFlight: 1, maxQueue: 5 }));
    const client = new AbortController();
    const gone = t.serve("acme/handbook/docs/img/a.png", { signal: client.signal });
    const waiting = t.serve("acme/handbook/docs/img/b.png");
    await settle();
    expect(t.upstream.calls).toHaveLength(1);
    client.abort();
    expect((await gone).status).toBe(504);
    expect(t.upstream.calls[0]!.signal?.aborted).toBe(true);
    await settle();
    expect(t.upstream.calls).toHaveLength(2);
    t.upstream.calls[1]!.finish(PNG);
    expect((await waiting).status).toBe(200);
    expect(t.gate.stats()).toEqual({ inFlight: 0, queued: 0, reservedBytes: 0, flights: 0 });
  });

  it("keeps the shared fetch alive when one of several clients goes away", async () => {
    const t = gated();
    const client = new AbortController();
    const impatient = t.serve("acme/handbook/docs/img/a.png", { signal: client.signal });
    const patient = t.serve("acme/handbook/docs/img/a.png");
    await settle();
    client.abort();
    expect((await impatient).status).toBe(504);
    expect(t.upstream.calls[0]!.signal?.aborted).toBe(false);
    t.upstream.calls[0]!.finish(PNG);
    expect((await patient).status).toBe(200);
    expect(t.upstream.calls).toHaveLength(1);
  });

  it("does not touch the gate for cache hits, refused paths or unknown repositories", async () => {
    const t = gated();
    const first = t.serve("acme/handbook/docs/img/a.png");
    await settle();
    t.upstream.calls[0]!.finish(PNG);
    await first;
    const spy = vi.spyOn(t.gate, "run");
    expect((await t.serve("acme/handbook/docs/img/a.png")).status).toBe(200);
    expect((await t.serve("acme/handbook/docs/notes.txt")).status).toBe(415);
    expect((await t.serve("nobody/nothing/x.png")).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("serveAsset: methods", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "refuses %s with 405 and Allow: GET, HEAD",
    async (method) => {
      const s = setup();
      const res = await s.serve("acme/handbook/docs/img/arch.png", { method });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("GET, HEAD");
      expect(s.getDeps).not.toHaveBeenCalled();
      expect(s.fake.requests).toEqual([]);
    },
  );
});

describe("serveAsset: credentials never leak", () => {
  let output: CapturedOutput;
  beforeEach(() => {
    output = captureOutput();
  });
  afterEach(() => {
    output.restore();
  });

  function leakFree(res: AssetResponse): void {
    const serialized = JSON.stringify({
      status: res.status,
      headers: res.headers,
      body: bodyText(res),
    });
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("injected failure");
    expect(serialized).not.toContain("Bad credentials");
    expect(Object.keys(res.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("bearer");
  }

  it("keeps the installation token out of every outcome, header and log", async () => {
    const outcomes: AssetResponse[] = [];
    const run = async (s: Setup, path: string, init = {}) => {
      // The default logger (JSON lines on stdout/stderr) is used, so the process output is checked.
      outcomes.push(
        await serveAsset(
          { method: "GET", headers: new Headers(), ...init },
          path.split("/"),
          s.getDeps,
          {},
        ),
      );
    };

    const s = setup();
    await run(s, "acme/handbook/docs/img/arch.png");
    await run(s, "acme/handbook/docs/img/diagram.svg");
    await run(s, "acme/handbook/docs/img/fake.png");
    await run(s, "acme/handbook/docs/img/nope.png");
    await run(s, "acme/handbook/../x.png");
    await run(s, "acme/handbook/x.md");
    await run(s, "acme/unknown/x.png");
    await run(s, "acme/handbook/docs/img/arch.png", { method: "POST" });

    for (const [status, headers] of [
      [500, {}],
      [401, {}],
      [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" }],
      [429, { "retry-after": "5" }],
      [404, {}],
      [422, {}],
    ] as const) {
      const t = setup();
      t.fake.fail({ path: /\/contents\//, status, headers });
      await run(t, "acme/handbook/docs/img/anim.gif");
    }

    // A token provider that fails with the token in its message.
    const badToken = createGitHubClient({
      getToken: async () => {
        throw new Error(`could not mint ${TOKEN}`);
      },
      fetch: makeFake().fetch,
    });
    await run(setup({ github: badToken }), "acme/handbook/docs/img/arch.png");

    // A client that throws a raw error carrying the token.
    const raw: Pick<GitHubClient, "getFile"> = {
      getFile: async () => {
        throw new Error(`fetch failed: Authorization: Bearer ${TOKEN}`);
      },
    };
    await run(setup({ github: raw }), "acme/handbook/docs/img/pic.webp");

    // The upstream error body and headers are not forwarded.
    const echo = createGitHubClient({
      getToken: async () => TOKEN,
      fetch: (async () =>
        new Response(`{"message":"Bad credentials ${TOKEN}"}`, {
          status: 400,
          headers: { "x-echo": TOKEN, "set-cookie": `t=${TOKEN}` },
        })) as typeof fetch,
    });
    await run(setup({ github: echo }), "acme/handbook/docs/img/arch.png");

    expect(outcomes.map((o) => o.status)).toEqual([
      200, 200, 415, 404, 400, 415, 404, 405, 502, 502, 503, 503, 404, 502, 502, 502, 502,
    ]);
    for (const res of outcomes) leakFree(res);
    const logged = output.text();
    expect(logged).not.toContain(TOKEN);
    expect(logged.toLowerCase()).not.toContain("bearer");
    // Something was logged (the 5xx, 401 and raw failures), all of it structured lines.
    const records = output.records();
    expect(records.some((r) => r.event === "asset.upstream_failed")).toBe(true);
    for (const line of logged.trim().split("\n")) expect(line).toMatch(/^\{"ts":/);
    for (const r of records) expect(r.event).toMatch(/^(asset|github)\.[a-z_.]+$/);
  });

  it("GitHubError messages are fixed text", () => {
    expect(new GitHubError("too_large").message).toBe("github: file larger than the allowed size");
  });
});

describe("handleAssetRequest", () => {
  it("reads the path from the raw request URL and decodes it once", async () => {
    const s = setup();
    const res = await handleAssetRequest(
      new Request("http://localhost/api/asset/acme/handbook/docs/img/my%20diagram.png"),
      s.getDeps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);

    const double = await handleAssetRequest(
      new Request("http://localhost/api/asset/acme/handbook/docs/img/my%2520diagram.png"),
      s.getDeps,
    );
    expect(double.status).toBe(400);
  });

  it("refuses URLs the URL parser normalizes out of the route", async () => {
    const s = setup();
    for (const url of [
      "http://localhost/api/asset/acme/handbook/%2e%2e/%2e%2e/x.png",
      "http://localhost/api/asset/acme/handbook/../../x.png",
      "http://localhost/api/asset/acme/handbook/..%2f..%2fx.png",
      "http://localhost/elsewhere/x.png",
    ]) {
      const res = await handleAssetRequest(new Request(url), s.getDeps, {
        log: recordingLogger().log,
      });
      expect(res.status, url).toBe(400);
    }
    expect(s.getDeps).not.toHaveBeenCalled();
    expect(s.fake.requests).toEqual([]);
  });

  it("answers HEAD and 405 through web Responses", async () => {
    const s = setup();
    const head = await handleAssetRequest(
      new Request("http://localhost/api/asset/acme/handbook/docs/img/arch.png", {
        method: "HEAD",
      }),
      s.getDeps,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(PNG.length));
    const post = await handleAssetRequest(
      new Request("http://localhost/api/asset/acme/handbook/docs/img/arch.png", {
        method: "POST",
        body: "x",
      }),
      s.getDeps,
    );
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});

describeDb("serveAsset with the real repository lookup", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
    await t.db.insert(repos).values([
      {
        githubId: 1,
        owner: "acme",
        name: "handbook",
        defaultBranch: "main",
        visibility: "private",
        htmlUrl: "https://github.com/acme/handbook",
      },
      {
        githubId: 2,
        owner: "acme",
        name: "site",
        defaultBranch: "trunk",
        visibility: "public",
        htmlUrl: "https://github.com/acme/site",
      },
    ]);
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("serves synced repositories and 404s the rest", async () => {
    const s = setup({ findRepo: (owner, name) => findAssetRepo(t.db, owner, name) });
    expect((await s.serve("Acme/Handbook/docs/img/arch.png")).status).toBe(200);
    expect((await s.serve("acme/site/logo.png")).status).toBe(200);
    // In the fake GitHub but never synced: not served.
    expect((await s.serve("acme/dropped/a.png")).status).toBe(404);
  });

  it("hides private repository assets when the visibility filter hides private repos", async () => {
    const s = setup({
      findRepo: (owner, name) =>
        findAssetRepo(t.db, owner, name, { visibility: githubPublicReposOnly }),
    });
    expect((await s.serve("acme/handbook/docs/img/arch.png")).status).toBe(404);
    expect((await s.serve("acme/site/logo.png")).status).toBe(200);
    expect(contentRequests(s.fake).map((r) => r.path)).toEqual([
      "/repos/acme/site/contents/logo.png",
    ]);
  });
});
