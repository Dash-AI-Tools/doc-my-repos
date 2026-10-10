import { generateKeyPairSync } from "node:crypto";
import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DbHandle } from "./db/client";
import { FakeGitHub } from "./sync/fake-github";

// Throwaway App key, generated per run.
const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const PEM_LINE = PEM.split("\n")[3] as string;
const DB_PASSWORD = "SENTINELdbPassw0rd";

function env(over: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: `postgres://app:${DB_PASSWORD}@db.invalid:5432/docmyrepos`,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_INSTALLATION_ID: "4242",
    GITHUB_APP_PRIVATE_KEY: PEM,
    GITHUB_WEBHOOK_SECRET: "SENTINELwebhookSecret",
    SYNC_SECRET: "SENTINELsyncSecret",
    CONFIG_PATH: "/etc/docmyrepos.yml",
    ...over,
  };
}

const CONFIG_YAML = "repos:\n  - handbook\n  - name: metrics\n    docsPath: handbook\n";

function readFile(files: Record<string, string>) {
  return (path: string) => {
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return text;
  };
}

function fakeDb(): DbHandle & { closed: number } {
  const handle = {
    db: {} as DbHandle["db"],
    pool: {} as DbHandle["pool"],
    closed: 0,
    close: async () => {
      handle.closed++;
    },
  };
  return handle;
}

afterEach(() => {
  // Each test builds its own runtime; never leave a shared one behind.
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("docmyrepos.runtime")];
});

describe("runtime", () => {
  it("has no side effects at import time", async () => {
    vi.resetModules();
    const read = vi.fn();
    vi.doMock("./config/load", async (orig) => {
      const mod = await orig<typeof import("./config/load")>();
      return {
        ...mod,
        loadConfig: (...args: Parameters<typeof mod.loadConfig>) => (
          read(),
          mod.loadConfig(...args)
        ),
      };
    });
    try {
      await import("./runtime");
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("./config/load");
      vi.resetModules();
    }
  });

  it("builds the sync context from config file and environment", async () => {
    const { createRuntime } = await import("./runtime");
    const db = fakeDb();
    const urls: string[] = [];
    const rt = createRuntime({
      env: env(),
      readFile: readFile({ "/etc/docmyrepos.yml": CONFIG_YAML }),
      createDb: (url) => (urls.push(url), db),
    });
    expect(urls).toEqual([`postgres://app:${DB_PASSWORD}@db.invalid:5432/docmyrepos`]);
    expect(rt.sync.db).toBe(db.db);
    expect(rt.sync.pool).toBe(db.pool);
    expect(rt.sync.config.repos).toEqual(["handbook", { name: "metrics", docsPath: "handbook" }]);
    expect(rt.sync.config.defaults.docsPaths).toEqual(["docs", "doc", "documentation"]);
    expect(rt.loaded.configFile).toEqual({ path: "/etc/docmyrepos.yml", found: true });
    await rt.close();
    expect(db.closed).toBe(1);
  });

  it("mints an installation token and lists repositories through the injected fetch", async () => {
    const { createRuntime } = await import("./runtime");
    const fake = new FakeGitHub({
      installationId: 4242,
      token: "ghs_SENTINELruntimeToken",
      repos: [{ id: 1, name: "handbook" }],
    });
    const rt = createRuntime({
      env: env({ CONFIG_PATH: undefined }),
      readFile: readFile({}),
      fetch: fake.fetch,
      createDb: fakeDb,
    });
    const listed = await rt.github.listInstallationRepositories();
    expect(listed.map((r) => r.name)).toEqual(["handbook"]);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /app/installations/4242/access_tokens",
      "GET /installation/repositories",
    ]);
    // Never prints a secret.
    const printed = [inspect(rt, { depth: 10, showHidden: true }), JSON.stringify({ rt })].join(
      "\n",
    );
    for (const secret of [
      PEM_LINE,
      DB_PASSWORD,
      "ghs_SENTINELruntimeToken",
      "SENTINELsyncSecret",
    ]) {
      expect(printed).not.toContain(secret);
    }
  });

  it("throws a ConfigError that names variables without printing values", async () => {
    const { createRuntime } = await import("./runtime");
    let error: unknown;
    try {
      createRuntime({
        env: env({ GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: "not a key SENTINELbadKey" }),
        readFile: readFile({ "/etc/docmyrepos.yml": CONFIG_YAML }),
        createDb: fakeDb,
      });
    } catch (e) {
      error = e;
    }
    // By name: the import-time test resets the module registry, so class identity differs.
    expect((error as Error).name).toBe("ConfigError");
    const text = `${String(error)}\n${inspect(error)}`;
    expect(text).toContain("GITHUB_APP_ID");
    expect(text).toContain("GITHUB_APP_PRIVATE_KEY");
    for (const secret of ["SENTINELbadKey", DB_PASSWORD, "SENTINELsyncSecret"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("getRuntime builds once, caches, and does not cache a failure", async () => {
    const { getRuntime, closeRuntime } = await import("./runtime");
    const files = readFile({ "/etc/docmyrepos.yml": CONFIG_YAML });
    expect(() =>
      getRuntime({ env: env({ SYNC_SECRET: "" }), readFile: files, createDb: fakeDb }),
    ).toThrow(/Invalid configuration/);

    const db = fakeDb();
    const first = getRuntime({ env: env(), readFile: files, createDb: () => db });
    const second = getRuntime({ env: { SYNC_SECRET: "ignored once built" } });
    expect(second).toBe(first);

    await closeRuntime();
    expect(db.closed).toBe(1);
    const third = getRuntime({ env: env(), readFile: files, createDb: fakeDb });
    expect(third).not.toBe(first);
    await closeRuntime();
  });
  it("reloadRuntime re-reads the config, keeps the database handle and replaces the cache", async () => {
    const { getRuntime, reloadRuntime, closeRuntime } = await import("./runtime");
    const files: Record<string, string> = { "/etc/docmyrepos.yml": CONFIG_YAML };
    const db = fakeDb();
    const first = getRuntime({ env: env(), readFile: readFile(files), createDb: () => db });
    expect(first.sync.config.repos).toEqual([
      "handbook",
      { name: "metrics", docsPath: "handbook" },
    ]);

    files["/etc/docmyrepos.yml"] = "repos:\n  - runbooks\n";
    const second = reloadRuntime({ env: env(), readFile: readFile(files) });
    expect(second).not.toBe(first);
    expect(second.sync.config.repos).toEqual(["runbooks"]);
    // The pool is shared, never closed or reopened by a reload.
    expect(second.db).toBe(db);
    expect(second.sync.pool).toBe(db.pool);
    expect(db.closed).toBe(0);
    expect(getRuntime()).toBe(second);
    // The earlier runtime (maybe mid-sync) keeps the config it started with.
    expect(first.sync.config.repos).toEqual([
      "handbook",
      { name: "metrics", docsPath: "handbook" },
    ]);

    await closeRuntime();
    expect(db.closed).toBe(1);
  });

  it("reloadRuntime keeps the previous runtime when the new config is invalid", async () => {
    const { getRuntime, reloadRuntime, closeRuntime } = await import("./runtime");
    const files: Record<string, string> = { "/etc/docmyrepos.yml": CONFIG_YAML };
    const db = fakeDb();
    const first = getRuntime({ env: env(), readFile: readFile(files), createDb: () => db });

    files["/etc/docmyrepos.yml"] = "reposs: SENTINELfileText\n";
    let error: unknown;
    try {
      reloadRuntime({ env: env(), readFile: readFile(files) });
    } catch (e) {
      error = e;
    }
    expect((error as Error).name).toBe("ConfigError");
    expect(`${String(error)}${inspect(error)}`).not.toContain("SENTINELfileText");
    expect(getRuntime()).toBe(first);
    expect(db.closed).toBe(0);
    await closeRuntime();
  });

  it("reloadRuntime builds a runtime when none exists yet", async () => {
    const { getRuntime, reloadRuntime, closeRuntime } = await import("./runtime");
    const db = fakeDb();
    const rt = reloadRuntime({
      env: env(),
      readFile: readFile({ "/etc/docmyrepos.yml": CONFIG_YAML }),
      createDb: () => db,
    });
    expect(getRuntime()).toBe(rt);
    await closeRuntime();
    expect(db.closed).toBe(1);
  });
});
