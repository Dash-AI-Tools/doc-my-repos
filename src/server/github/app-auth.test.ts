import { createPrivateKey, createVerify, generateKeyPairSync } from "node:crypto";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { Secret } from "../config/secret";
import {
  createInstallationTokenProvider,
  type InstallationTokenProvider,
  type InstallationTokenProviderOptions,
} from "./app-auth";
import { GitHubError, createGitHubClient } from "./client";

// Throwaway keys, generated per run. Nothing is committed.
const { privateKey: PKCS8, publicKey: PUBLIC_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const PKCS1 = createPrivateKey(PKCS8).export({ type: "pkcs1", format: "pem" }).toString();
/** A line from the middle of each key body, to search for in output. */
const KEY_SENTINELS = [PKCS8, PKCS1].map((pem) => pem.split("\n")[3]!);

const T0 = 1_700_000_000_000; // whole seconds, like HTTP dates
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TOKEN_PREFIX = "ghs_SENTINEL_installation_token_";

interface Req {
  url: string;
  init: RequestInit;
}
type Step = Error | ((req: Req) => Response | Promise<Response>);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

let nextInstallationId = 1000;

function harness(extra: Partial<InstallationTokenProviderOptions> = {}) {
  let clock = T0;
  let minted = 0;
  const calls: Req[] = [];
  const jwts: string[] = [];
  const sleeps: number[] = [];
  const script: Step[] = [];

  /** A 201 with a fresh token living `lifetimeMs` from the current clock. */
  const issue = (lifetimeMs = HOUR) => {
    minted++;
    return json(
      201,
      {
        token: `${TOKEN_PREFIX}${minted}`,
        expires_at: new Date(clock + lifetimeMs).toISOString(),
        permissions: { contents: "read", metadata: "read" },
        repository_selection: "all",
      },
      { date: new Date(clock).toUTCString() },
    );
  };

  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = { url: String(url), init: init ?? {} };
    calls.push(req);
    const auth = (req.init.headers as Record<string, string>).authorization ?? "";
    jwts.push(auth.replace(/^bearer /i, ""));
    const step = script.shift() ?? (() => issue());
    if (step instanceof Error) throw step;
    return step(req);
  }) as typeof fetch;

  const installationId = nextInstallationId++;
  const provider = createInstallationTokenProvider({
    appId: 42,
    installationId,
    privateKey: new Secret(PKCS8),
    fetch: fetchFn,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 1,
    ...extra,
  });

  return {
    provider,
    installationId,
    calls,
    jwts,
    sleeps,
    script,
    issue,
    now: () => clock,
    setClock: (t: number) => {
      clock = t;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
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

function catchSync(fn: () => unknown): GitHubError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GitHubError);
    return e as GitHubError;
  }
  throw new Error("expected throw");
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("minting and caching", () => {
  it("mints once, then serves the cached token without calling GitHub", async () => {
    const h = harness();
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}1`);
    h.advance(30 * MINUTE);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}1`);
    expect(h.calls).toHaveLength(1);

    const { url, init } = h.calls[0]!;
    expect(url).toBe(`https://api.github.com/app/installations/${h.installationId}/access_tokens`);
    expect(init.method).toBe("POST");
    // Read-only: nothing that would change the token's scope is requested.
    expect(String(init.body ?? "")).not.toMatch(/permissions|repository_ids|repositories/);
  });

  it("signs a valid RS256 JWT, backdated 30 s and valid for 10 minutes", async () => {
    const h = harness();
    await h.provider.getToken();
    const jwt = h.jwts[0]!;
    const [header, payload, signature] = jwt.split(".");
    expect(decodeJwtPart(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decodeJwtPart(payload!);
    const iat = Math.floor(T0 / 1000) - 30;
    expect(claims).toEqual({ iat, exp: iat + 600, iss: 42 });
    const verify = createVerify("RSA-SHA256");
    verify.update(`${header}.${payload}`);
    expect(verify.verify(PUBLIC_KEY, Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("accepts a PKCS#1 key", async () => {
    const h = harness({ privateKey: new Secret(PKCS1) });
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}1`);
  });

  it("refreshes at the margin before expiry, not earlier", async () => {
    const h = harness();
    await h.provider.getToken();
    h.setClock(T0 + HOUR - 5 * MINUTE - 1);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}1`);
    expect(h.calls).toHaveLength(1);
    h.setClock(T0 + HOUR - 5 * MINUTE);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}2`);
    expect(h.calls).toHaveLength(2);
    // The new token is cached from its own receipt time.
    h.advance(10 * MINUTE);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}2`);
    expect(h.calls).toHaveLength(2);
  });

  it("honours a custom margin", async () => {
    const h = harness({ refreshMarginMs: 10 * MINUTE });
    await h.provider.getToken();
    h.setClock(T0 + 50 * MINUTE);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}2`);
  });

  it("refreshes at half-life when the lifetime equals the margin", async () => {
    const h = harness();
    h.script.push(() => h.issue(5 * MINUTE));
    await h.provider.getToken();
    h.setClock(T0 + 2.5 * MINUTE - 1);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}1`);
    h.setClock(T0 + 2.5 * MINUTE);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}2`);
  });

  it("refreshes at half-life when the lifetime is shorter than the margin", async () => {
    const h = harness();
    h.script.push(() => h.issue(2 * MINUTE));
    await h.provider.getToken();
    h.setClock(T0 + MINUTE - 1);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}1`);
    h.setClock(T0 + MINUTE);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}2`);
  });

  it("measures lifetime against GitHub's Date header, not the local clock", async () => {
    const h = harness();
    // Local clock is 20 minutes ahead of GitHub: expires_at looks 40 minutes away locally.
    h.script.push(() =>
      json(
        201,
        {
          token: `${TOKEN_PREFIX}skew`,
          expires_at: new Date(T0 - 20 * MINUTE + HOUR).toISOString(),
        },
        { date: new Date(T0 - 20 * MINUTE).toUTCString() },
      ),
    );
    await h.provider.getToken();
    h.setClock(T0 + 50 * MINUTE);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}skew`);
    expect(h.calls).toHaveLength(1);
  });

  it("caps a lifetime beyond one hour", async () => {
    const h = harness();
    h.script.push(() => h.issue(24 * HOUR));
    await h.provider.getToken();
    h.setClock(T0 + HOUR - 5 * MINUTE);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}2`);
  });

  it("replaces the token when the clock goes backwards", async () => {
    const h = harness();
    await h.provider.getToken();
    h.setClock(T0 - 1000);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}2`);
    expect(h.calls).toHaveLength(2);
  });

  it("invalidate() forces a new mint", async () => {
    const h = harness();
    await h.provider.getToken();
    h.provider.invalidate();
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}2`);
  });

  it("rejects a token response without a usable token or expiry", async () => {
    for (const body of [
      { expires_at: new Date(T0 + HOUR).toISOString() },
      { token: "has space", expires_at: new Date(T0 + HOUR).toISOString() },
      { token: "ghs_x", expires_at: "not a date" },
      { token: "ghs_x", expires_at: new Date(T0 - 1000).toISOString() },
    ]) {
      const h = harness();
      h.script.push(() => json(201, body, { date: new Date(T0).toUTCString() }));
      expect((await catchError(h.provider.getToken())).kind).toBe("invalid_response");
    }
  });
});

describe("single-flight", () => {
  it("shares one mint between concurrent callers", async () => {
    const h = harness();
    const gate = deferred<void>();
    h.script.push(async () => {
      await gate.promise;
      return h.issue();
    });
    const pending = Array.from({ length: 10 }, () => h.provider.getToken());
    gate.resolve();
    const tokens = await Promise.all(pending);
    expect(new Set(tokens)).toEqual(new Set([`${TOKEN_PREFIX}1`]));
    expect(h.calls).toHaveLength(1);
  });

  it("shares one refresh near expiry", async () => {
    const h = harness();
    await h.provider.getToken();
    h.setClock(T0 + 58 * MINUTE);
    const gate = deferred<void>();
    h.script.push(async () => {
      await gate.promise;
      return h.issue();
    });
    const pending = Array.from({ length: 10 }, () => h.provider.getToken());
    gate.resolve();
    expect(new Set(await Promise.all(pending))).toEqual(new Set([`${TOKEN_PREFIX}2`]));
    expect(h.calls).toHaveLength(2);
  });

  it("concurrent rejections of the same token cause one mint", async () => {
    const h = harness();
    const first = await h.provider.getToken();
    const gate = deferred<void>();
    h.script.push(async () => {
      await gate.promise;
      return h.issue();
    });
    const pending = Array.from({ length: 5 }, () => h.provider.getToken({ rejectedToken: first }));
    gate.resolve();
    expect(new Set(await Promise.all(pending))).toEqual(new Set([`${TOKEN_PREFIX}2`]));
    // A late rejection of the old token gets the new one without another mint.
    expect(await h.provider.getToken({ rejectedToken: first })).toBe(`${TOKEN_PREFIX}2`);
    expect(h.calls).toHaveLength(2);
  });
});

describe("failures", () => {
  it("retries 5xx and network errors with bounded backoff, then succeeds", async () => {
    const h = harness();
    h.script.push(() => json(502, { message: "bad gateway" }), new TypeError("fetch failed"));
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}1`);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([500, 1000]);
  });

  it("gives up after maxAttempts with a transient kind", async () => {
    const h = harness({ maxAttempts: 2 });
    h.script.push(
      () => json(503, {}),
      () => json(503, {}),
    );
    const err = await catchError(h.provider.getToken());
    expect(err.kind).toBe("server");
    expect(err.status).toBe(503);
    expect(h.calls).toHaveLength(2);

    const net = harness({ maxAttempts: 1 });
    net.script.push(new TypeError("fetch failed"));
    expect((await catchError(net.provider.getToken())).kind).toBe("network");
  });

  it("does not cache a failure beyond the cooldown, then mints", async () => {
    const h = harness({ maxAttempts: 1, failureCooldownMs: 5000 });
    h.script.push(() => json(500, {}));
    expect((await catchError(h.provider.getToken())).kind).toBe("server");
    // Within the cooldown: fails fast, GitHub is not called.
    h.advance(4999);
    expect((await catchError(h.provider.getToken())).kind).toBe("server");
    expect(h.calls).toHaveLength(1);
    // After it: a new attempt, which succeeds and clears the failure.
    h.advance(1);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}1`);
    expect(h.calls).toHaveLength(2);
  });

  it("keeps serving a still-valid token while a refresh fails, until it expires", async () => {
    const h = harness({ maxAttempts: 1 });
    await h.provider.getToken();
    h.setClock(T0 + 56 * MINUTE);
    h.script.push(() => json(503, {}));
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}1`);
    expect(h.calls).toHaveLength(2);
    // Cooldown: still the old token, no new request.
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}1`);
    expect(h.calls).toHaveLength(2);
    // Past expiry with GitHub still failing: the error surfaces.
    h.setClock(T0 + HOUR);
    h.script.push(() => json(503, {}));
    expect((await catchError(h.provider.getToken())).kind).toBe("server");
    // GitHub recovers.
    h.advance(10_000);
    expect(await h.provider.getToken()).toBe(`${TOKEN_PREFIX}2`);
  });

  it("does not serve a rejected token even while a refresh fails", async () => {
    const h = harness({ maxAttempts: 1 });
    const first = await h.provider.getToken();
    h.script.push(() => json(503, {}));
    expect((await catchError(h.provider.getToken({ rejectedToken: first }))).kind).toBe("server");
  });

  it("maps 404 (uninstalled) to installation_unavailable without retrying", async () => {
    const h = harness();
    h.script.push(() => json(404, { message: "Not Found" }));
    const err = await catchError(h.provider.getToken());
    expect(err.kind).toBe("installation_unavailable");
    expect(err.status).toBe(404);
    expect(err.message).toContain("GitHub App installation unavailable");
    expect(h.calls).toHaveLength(1);
  });

  it("maps 403 suspended to installation_unavailable, other 403 to forbidden", async () => {
    const h = harness();
    h.script.push(() => json(403, { message: "This installation has been suspended" }));
    const err = await catchError(h.provider.getToken());
    expect(err.kind).toBe("installation_unavailable");
    expect(err.status).toBe(403);

    const other = harness();
    other.script.push(() => json(403, { message: "Resource not accessible by integration" }));
    expect((await catchError(other.provider.getToken())).kind).toBe("forbidden");
  });

  it("maps 401 to app_credentials and 422 to client_error", async () => {
    const h = harness();
    h.script.push(() => json(401, { message: "A JSON web token could not be decoded" }));
    expect((await catchError(h.provider.getToken())).kind).toBe("app_credentials");
    expect(h.calls).toHaveLength(1);

    const u = harness();
    u.script.push(() => json(422, { message: "Validation Failed" }));
    expect((await catchError(u.provider.getToken())).kind).toBe("client_error");
  });

  it("maps a rate-limited token request to rate_limited with the wait", async () => {
    const h = harness();
    h.script.push(() => json(429, { message: "slow down" }, { "retry-after": "30" }));
    const err = await catchError(h.provider.getToken());
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(31_000);
  });
});

describe("configuration", () => {
  it("rejects a private key that is not a PEM RSA key, without echoing it", () => {
    const { privateKey: ecKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const garbage = `-----BEGIN PRIVATE KEY-----\n${KEY_SENTINELS[0]}\n-----END PRIVATE KEY-----`;
    for (const key of ["", "not a key SENTINEL_raw_value", garbage, ecKey, PKCS8.slice(0, 200)]) {
      let fetched = 0;
      const err = catchSync(() =>
        createInstallationTokenProvider({
          appId: 1,
          installationId: 1,
          privateKey: new Secret(key),
          fetch: (async () => {
            fetched++;
            return new Response(null);
          }) as typeof fetch,
        }),
      );
      expect(err.kind).toBe("invalid_private_key");
      expect(fetched).toBe(0);
      const shown = `${err.message} ${err.stack} ${inspect(err, { showHidden: true })}`;
      expect(shown).not.toContain("SENTINEL_raw_value");
      expect(shown).not.toContain(KEY_SENTINELS[0]);
      expect(shown).not.toContain("BEGIN");
    }
  });

  it("rejects ids that are not positive integers", () => {
    for (const [appId, installationId] of [
      [0, 1],
      [1, -1],
      [1.5, 1],
      [1, Number.NaN],
    ] as const) {
      const err = catchSync(() =>
        createInstallationTokenProvider({ appId, installationId, privateKey: new Secret(PKCS8) }),
      );
      expect(err.kind).toBe("invalid_input");
    }
  });
});

describe("credential hygiene", () => {
  it("never shows the key, JWT or token in errors or in the provider", async () => {
    const errors: GitHubError[] = [];
    const secrets: string[] = [...KEY_SENTINELS];

    // Mint a real token and JWT so their values are known.
    const ok = harness();
    const token = await ok.provider.getToken();
    secrets.push(token, ok.jwts[0]!);
    const echo = (status: number) => (req: Req) =>
      json(status, {
        message: `${(req.init.headers as Record<string, string>).authorization} ${token} ${PKCS8}`,
      });

    for (const step of [
      echo(401),
      echo(403),
      echo(404),
      echo(422),
      echo(500),
      new TypeError(`connect failed ${token} ${PKCS8}`),
    ]) {
      const h = harness({ maxAttempts: 1 });
      h.script.push(step);
      errors.push(await catchError(h.provider.getToken()));
      secrets.push(h.jwts[0]!);
    }
    errors.push(
      catchSync(() =>
        createInstallationTokenProvider({
          appId: 1,
          installationId: 1,
          privateKey: new Secret(`${PKCS8}\ntrailing ${token}`),
        }),
      ),
    );

    for (const err of errors) {
      const shown = [
        err.message,
        String(err.stack),
        JSON.stringify(err),
        inspect(err, { depth: 10, showHidden: true }),
        String(err),
      ].join("\n");
      for (const secret of secrets) expect(shown).not.toContain(secret);
      expect(err.cause).toBeUndefined();
    }

    const provider: InstallationTokenProvider = ok.provider;
    const views = [
      inspect(provider, { depth: 10, showHidden: true }),
      JSON.stringify(provider),
      String(provider),
      `${provider}`,
      Object.getOwnPropertyNames(provider).join(","),
      Object.keys(provider).join(","),
    ].join("\n");
    for (const secret of secrets) expect(views).not.toContain(secret);
    expect(Object.keys(provider).sort()).toEqual(["getToken", "invalidate"]);
    expect(Object.isFrozen(provider)).toBe(true);
  });
});

describe("with the GitHub client", () => {
  const repoBody = {
    id: 1,
    name: "r",
    full_name: "o/r",
    owner: { login: "o" },
    default_branch: "main",
    visibility: "public",
    html_url: "https://github.com/o/r",
  };

  function wire(apiStatus: (auth: string, n: number) => number) {
    const h = harness();
    const auths: string[] = [];
    const client = createGitHubClient({
      getToken: h.provider.getToken,
      fetch: (async (_url: string, init: RequestInit) => {
        const auth = (init.headers as Record<string, string>).Authorization ?? "";
        auths.push(auth);
        const code = apiStatus(auth, auths.length);
        return code === 200 ? json(200, repoBody) : json(code, { message: "Bad credentials" });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    return { h, client, auths };
  }

  it("retries once with a fresh token after a 401", async () => {
    const { h, client, auths } = wire((auth) => (auth.endsWith("_1") ? 401 : 200));
    const res = await client.getRepo("o", "r");
    expect(res.notModified).toBe(false);
    expect(auths).toEqual([`Bearer ${TOKEN_PREFIX}1`, `Bearer ${TOKEN_PREFIX}2`]);
    expect(h.calls).toHaveLength(2);
    // Later requests use the new token without minting again.
    await client.getRepo("o", "r");
    expect(h.calls).toHaveLength(2);
  });

  it("fails with unauthorized when the fresh token is rejected too", async () => {
    const { h, client, auths } = wire(() => 401);
    const err = await catchError(client.getRepo("o", "r"));
    expect(err.kind).toBe("unauthorized");
    expect(err.status).toBe(401);
    expect(auths).toHaveLength(2);
    expect(h.calls).toHaveLength(2);
  });

  it("refreshes once for many concurrent 401s on the same token", async () => {
    const { h, client } = wire((auth) => (auth.endsWith("_1") ? 401 : 200));
    await h.provider.getToken();
    await Promise.all(Array.from({ length: 8 }, () => client.getRepo("o", "r")));
    expect(h.calls).toHaveLength(2);
  });

  it("surfaces installation_unavailable from the provider", async () => {
    const { h, client, auths } = wire(() => 200);
    h.script.push(() => json(404, { message: "Not Found" }));
    const err = await catchError(client.getRepo("o", "r"));
    expect(err.kind).toBe("installation_unavailable");
    expect(auths).toHaveLength(0);
  });
});
