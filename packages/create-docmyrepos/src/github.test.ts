import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { containsCredential, redactCredentials, safeQuote } from "./credentials.js";
import {
  API_URL_ENV,
  createGithubClient,
  DEFAULT_GITHUB_API_URL,
  detectPermissionWarnings,
  findInstallation,
  GithubError,
  MAX_REPOSITORIES,
  resolveGithubApiUrl,
  type GithubClient,
} from "./github.js";
import { createAppJwt } from "./jwt.js";
import { startFakeGithub, type FakeGithub } from "./test-support-github.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const otherPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

let fake: FakeGithub | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function setup(overrides: Parameters<typeof startFakeGithub>[0] = {}) {
  fake = await startFakeGithub({ publicKeyPem: publicPem, ...overrides });
  const client = createGithubClient({ baseUrl: fake.url });
  const jwt = createAppJwt(fake.state.appId, pem);
  return { fake, client, jwt };
}

async function failure(promise: Promise<unknown>): Promise<GithubError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GithubError);
    return error as GithubError;
  }
  throw new Error("expected a failure");
}

describe("API base", () => {
  it("defaults to api.github.com and accepts a loopback override only", () => {
    expect(resolveGithubApiUrl({})).toEqual({ ok: true, value: DEFAULT_GITHUB_API_URL });
    expect(resolveGithubApiUrl({ [API_URL_ENV]: "http://127.0.0.1:8080/" })).toEqual({
      ok: true,
      value: "http://127.0.0.1:8080",
    });
    expect(resolveGithubApiUrl({ [API_URL_ENV]: "http://localhost:9" }).ok).toBe(true);
    for (const bad of [
      "https://api.github.com.evil.example",
      "https://evil.example",
      "http://10.0.0.1",
      "http://127.0.0.1.evil.example",
      "http://user:pw@127.0.0.1",
      "ftp://127.0.0.1",
      "not a url",
    ]) {
      const result = resolveGithubApiUrl({ [API_URL_ENV]: bad });
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.reason).not.toContain("pw");
    }
  });

  it("the client itself refuses a non-loopback base URL", () => {
    expect(() => createGithubClient({ baseUrl: "https://evil.example" })).toThrow(/loopback/);
    expect(() => createGithubClient({ baseUrl: DEFAULT_GITHUB_API_URL })).not.toThrow();
  });
});

describe("manifest conversion", () => {
  it("exchanges the code without credentials", async () => {
    const { fake, client } = await setup();
    const app = await client.convertManifest("good-code");
    expect(app).toMatchObject({ id: 12345, slug: "docmyrepos-acme" });
    expect(app.pem).toContain("BEGIN RSA PRIVATE KEY");
    expect(app.webhookSecret).toBe("fake-webhook-secret-0123456789");
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/app-manifests/good-code/conversions",
      authorization: undefined,
    });
  });

  it("maps an expired code (404) and a rejected manifest (422)", async () => {
    const { fake, client } = await setup();
    expect((await failure(client.convertManifest("stale"))).kind).toBe("not_found");
    fake.state.failNext = { status: 422, body: { message: "Name is already in use" } };
    const rejected = await failure(client.convertManifest("good-code"));
    expect(rejected.kind).toBe("manifest_rejected");
    expect(rejected.message).toContain("by hand");
    expect(rejected.message).toContain("Name is already in use");
  });

  it("refuses a malformed code before sending anything", async () => {
    const { fake, client } = await setup();
    await failure(client.convertManifest("../../app"));
    expect(fake.requests).toHaveLength(0);
  });
});

describe("GET /app", () => {
  it("returns the App with its permissions when id and key belong together", async () => {
    const { client, jwt } = await setup();
    const app = await client.getApp(jwt);
    expect(app).toMatchObject({ id: 12345, slug: "docmyrepos-acme", name: "DocMyRepos (acme)" });
    expect(app.permissions).toEqual({ contents: "read", metadata: "read" });
    expect(app.events).toEqual(["push", "repository"]);
  });

  it("maps a key that does not match to a fixed 401 message with no key in it", async () => {
    const { fake, client } = await setup();
    const wrong = createAppJwt(fake.state.appId, otherPem);
    const error = await failure(client.getApp(wrong));
    expect(error.kind).toBe("unauthorized");
    expect(error.message).toContain("App id and the private key");
    expect(error.message).not.toContain(wrong);
    expect(error.message).not.toContain("BEGIN");
    expect(error.message).not.toContain("JSON web token");
  });
});

describe("permission warnings", () => {
  it("accepts exactly contents: read and metadata: read", () => {
    expect(detectPermissionWarnings({ contents: "read", metadata: "read" })).toEqual([]);
  });

  it("warns about write access and about any other permission", () => {
    const warnings = detectPermissionWarnings({
      contents: "write",
      metadata: "read",
      issues: "read",
    });
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toContain("write access to contents");
    expect(warnings.join(" ")).toContain("issues");
  });

  it("warns when a needed permission is missing", () => {
    expect(detectPermissionWarnings({ metadata: "read" })[0]).toContain("contents");
  });

  it("detects them through the client against the fake", async () => {
    const { client, jwt } = await setup({ permissions: { contents: "write", metadata: "read" } });
    const app = await client.getApp(jwt);
    expect(detectPermissionWarnings(app.permissions)).toHaveLength(1);
  });
});

describe("installations", () => {
  it("lists installations across pages", async () => {
    const installations = Array.from({ length: 130 }, (_, i) => ({
      id: i + 1,
      login: `org-${i + 1}`,
    }));
    const { client, jwt } = await setup({ installations });
    expect(await client.listInstallations(jwt)).toHaveLength(130);
  });

  it("matches the organization case-insensitively and names other accounts", () => {
    const list = [
      { id: 7, login: "Acme", accountType: "Organization" },
      { id: 8, login: "someone", accountType: "User" },
    ];
    expect(findInstallation(list, "acme")).toEqual({ status: "found", id: 7, login: "Acme" });
    expect(findInstallation(list, "other")).toEqual({
      status: "wrong_account",
      accounts: ["Acme", "someone"],
    });
    expect(findInstallation([], "acme")).toEqual({ status: "none" });
  });

  it("polls until the installation appears", async () => {
    const { fake, jwt } = await setup();
    let slept = 0;
    const polled = createGithubClient({
      baseUrl: fake.url,
      sleep: async () => {
        slept += 1;
        if (slept === 2) fake.state.installations.push({ id: 99, login: "Acme" });
      },
    });
    const seen: string[] = [];
    const result = await polled.waitForInstallation(() => jwt, {
      organization: "acme",
      onPoll: (l) => seen.push(l.status),
    });
    expect(result).toEqual({ status: "found", id: 99, login: "Acme" });
    expect(seen).toEqual(["none", "none", "found"]);
  });

  it("reports the wrong account while waiting and again at the timeout", async () => {
    const { fake, jwt } = await setup({ installations: [{ id: 5, login: "personal" }] });
    let t = 0;
    const polled = createGithubClient({
      baseUrl: fake.url,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    const seen: string[] = [];
    const result = await polled.waitForInstallation(() => jwt, {
      organization: "acme",
      timeoutMs: 9000,
      intervalMs: 3000,
      onPoll: (l) => seen.push(l.status),
    });
    expect(result).toEqual({ status: "timeout", accounts: ["personal"] });
    expect(seen.every((s) => s === "wrong_account")).toBe(true);
    expect(fake.requests.length).toBeLessThanOrEqual(4);
  });

  it("stops on request and builds a fresh JWT for every poll", async () => {
    const { fake } = await setup();
    const controller = new AbortController();
    let built = 0;
    const polled = createGithubClient({
      baseUrl: fake.url,
      sleep: async () => controller.abort(),
    });
    const result = await polled.waitForInstallation(
      () => {
        built += 1;
        return createAppJwt(fake.state.appId, pem);
      },
      { organization: "acme", signal: controller.signal },
    );
    expect(result.status).toBe("aborted");
    expect(built).toBe(1);
  });
});

describe("installation token and repositories", () => {
  it("creates a token for a known installation and 404s for another", async () => {
    const { fake, client, jwt } = await setup({ installations: [{ id: 5, login: "acme" }] });
    expect(await client.createInstallationToken(jwt, 5)).toBe(fake.state.installationToken);
    expect((await failure(client.createInstallationToken(jwt, 6))).kind).toBe("not_found");
  });

  it("lists repositories across pages, sorted", async () => {
    const repositories = Array.from(
      { length: 250 },
      (_, i) => `repo-${String(i).padStart(3, "0")}`,
    ).reverse();
    const { fake, client } = await setup({ repositories });
    const list = await client.listRepositories(fake.state.installationToken);
    expect(list.names).toHaveLength(250);
    expect(list.names[0]).toBe("repo-000");
    expect(list.truncated).toBe(false);
  });

  it("caps the list at 1,000 and says it was cut", async () => {
    const repositories = Array.from({ length: 1150 }, (_, i) => `r${i}`);
    const { fake, client } = await setup({ repositories });
    const list = await client.listRepositories(fake.state.installationToken);
    expect(list.names).toHaveLength(MAX_REPOSITORIES);
    expect(list.total).toBe(1150);
    expect(list.truncated).toBe(true);
    expect(
      fake.requests.filter((r) => r.path.startsWith("/installation/repositories")),
    ).toHaveLength(10);
  });

  it("handles an installation with no repositories", async () => {
    const { fake, client } = await setup();
    expect(await client.listRepositories(fake.state.installationToken)).toEqual({
      names: [],
      total: 0,
      truncated: false,
    });
  });
});

describe("error mapping", () => {
  const stub = (respond: () => Promise<Response>): GithubClient =>
    createGithubClient({ fetch: respond as typeof fetch });

  it("offline: a network failure, a timeout and an unreadable body", async () => {
    const down = stub(async () => {
      throw new TypeError("fetch failed ECONNREFUSED");
    });
    const error = await failure(down.getApp("x.y.z"));
    expect(error.kind).toBe("offline");
    expect(error.message).toContain("checking the App");
    expect(error.message).not.toContain("ECONNREFUSED");
  });

  it("rate limit: 429, and 403 with an exhausted quota or a retry-after", async () => {
    const make = (status: number, headers: Record<string, string>) =>
      stub(async () => new Response(JSON.stringify({ message: "x" }), { status, headers }));
    expect((await failure(make(429, {}).getApp("j"))).kind).toBe("rate_limit");
    expect((await failure(make(403, { "x-ratelimit-remaining": "0" }).getApp("j"))).kind).toBe(
      "rate_limit",
    );
    expect((await failure(make(403, { "retry-after": "30" }).getApp("j"))).kind).toBe("rate_limit");
    const plain = await failure(make(403, {}).getApp("j"));
    expect(plain.kind).toBe("forbidden");
  });

  it("401, 403, 404 and unexpected statuses have fixed text", async () => {
    const make = (status: number) =>
      stub(async () => new Response("<html>nope</html>", { status }));
    expect((await failure(make(401).getApp("j"))).message).toMatch(
      /did not accept the credentials/,
    );
    expect((await failure(make(403).getApp("j"))).message).toMatch(/refused the request/);
    expect((await failure(make(404).getApp("j"))).message).toMatch(/could not find/);
    expect((await failure(make(500).getApp("j"))).kind).toBe("unexpected");
  });

  it("does not follow redirects (credentials would travel with them)", async () => {
    let init: RequestInit | undefined;
    const client = stub(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    );
    const capturing = createGithubClient({
      fetch: (async (_url: string, i?: RequestInit) => {
        init = i;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    await capturing.getApp("j").catch(() => undefined);
    expect(init?.redirect).toBe("manual");
    expect((await failure(client.getApp("j"))).kind).toBe("unexpected");
  });

  it("an unreadable success body is unexpected", async () => {
    const client = stub(async () => new Response("not json", { status: 200 }));
    expect((await failure(client.getApp("j"))).kind).toBe("unexpected");
  });
});

describe("credential guard", () => {
  it("recognizes tokens, keys, JWTs and secret assignments", () => {
    for (const text of [
      "ghp_" + "a".repeat(36),
      "ghs_" + "B1".repeat(20),
      "github_pat_" + "x".repeat(30),
      "-----BEGIN RSA PRIVATE KEY-----",
      "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2ln",
      "Authorization: Bearer abcdefghijklmnop12345",
      "SYNC_SECRET=abcdefg",
      "x".repeat(43),
    ]) {
      expect(containsCredential(text), text).toBe(true);
    }
    for (const text of [
      "Name is already in use",
      "API rate limit exceeded for user",
      "See https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
      "a".repeat(40),
    ]) {
      expect(containsCredential(text), text).toBe(false);
    }
    expect(safeQuote("ghp_" + "a".repeat(36))).toBeNull();
    expect(safeQuote("  two\n lines ")).toBe("two lines");
    expect(redactCredentials("ok\nGITHUB_TOKEN=abcdefgh\nfine")).toBe(
      "ok\n[line hidden: it looks like it holds a credential]\nfine",
    );
  });

  it("drops a GitHub error body that quotes a credential, and keeps a clean one", async () => {
    const { fake, client } = await setup();
    const leaked = "ghp_" + "Z".repeat(36);
    fake.state.failNext = { status: 422, body: { message: `Bad value ${leaked}` } };
    const hidden = await failure(client.convertManifest("good-code"));
    expect(hidden.message).not.toContain(leaked);
    expect(hidden.message).not.toContain("GitHub said");
    fake.state.failNext = { status: 422, body: { message: "Name too long" } };
    expect((await failure(client.convertManifest("good-code"))).message).toContain(
      '"Name too long"',
    );
  });
});

describe("no secret reaches output or errors", () => {
  it("never puts the token, the key, the JWT or the webhook secret into an error", async () => {
    const { fake, client, jwt } = await setup({ installations: [{ id: 5, login: "acme" }] });
    const secrets = [
      jwt,
      pem,
      fake.state.installationToken,
      fake.state.manifestResult.webhook_secret,
    ];
    const attempts: Array<() => Promise<unknown>> = [];
    for (const status of [401, 403, 404, 422, 429, 500]) {
      attempts.push(async () => {
        fake.state.failNext = {
          status,
          body: {
            message: "Problem",
            echo: secrets.join(" "),
            token: fake.state.installationToken,
          },
        };
        return client.createInstallationToken(jwt, 5);
      });
      attempts.push(async () => {
        fake.state.failNext = {
          status,
          body: { message: `Problem ${fake.state.installationToken}` },
        };
        return client.listRepositories(fake.state.installationToken);
      });
      attempts.push(async () => {
        fake.state.failNext = { status, body: { message: `bad ${jwt}` } };
        return client.getApp(jwt);
      });
    }
    for (const attempt of attempts) {
      const error = await failure(attempt());
      for (const secret of secrets) {
        expect(error.message).not.toContain(secret);
        expect(String(error.stack)).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
      }
    }
  });
});
