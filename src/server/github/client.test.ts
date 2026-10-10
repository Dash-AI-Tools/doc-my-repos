import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  GitHubError,
  createGitHubClient,
  decodeBase64Strict,
  type GitHubClientOptions,
} from "./client";

const TOKEN = "ghs_SENTINEL_token_value_123";
const SHA = "a".repeat(40);

type Responder = Response | Error | ((req: { url: string; init: RequestInit }) => Response);

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
    ...init,
    ...(init.headers
      ? { headers: { "content-type": "application/json", ...(init.headers as object) } }
      : {}),
  });
}

function status(code: number, headers: Record<string, string> = {}, body = ""): Response {
  return new Response(body || null, { status: code, headers });
}

function setup(responders: Responder[], extra: Partial<GitHubClientOptions> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  let clock = 1_700_000_000_000;
  let i = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = { url: String(url), init: init ?? {} };
    calls.push(req);
    const next = responders[Math.min(i++, responders.length - 1)]!;
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req) : next.clone();
  }) as typeof fetch;
  const client = createGitHubClient({
    getToken: async () => TOKEN,
    fetch: fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 1,
    ...extra,
  });
  return { client, calls, sleeps, now: () => clock };
}

async function catchError(p: Promise<unknown>): Promise<GitHubError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GitHubError);
    return e as GitHubError;
  }
  throw new Error("expected rejection");
}

const repoBody = (id = 1, name = "r") => ({
  id,
  name,
  full_name: `o/${name}`,
  owner: { login: "o" },
  default_branch: "main",
  archived: false,
  private: false,
  visibility: "public",
  description: null,
  html_url: `https://github.com/o/${name}`,
});

describe("rate limits", () => {
  it("waits until reset on 403 with remaining 0, then succeeds", async () => {
    const t = setup([]);
    const resetAt = Math.floor(t.now() / 1000) + 10;
    const s = setup([
      status(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) }),
      json(repoBody()),
    ]);
    const res = await s.client.getRepo("o", "r");
    expect(res.notModified).toBe(false);
    expect(s.calls).toHaveLength(2);
    expect(s.sleeps).toHaveLength(1);
    expect(s.sleeps[0]).toBeGreaterThan(0);
    expect(s.sleeps[0]).toBeLessThanOrEqual(12_000);
  });

  it("honours retry-after on 429", async () => {
    const s = setup([status(429, { "retry-after": "7" }), json(repoBody())]);
    await s.client.getRepo("o", "r");
    expect(s.sleeps).toEqual([8000]);
  });

  it("honours retry-after on a secondary-limit 403", async () => {
    const s = setup([status(403, { "retry-after": "3" }), json(repoBody())]);
    await s.client.getRepo("o", "r");
    expect(s.sleeps).toEqual([4000]);
  });

  it("does not retry a permission 403", async () => {
    const s = setup([status(403, { "x-ratelimit-remaining": "4999" }), json(repoBody())]);
    const err = await catchError(s.client.getRepo("o", "r"));
    expect(err.kind).toBe("forbidden");
    expect(err.status).toBe(403);
    expect(s.calls).toHaveLength(1);
    expect(s.sleeps).toEqual([]);
  });

  it("fails at once, with retryAfterMs, when the wait exceeds the cap", async () => {
    const s = setup([status(429, { "retry-after": "3600" })], { maxWaitMs: 60_000 });
    const err = await catchError(s.client.getRepo("o", "r"));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(3_601_000);
    expect(s.sleeps).toEqual([]);
    expect(s.calls).toHaveLength(1);
  });

  it("gives up after maxAttempts and does not sleep after the last one", async () => {
    const s = setup([status(429, { "retry-after": "1" })], { maxAttempts: 3 });
    const err = await catchError(s.client.getRepo("o", "r"));
    expect(err.kind).toBe("rate_limited");
    expect(s.calls).toHaveLength(3);
    expect(s.sleeps).toHaveLength(2);
  });

  it("backs off when a 429 carries no timing", async () => {
    const s = setup([status(429), json(repoBody())]);
    await s.client.getRepo("o", "r");
    expect(s.sleeps).toEqual([500]);
  });
});

describe("errors and retries", () => {
  it("maps 404 to not_found without retrying", async () => {
    const s = setup([status(404, {}, '{"message":"Not Found"}')]);
    const err = await catchError(s.client.getRepo("o", "r"));
    expect(err.kind).toBe("not_found");
    expect(err.status).toBe(404);
    expect(s.calls).toHaveLength(1);
  });

  it("maps 401 and other 4xx without retrying", async () => {
    expect((await catchError(setup([status(401)]).client.getRepo("o", "r"))).kind).toBe(
      "unauthorized",
    );
    expect((await catchError(setup([status(422)]).client.getRepo("o", "r"))).kind).toBe(
      "client_error",
    );
  });

  it("retries 5xx with exponential backoff, then succeeds", async () => {
    const s = setup([status(502), status(503), json(repoBody())]);
    await s.client.getRepo("o", "r");
    expect(s.sleeps).toEqual([500, 1000]);
  });

  it("applies jitter below the exponential ceiling", async () => {
    const s = setup([status(500), json(repoBody())], { random: () => 0 });
    await s.client.getRepo("o", "r");
    expect(s.sleeps).toEqual([250]);
  });

  it("reports server after retries are exhausted", async () => {
    const s = setup([status(500)], { maxAttempts: 3 });
    const err = await catchError(s.client.getRepo("o", "r"));
    expect(err.kind).toBe("server");
    expect(err.status).toBe(500);
    expect(s.calls).toHaveLength(3);
  });

  it("retries network errors, then reports network", async () => {
    const ok = setup([new TypeError("fetch failed"), json(repoBody())]);
    await ok.client.getRepo("o", "r");
    expect(ok.calls).toHaveLength(2);

    const bad = setup([new TypeError(`connect failed ${TOKEN}`)], { maxAttempts: 2 });
    const err = await catchError(bad.client.getRepo("o", "r"));
    expect(err.kind).toBe("network");
    expect(err.message).not.toContain(TOKEN);
  });

  it("rejects a malformed 2xx body as invalid_response", async () => {
    const err = await catchError(setup([json({ nope: true })]).client.getRepo("o", "r"));
    expect(err.kind).toBe("invalid_response");
    const bad = await catchError(
      setup([new Response("not json", { status: 200 })]).client.getRepo("o", "r"),
    );
    expect(bad.kind).toBe("invalid_response");
  });

  it("rejects an oversized body", async () => {
    const s = setup([new Response("x".repeat(100), { status: 200 })], { maxBodyBytes: 10 });
    expect((await catchError(s.client.getFile("o", "r", "a.md"))).kind).toBe("invalid_response");
  });

  it("maps a failing token provider to unauthorized without its message", async () => {
    const client = createGitHubClient({
      getToken: async () => {
        throw new Error(`private key ${TOKEN}`);
      },
      fetch: (async () => json(repoBody())) as typeof fetch,
    });
    const err = await catchError(client.getRepo("o", "r"));
    expect(err.kind).toBe("unauthorized");
    expect(err.message).not.toContain(TOKEN);
  });

  it("asks for a fresh token on every attempt", async () => {
    let n = 0;
    const seen: (string | undefined)[] = [];
    const client = createGitHubClient({
      getToken: async () => `tok${++n}`,
      fetch: (async (_u: string, init: RequestInit) => {
        seen.push((init.headers as Record<string, string>).Authorization);
        return seen.length === 1 ? status(500) : json(repoBody());
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    await client.getRepo("o", "r");
    expect(seen).toEqual(["Bearer tok1", "Bearer tok2"]);
  });
});

describe("abort", () => {
  it("aborts during a wait", async () => {
    const ac = new AbortController();
    const s = setup([status(429, { "retry-after": "5" }), json(repoBody())], {
      sleep: async () => ac.abort(),
    });
    const err = await catchError(s.client.getRepo("o", "r", { signal: ac.signal }));
    expect(err.kind).toBe("aborted");
    expect(s.calls).toHaveLength(1);
  });

  it("aborts before sending", async () => {
    const ac = new AbortController();
    ac.abort();
    const s = setup([json(repoBody())]);
    expect((await catchError(s.client.getRepo("o", "r", { signal: ac.signal }))).kind).toBe(
      "aborted",
    );
    expect(s.calls).toHaveLength(0);
  });

  it("maps a fetch abort to aborted and does not retry", async () => {
    const ac = new AbortController();
    const s = setup([
      () => {
        ac.abort();
        throw new DOMException("aborted", "AbortError");
      },
    ]);
    expect((await catchError(s.client.getRepo("o", "r", { signal: ac.signal }))).kind).toBe(
      "aborted",
    );
    expect(s.calls).toHaveLength(1);
  });
});

describe("conditional requests", () => {
  it("sends If-None-Match and returns notModified on 304", async () => {
    const s = setup([status(304)]);
    const res = await s.client.getRepo("o", "r", { etag: 'W/"abc"' });
    expect(res).toEqual({ notModified: true });
    expect((s.calls[0]!.init.headers as Record<string, string>)["If-None-Match"]).toBe('W/"abc"');
  });

  it("returns the new etag, and omits If-None-Match without one", async () => {
    const s = setup([json(repoBody(), { headers: { etag: 'W/"new"' } })]);
    const res = await s.client.getRepo("o", "r");
    expect(res).toMatchObject({ notModified: false, etag: 'W/"new"' });
    expect((s.calls[0]!.init.headers as Record<string, string>)["If-None-Match"]).toBeUndefined();
  });

  it("supports etags on trees, files and branch heads", async () => {
    const s = setup([status(304)]);
    expect(await s.client.getTree("o", "r", SHA, { etag: "x" })).toEqual({ notModified: true });
    expect(await s.client.getFile("o", "r", "CODEOWNERS", { etag: "x" })).toEqual({
      notModified: true,
    });
    expect(await s.client.getBranchHead("o", "r", "main", { etag: "x" })).toEqual({
      notModified: true,
    });
  });
});

describe("listInstallationRepositories", () => {
  const page = (from: number, count: number, total: number) =>
    json({
      total_count: total,
      repositories: Array.from({ length: count }, (_, k) => repoBody(from + k, `r${from + k}`)),
    });

  it("walks every page", async () => {
    const s = setup([page(1, 100, 150), page(101, 50, 150)]);
    const repos = await s.client.listInstallationRepositories();
    expect(repos).toHaveLength(150);
    expect(s.calls[0]!.url).toContain("/installation/repositories?per_page=100&page=1");
    expect(s.calls[1]!.url).toContain("page=2");
    expect(repos[0]).toMatchObject({ id: 1, owner: "o", visibility: "public" });
  });

  it("returns an empty array for an empty installation", async () => {
    const s = setup([json({ total_count: 0, repositories: [] })]);
    expect(await s.client.listInstallationRepositories()).toEqual([]);
  });

  it("throws, not a partial list, when a later page fails", async () => {
    const s = setup([page(1, 100, 250), status(404)]);
    const err = await catchError(s.client.listInstallationRepositories());
    expect(err.kind).toBe("not_found");
  });

  it("throws when the page cap is hit", async () => {
    const s = setup([page(1, 100, 100000)], { maxPages: 2 });
    const err = await catchError(s.client.listInstallationRepositories());
    expect(err.kind).toBe("invalid_response");
  });

  it("maps internal and private visibility to private", async () => {
    const s = setup([
      json({
        repositories: [
          { ...repoBody(1), visibility: "internal", private: true },
          { ...repoBody(2), visibility: undefined, private: true },
          { ...repoBody(3), visibility: undefined, private: undefined },
        ],
      }),
    ]);
    const repos = await s.client.listInstallationRepositories();
    expect(repos.map((r) => r.visibility)).toEqual(["private", "private", "private"]);
  });
});

describe("trees, blobs, files, branches", () => {
  it("returns a recursive tree with the truncated flag", async () => {
    const s = setup([
      json({
        sha: SHA,
        truncated: true,
        tree: [{ path: "docs/a.md", mode: "100644", type: "blob", sha: "b".repeat(40), size: 12 }],
      }),
    ]);
    const res = await s.client.getTree("o", "r", SHA);
    expect(s.calls[0]!.url).toContain(`/repos/o/r/git/trees/${SHA}?recursive=1`);
    expect(res).toMatchObject({
      notModified: false,
      data: { truncated: true, entries: [{ path: "docs/a.md", size: 12 }] },
    });
  });

  it("decodes a base64 blob with line wraps", async () => {
    const text = "# Hello\nunicode: é ✓\n";
    const b64 = Buffer.from(text).toString("base64");
    const wrapped = `${b64.slice(0, 8)}\n${b64.slice(8)}\n`;
    const s = setup([
      json({ content: wrapped, encoding: "base64", size: Buffer.byteLength(text) }),
    ]);
    const { bytes } = await s.client.getBlob("o", "r", SHA);
    expect(new TextDecoder().decode(bytes)).toBe(text);
  });

  it("rejects invalid base64, wrong encoding and size mismatch", async () => {
    for (const body of [
      { content: "!!!notbase64", encoding: "base64" },
      { content: "aGk=", encoding: "utf-8" },
      { content: "aGk=", encoding: "base64", size: 99 },
    ]) {
      const err = await catchError(setup([json(body)]).client.getBlob("o", "r", SHA));
      expect(err.kind).toBe("invalid_response");
    }
    expect(decodeBase64Strict("abc")).toBeNull();
    expect(decodeBase64Strict("aGk=")).toEqual(new Uint8Array([104, 105]));
  });

  it("fetches a raw file with per-segment encoding and the raw accept header", async () => {
    const s = setup([new Response("* @org/team\n", { status: 200, headers: { etag: '"e1"' } })]);
    const res = await s.client.getFile("o", "r", ".github/my docs/CODEOWNERS", { ref: "feat/x" });
    expect(s.calls[0]!.url).toBe(
      "https://api.github.com/repos/o/r/contents/.github/my%20docs/CODEOWNERS?ref=feat%2Fx",
    );
    expect((s.calls[0]!.init.headers as Record<string, string>).Accept).toBe(
      "application/vnd.github.raw+json",
    );
    expect(res).toMatchObject({ notModified: false, etag: '"e1"' });
    if (!res.notModified) expect(new TextDecoder().decode(res.data)).toBe("* @org/team\n");
  });

  it("reads the default branch head", async () => {
    const s = setup([json({ commit: { sha: SHA, commit: { tree: { sha: "c".repeat(40) } } } })]);
    const res = await s.client.getBranchHead("o", "r", "release/1.0");
    expect(s.calls[0]!.url).toContain("/repos/o/r/branches/release/1.0");
    expect(res).toMatchObject({ data: { commitSha: SHA, treeSha: "c".repeat(40) } });
  });
});

describe("input validation", () => {
  it("rejects bad owner and repo names before any request", async () => {
    const s = setup([json(repoBody())]);
    const bad: [string, string][] = [
      ["", "r"],
      ["o/x", "r"],
      ["o", "r/x"],
      ["o", ".."],
      ["o", "."],
      ["..", "r"],
      ["o", "r\n"],
      ["o\0", "r"],
      ["o", "r?x=1"],
      ["o", "r#x"],
      ["o p", "r"],
      ["o", "r%2f"],
    ];
    for (const [o, r] of bad) {
      expect((await catchError(s.client.getRepo(o, r))).kind).toBe("invalid_input");
    }
    expect(s.calls).toHaveLength(0);
  });

  it("rejects bad shas, paths and refs", async () => {
    const s = setup([json(repoBody())]);
    const cases: Promise<unknown>[] = [
      s.client.getTree("o", "r", "main"),
      s.client.getBlob("o", "r", "../x"),
      s.client.getFile("o", "r", "../etc/passwd"),
      s.client.getFile("o", "r", "a/./b"),
      s.client.getFile("o", "r", "a//b"),
      s.client.getFile("o", "r", "/abs"),
      s.client.getFile("o", "r", "a\\b"),
      s.client.getFile("o", "r", "a\nb"),
      s.client.getFile("o", "r", "ok.md", { ref: "a..b" }),
      s.client.getFile("o", "r", "ok.md", { ref: "a b" }),
      s.client.getBranchHead("o", "r", "x/../y"),
      s.client.getBranchHead("o", "r", "x\u0000"),
    ];
    for (const c of cases) expect((await catchError(c)).kind).toBe("invalid_input");
    expect(s.calls).toHaveLength(0);
  });
});

describe("credential hygiene", () => {
  it("never shows the token in errors or in the client", async () => {
    const echo = (code: number) =>
      status(code, { "x-ratelimit-remaining": "0", "retry-after": "999999" }, `Bearer ${TOKEN}`);
    const errors: GitHubError[] = [];
    for (const r of [
      status(403, {}, TOKEN),
      status(404, {}, TOKEN),
      status(500, {}, TOKEN),
      echo(429),
    ]) {
      const s = setup([r], { maxAttempts: 1 });
      errors.push(await catchError(s.client.getRepo("o", "r")));
    }
    errors.push(
      await catchError(setup([new Error(TOKEN)], { maxAttempts: 1 }).client.getRepo("o", "r")),
    );
    for (const err of errors) {
      expect(err.message).not.toContain(TOKEN);
      expect(JSON.stringify(err)).not.toContain(TOKEN);
      expect(inspect(err, { depth: 10, showHidden: true })).not.toContain(TOKEN);
      expect(String(err.stack)).not.toContain(TOKEN);
      expect(err.cause).toBeUndefined();
    }
    const { client } = setup([json(repoBody())]);
    await client.getRepo("o", "r");
    expect(inspect(client, { depth: 10, showHidden: true })).not.toContain(TOKEN);
    expect(JSON.stringify(client)).not.toContain(TOKEN);
  });
});
