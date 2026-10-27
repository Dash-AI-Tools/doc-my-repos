import { generateKeyPairSync } from "node:crypto";
import { format, inspect } from "node:util";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigError } from "../config/errors";
import { DEFAULT_CONNECT_TIMEOUT_MS, closeDb, createDb, describeDbError, getDb } from "./client";
import { MigrationError, migrateDatabase } from "./migrate";
import { createTestDatabase, describeDb } from "./test-db";

const PASSWORD = "s3cr3t-Passw0rd";
const USER = "leakuser";
// Port 1 on loopback refuses immediately; no server is needed.
const UNREACHABLE = `postgres://${USER}:${PASSWORD}@127.0.0.1:1/leakdb`;
const MALFORMED = [
  `postgres://${USER}:${PASSWORD}@/leakdb`,
  `http://${USER}:${PASSWORD}@127.0.0.1/leakdb`,
  `postgres://${USER}:${PASSWORD}@[::1/leakdb`,
  `${USER}:${PASSWORD}`,
];

/** Everything an error could show a log reader: message, stack, JSON and inspect output. */
function everything(error: unknown): string {
  const parts = [String(error), error instanceof Error ? (error.stack ?? "") : ""];
  try {
    parts.push(JSON.stringify(error, Object.getOwnPropertyNames(error as object)));
  } catch {
    // not serializable: nothing to leak through it
  }
  return parts.join("\n");
}

function expectNoLeak(text: string): void {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(USER);
  expect(text).not.toContain("leakdb");
}

async function caught(promise: PromiseLike<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("createDb", () => {
  it("throws a fixed message, without the URL, for a malformed URL", () => {
    for (const url of MALFORMED) {
      let error: unknown;
      try {
        createDb(url);
      } catch (e) {
        error = e;
      }
      expect(error, url.replace(PASSWORD, "***")).toBeInstanceOf(Error);
      expectNoLeak(everything(error));
      expect((error as Error).message).toContain("DATABASE_URL");
    }
  });

  it("does not connect until the first query", async () => {
    const handle = createDb(UNREACHABLE);
    expect(handle.pool.totalCount).toBe(0);
    await handle.close();
  });

  it("rejects queries to an unreachable server without the URL in the error", async () => {
    const handle = createDb(UNREACHABLE);
    try {
      const error = await caught(handle.db.execute(sql`select 1`));
      expectNoLeak(everything(error));
      expect(describeDbError(error)).toMatch(/^database error \(ECONNREFUSED\)$/);
    } finally {
      await handle.close();
    }
  });

  it("closes the pool, and closing twice is fine", async () => {
    const handle = createDb(UNREACHABLE);
    await handle.close();
    await handle.close();
    expect(handle.pool.ended).toBe(true);
  });
});

describe("connection timeout", () => {
  // 10.255.255.1 is non-routable: SYNs get no answer, so only the timeout can end the attempt.
  const BLACKHOLE = `postgres://${USER}:${PASSWORD}@10.255.255.1:5432/leakdb`;

  it("fails an unreachable host within the bound with a fixed timeout message", async (ctx) => {
    const handle = createDb(BLACKHOLE, { connectTimeoutMs: 500 });
    const started = Date.now();
    try {
      const error = await caught(handle.pool.query("select 1"));
      const description = describeDbError(error);
      if (/ENETUNREACH|EHOSTUNREACH|EACCES|EPERM/.test(description)) {
        // A network sandbox answered at once instead of dropping packets; nothing to time out.
        ctx.skip(`network refused 10.255.255.1 immediately: ${description}`);
      }
      expect(description).toBe("database error (timeout)");
      expect(Date.now() - started).toBeLessThan(5_000);
      expectNoLeak(everything(error));
    } finally {
      await handle.close();
    }
  }, 15_000);

  it("reports a timeout through migrateDatabase as exit-ready text without the URL", async (ctx) => {
    const folder = new URL("../../../../drizzle", import.meta.url).pathname;
    const started = Date.now();
    const error = await caught(
      migrateDatabase({ DATABASE_URL: BLACKHOLE }, folder, { connectTimeoutMs: 500 }),
    );
    if (/ENETUNREACH|EHOSTUNREACH|EACCES|EPERM/.test((error as Error).message)) {
      ctx.skip(`network refused 10.255.255.1 immediately: ${(error as Error).message}`);
    }
    expect((error as Error).message).toBe(
      "DATABASE_URL: database not reachable after 1 attempt, database error (timeout)",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it("uses a 10 second default", () => {
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(10_000);
  });
});

// Distinctive values planted in the URL: none may appear when a handle is logged.
const SENT = {
  user: "sentinel_user_u7",
  password: "sentinel_pass_p9",
  host: "sentinel-host-h3.invalid",
  database: "sentinel_db_d5",
};
const SENTINEL_URL = `postgres://${SENT.user}:${SENT.password}@${SENT.host}:5432/${SENT.database}`;

/** Every way a developer could log or serialize `value`. */
function renderings(value: unknown): string[] {
  const out = [
    inspect(value, { showHidden: true, depth: null }),
    inspect(value),
    String(value),
    format("%o %O %s %j", value, value, value, value),
    format("%o", value),
    format("%j", value),
  ];
  out.push(JSON.stringify(value));
  return out;
}

function expectRedacted(value: unknown, forbidden: string[]): void {
  for (const text of renderings(value)) {
    for (const word of forbidden) expect(text).not.toContain(word);
  }
  expect(inspect(value, { showHidden: true, depth: null })).toBe("[redacted]");
  expect(JSON.stringify(value)).toBe('"[redacted]"');
  expect(String(value)).toBe("[redacted]");
}

describe("logging a database handle", () => {
  afterEach(async () => {
    await closeDb();
    vi.unstubAllEnvs();
  });

  const forbidden = Object.values(SENT);

  it("redacts the createDb handle, its pool and its db", async () => {
    const handle = createDb(SENTINEL_URL);
    try {
      expectRedacted(handle, forbidden);
      expectRedacted(handle.pool, forbidden);
      expectRedacted(handle.db, forbidden);
      // Nested inside a plain object, the handle is still hidden.
      const nested = inspect({ handle, rows: [handle.pool] }, { showHidden: true, depth: null });
      for (const word of forbidden) expect(nested).not.toContain(word);
    } finally {
      await handle.close();
    }
  });

  it("keeps the pool and db usable by Drizzle and the driver", async () => {
    const handle = createDb(SENTINEL_URL);
    try {
      expect(handle.pool.options.max).toBeGreaterThan(0);
      expect(typeof handle.pool.query).toBe("function");
      expect(typeof handle.db.select).toBe("function");
      expect(Object.keys(handle)).toEqual(["db", "pool", "close"]);
    } finally {
      await handle.close();
    }
  });

  it("redacts the shared getDb handle", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    vi.stubEnv("CONFIG_PATH", "");
    vi.stubEnv("GITHUB_APP_ID", "1");
    vi.stubEnv("GITHUB_APP_INSTALLATION_ID", "2");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY_PATH", "");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret-0123");
    vi.stubEnv("SYNC_SECRET", "sync-secret-0123456");
    vi.stubEnv("SESSION_SECRET", "session-secret-01234567890");
    vi.stubEnv("DATABASE_URL", SENTINEL_URL);
    const handle = getDb();
    expectRedacted(handle, forbidden);
    expectRedacted(handle.pool, forbidden);
    expectRedacted(handle.db, forbidden);
  });
});

describeDb("logging the test database helper result", () => {
  it("redacts the result, its pool, its db and its url", async () => {
    const t = await createTestDatabase();
    try {
      expectRedacted(t, ["docmyrepos_test_"]);
      expectRedacted(t.pool, ["docmyrepos_test_"]);
      expectRedacted(t.db, ["docmyrepos_test_"]);
      expectRedacted(t.url, ["docmyrepos_test_"]);
    } finally {
      await t.drop();
    }
  }, 60_000);
});

describe("describeDbError", () => {
  it("reports a connection timeout as `timeout`", () => {
    expect(describeDbError(new Error("timeout exceeded when trying to connect"))).toBe(
      "database error (timeout)",
    );
    expect(
      describeDbError(
        new Error("Connection terminated due to connection timeout", { cause: new Error("x") }),
      ),
    ).toBe("database error (timeout)");
  });

  it("reports only a code, never a message", () => {
    expect(describeDbError(Object.assign(new Error(`user ${USER}`), { code: "28P01" }))).toBe(
      "database error (28P01)",
    );
    expect(describeDbError(new Error(PASSWORD))).toBe("database error (unknown error)");
    expect(describeDbError(Object.assign(new Error("x"), { code: `bad ${PASSWORD}` }))).toBe(
      "database error (unknown error)",
    );
    expect(describeDbError("nope")).toBe("database error (unknown error)");
  });
});

describe("migrateDatabase", () => {
  const folder = new URL("../../../../drizzle", import.meta.url).pathname;

  it("fails with the variable name and an error code for an unreachable database", async () => {
    const error = await caught(migrateDatabase({ DATABASE_URL: UNREACHABLE }, folder));
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toBe(
      "DATABASE_URL: database not reachable after 1 attempt, database error (ECONNREFUSED)",
    );
    expectNoLeak(everything(error));
  });

  it("fails with the variable name for a malformed URL, without the URL", async () => {
    for (const url of MALFORMED) {
      const error = await caught(migrateDatabase({ DATABASE_URL: url }, folder));
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as Error).message).toMatch(/^DATABASE_URL: /);
      expectNoLeak(everything(error));
    }
  });

  it("fails when DATABASE_URL is not set, and needs no other variable", async () => {
    const error = await caught(migrateDatabase({}, folder));
    expect((error as Error).message).toBe("DATABASE_URL: is not set");
  });
});

describe("getDb", () => {
  afterEach(async () => {
    await closeDb();
    vi.unstubAllEnvs();
  });

  const stubAppEnv = (databaseUrl: string | undefined) => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    vi.stubEnv("CONFIG_PATH", "");
    vi.stubEnv("GITHUB_APP_ID", "1");
    vi.stubEnv("GITHUB_APP_INSTALLATION_ID", "2");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY_PATH", "");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret-0123");
    vi.stubEnv("SYNC_SECRET", "sync-secret-0123456");
    vi.stubEnv("SESSION_SECRET", "session-secret-01234567890");
    vi.stubEnv("DATABASE_URL", databaseUrl);
  };

  it("creates the handle lazily from the validated config and caches it", async () => {
    stubAppEnv(UNREACHABLE);
    const first = getDb();
    expect(getDb()).toBe(first);
    await closeDb();
    expect(getDb()).not.toBe(first);
  });

  it("throws a ConfigError that does not hold the URL when the config is invalid", () => {
    stubAppEnv(`postgres://${USER}:${PASSWORD}@/leakdb`);
    let error: unknown;
    try {
      getDb();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expectNoLeak(everything(error));
  });
});
