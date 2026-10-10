import { afterEach, describe, expect, it, vi } from "vitest";

import { Secret } from "./config/secret";
import { redactWhenLogged } from "./db/client";
import { GitHubError } from "./github/client";
import {
  createLogger,
  errorFields,
  logger,
  logLevelFromEnv,
  MAX_ITEMS,
  MAX_STRING_LENGTH,
  parseLogLevel,
  REDACTED,
  sanitizeValue,
  scrubString,
  type LogLevel,
  type LogThreshold,
} from "./log";
import { PersistError } from "./sync/persist";
import { RepoSyncError } from "./sync/runs";
import { captureOutput } from "./test-logger";

function memory(level: LogThreshold = "debug") {
  const written: { line: string; level: LogLevel }[] = [];
  const log = createLogger({
    level,
    write: (line, lvl) => written.push({ line, level: lvl }),
    now: () => new Date("2026-10-10T12:00:00.000Z"),
  });
  const records = () => written.map((w) => JSON.parse(w.line) as Record<string, unknown>);
  return { log, written, records };
}

const GH_TOKEN = "ghs_16C7e42F292c6912E7710c838347Ae178B4a";
const PAT = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";
const JWT =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIxMjM0NSIsImlhdCI6MTcwMDAwMDAwMH0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU";
const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAuSENTINELKEYBODY0123456789abcdef\n-----END RSA PRIVATE KEY-----";
const SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

describe("log line format", () => {
  it("writes one JSON object per line with ts, level, service and event first", () => {
    const m = memory();
    m.log.info("sync.run.finished", { runId: 7, status: "success", durationMs: 12 });
    expect(m.written).toHaveLength(1);
    const { line, level } = m.written[0]!;
    expect(level).toBe("info");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(Object.keys(JSON.parse(line))).toEqual([
      "ts",
      "level",
      "service",
      "event",
      "runId",
      "status",
      "durationMs",
    ]);
    expect(JSON.parse(line)).toEqual({
      ts: "2026-10-10T12:00:00.000Z",
      level: "info",
      service: "docmyrepos",
      event: "sync.run.finished",
      runId: 7,
      status: "success",
      durationMs: 12,
    });
  });

  it("adds child bindings to every line, and nested children add theirs", () => {
    const m = memory();
    const run = m.log.child({ runId: 3 });
    run.child({ githubId: 42 }).warn("sync.repo.done", { status: "error" });
    run.info("sync.run.started");
    expect(m.records()).toEqual([
      expect.objectContaining({ runId: 3, githubId: 42, status: "error", level: "warn" }),
      expect.objectContaining({ runId: 3, event: "sync.run.started" }),
    ]);
    expect(m.records()[1]).not.toHaveProperty("githubId");
  });

  it("keeps the reserved keys: a field named like one is renamed", () => {
    const m = memory();
    m.log.info("a.b", { event: "push", level: "x", ts: 1, service: "y" });
    expect(m.records()[0]).toMatchObject({
      event: "a.b",
      level: "info",
      service: "docmyrepos",
      field_event: "push",
      field_level: "x",
      field_ts: 1,
      field_service: "y",
    });
  });

  it("replaces an event name that is not a dotted lower-case word", () => {
    const m = memory();
    for (const bad of ["Sync Run", "a\nb", "", "x".repeat(65), "ghs_abc def", "a..b"]) {
      m.log.info(bad);
    }
    expect(m.records().map((r) => r.event)).toEqual(Array(6).fill("invalid_event"));
  });

  it("drops undefined fields and prints non-finite numbers and bigints as text", () => {
    const m = memory();
    m.log.info("a.b", { gone: undefined, nan: Number.NaN, inf: Infinity, big: 10n, ok: null });
    expect(m.records()[0]).toMatchObject({ nan: "NaN", inf: "Infinity", big: "10", ok: null });
    expect(m.records()[0]).not.toHaveProperty("gone");
  });

  it("sends debug and info to stdout, warn and error to stderr", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const log = createLogger({ level: "debug" });
      log.debug("a.debug");
      log.info("a.info");
      log.warn("a.warn");
      log.error("a.error");
      expect(out.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toEqual([
        "a.debug",
        "a.info",
      ]);
      expect(err.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toEqual([
        "a.warn",
        "a.error",
      ]);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

describe("levels", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses the five thresholds case-insensitively and rejects anything else", () => {
    expect(["debug", "INFO", " warn ", "Error", "silent"].map(parseLogLevel)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
      "silent",
    ]);
    for (const bad of ["verbose", "", "trace", "0", undefined, 3]) {
      expect(parseLogLevel(bad)).toBeNull();
    }
  });

  it("defaults to info, also for an unknown LOG_LEVEL", () => {
    expect(logLevelFromEnv({})).toBe("info");
    expect(logLevelFromEnv({ LOG_LEVEL: "" })).toBe("info");
    expect(logLevelFromEnv({ LOG_LEVEL: "loud" })).toBe("info");
    expect(logLevelFromEnv({ LOG_LEVEL: "warn" })).toBe("warn");
  });

  it("filters below the threshold", () => {
    const m = memory("warn");
    m.log.debug("a.b");
    m.log.info("a.b");
    m.log.warn("a.b");
    m.log.error("a.b");
    expect(m.written.map((w) => w.level)).toEqual(["warn", "error"]);
  });

  it("LOG_LEVEL=silent suppresses every line of the default logger", () => {
    const output = captureOutput("silent");
    try {
      logger.debug("a.b");
      logger.info("a.b");
      logger.warn("a.b");
      logger.error("a.b");
      expect(output.text()).toBe("");
    } finally {
      output.restore();
    }
  });

  it("an unknown LOG_LEVEL falls back to info for the default logger", () => {
    const output = captureOutput("chatty");
    try {
      logger.debug("a.debug");
      logger.info("a.info");
      expect(output.records().map((r) => r.event)).toEqual(["a.info"]);
    } finally {
      output.restore();
    }
  });

  it("reads LOG_LEVEL on every call", () => {
    const output = captureOutput("error");
    try {
      logger.warn("a.first");
      process.env.LOG_LEVEL = "debug";
      logger.debug("a.second");
      expect(output.records().map((r) => r.event)).toEqual(["a.second"]);
    } finally {
      output.restore();
    }
  });
});

describe("redaction by key", () => {
  it.each([
    "token",
    "installationToken",
    "access_token",
    "secret",
    "webhookSecret",
    "SYNC_SECRET",
    "password",
    "dbPassword",
    "passwd",
    "authorization",
    "Authorization",
    "cookie",
    "set-cookie",
    "privateKey",
    "private_key",
    "GITHUB_APP_PRIVATE_KEY",
    "jwt",
    "appJwt",
    "signature",
    "x-hub-signature-256",
    "apiKey",
    "api_key",
    "credentials",
    "sessionId",
  ])("redacts the value under %s, at any depth and in arrays", (key) => {
    const m = memory();
    m.log.info("a.b", {
      [key]: "visible-value-1",
      nested: { deeper: { [key]: { inner: "visible-value-2" } } },
      list: [{ [key]: ["visible-value-3"] }],
    });
    const line = m.written[0]!.line;
    expect(line).not.toContain("visible-value");
    const record = m.records()[0]!;
    expect(record[key]).toBe(REDACTED);
    expect(record).toMatchObject({
      nested: { deeper: { [key]: REDACTED } },
      list: [{ [key]: REDACTED }],
    });
  });

  it("keeps ordinary keys", () => {
    expect(
      sanitizeValue({ githubId: 1, status: "ok", event: "push", tokenless: undefined }),
    ).toEqual({ githubId: 1, status: "ok", event: "push" });
  });
});

describe("redaction by value", () => {
  it.each([
    ["a PEM block", `key ${PEM} end`, ["SENTINELKEYBODY", "BEGIN RSA", "END RSA"]],
    [
      "a PEM header without footer",
      `-----BEGIN PRIVATE KEY-----\nMIIBSENTINELTAIL`,
      ["SENTINELTAIL"],
    ],
    ["a Bearer credential", `Authorization: Bearer s3cr3t-SENTINEL-value`, ["s3cr3t-SENTINEL"]],
    ["a Basic credential", `basic dXNlcjpTRU5USU5FTA==`, ["dXNlcjpTRU5USU5FTA"]],
    ["a token scheme credential", `token abcdefghijklmnopqrstuvwxyz012345`, ["abcdefghijklmnop"]],
    ["an installation token", `got ${GH_TOKEN} back`, [GH_TOKEN.slice(4)]],
    ["a personal access token", `pat ${PAT}`, [PAT.slice(11)]],
    [
      "gho/ghu/ghr/ghp tokens",
      "gho_aaaaBBBB1 ghu_ccccDDDD2 ghr_eeeeFFFF3 ghp_ggggHHHH4",
      ["aaaaBBBB1", "ccccDDDD2", "eeeeFFFF3", "ggggHHHH4"],
    ],
    ["a JWT", `jwt=${JWT}`, [JWT.slice(0, 20), JWT.slice(-20)]],
    ["a bare JWT", `the app jwt ${JWT} expired`, ["eyJhbGciOiJSUzI1NiIs"]],
    [
      "database URL credentials",
      "postgres://docmyrepos:SENTINELpw@db:5432/x",
      ["SENTINELpw", "docmyrepos:"],
    ],
    [
      "URL credentials of any scheme",
      "https://user:hunter2-SENTINEL@example.com/x",
      ["hunter2-SENTINEL"],
    ],
    ["a secret query parameter", "https://x.test/?access_token=SENTINELqp&x=1", ["SENTINELqp"]],
    ["a long random run", "seed Xk9mQ2vL8pR4tW7yZ1aB3cD5eF6gH0jK done", ["Xk9mQ2vL8pR4tW7yZ1aB"]],
  ])("scrubs %s", (_label, input, forbidden) => {
    const out = scrubString(input);
    for (const f of forbidden) expect(out).not.toContain(f);
    expect(out).toContain(REDACTED);
  });

  it("leaves git SHAs, ids, counts and ordinary words alone", () => {
    for (const ok of [
      SHA,
      "a".repeat(64),
      "acme/handbook",
      "database error (ECONNREFUSED)",
      "GitHub rejected the installation token",
      "sync.run.finished",
      "docs/guides/setup.md",
      "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    ]) {
      expect(scrubString(ok)).toBe(ok);
    }
  });

  it("scrubs inside nested objects and arrays", () => {
    const m = memory();
    m.log.error("a.b", { detail: { list: [`x ${GH_TOKEN}`, { deep: `Bearer ${JWT}` }] } });
    expect(m.written[0]!.line).not.toContain(GH_TOKEN);
    expect(m.written[0]!.line).not.toContain(JWT);
  });

  it("also scrubs keys", () => {
    expect(Object.keys(sanitizeValue({ [`k ${GH_TOKEN}`]: 1 }) as object)).toEqual([
      `k ${REDACTED}`,
    ]);
  });
});

describe("log injection", () => {
  it("never writes a raw line break, NUL, U+2028/U+2029 or bidi control", () => {
    const m = memory();
    const nasty = [
      'a\nFAKE {"level":"error"}',
      "b\r\nc",
      "d\u0000e",
      "f g h",
      "i‮j⁦k",
      "l\u001b[31mred",
      "m\tn",
    ];
    m.log.warn("a.b", { nasty, key: nasty[0], [`k\ney`]: 1 });
    const line = m.written[0]!.line;
    expect(line.indexOf("\n")).toBe(line.length - 1);
    for (const ch of ["\r", "\u0000", " ", " ", "‮", "⁦", "\u001b", "\t"]) {
      expect(line).not.toContain(ch);
    }
    const record = m.records()[0]!;
    expect(record.key).toBe('a FAKE {"level":"error"}');
    expect(record).toHaveProperty("k ey", 1);
  });
});

describe("limits", () => {
  it("truncates long strings", () => {
    const out = sanitizeValue("x".repeat(10_000)) as string;
    expect(out.startsWith("x".repeat(MAX_STRING_LENGTH))).toBe(true);
    expect(out.length).toBeLessThan(MAX_STRING_LENGTH + 20);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("handles a huge string quickly and still scrubs a token near its start", () => {
    const start = Date.now();
    const out = sanitizeValue(`${GH_TOKEN} ${"y".repeat(5_000_000)}`) as string;
    expect(Date.now() - start).toBeLessThan(500);
    expect(out).not.toContain(GH_TOKEN);
  });

  it("limits depth, list length and key count", () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(JSON.stringify(sanitizeValue(deep))).toContain("[object]");
    const list = sanitizeValue(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
    expect(list).toHaveLength(MAX_ITEMS + 1);
    expect(list.at(-1)).toBe(`[+${100 - MAX_ITEMS} more]`);
    const wide = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]));
    expect(sanitizeValue(wide)).toHaveProperty("_truncatedKeys", 30);
  });

  it("prints circular references as [circular] and shared ones in full", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const shared = { x: 1 };
    const list: unknown[] = [shared, shared];
    list.push(list);
    expect(sanitizeValue(a)).toEqual({ name: "a", self: "[circular]" });
    expect(sanitizeValue(list)).toEqual([{ x: 1 }, { x: 1 }, "[circular]"]);
  });
});

describe("special values", () => {
  it("prints a Secret as [redacted], wherever it sits", () => {
    const secret = new Secret("SENTINEL-secret-value");
    const m = memory();
    m.log.info("a.b", { value: secret, list: [secret], nested: { s: secret } });
    expect(m.written[0]!.line).not.toContain("SENTINEL");
    expect(m.records()[0]).toMatchObject({
      value: REDACTED,
      list: [REDACTED],
      nested: { s: REDACTED },
    });
    // The wrapper's own serializers agree.
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(String(secret)).toBe(REDACTED);
  });

  it("prints the redacted handles (own toJSON) as [redacted]", () => {
    const handle = redactWhenLogged({ url: "postgres://u:SENTINELpw@h/db", n: 1 });
    expect(sanitizeValue({ handle })).toEqual({ handle: REDACTED });
  });

  it("summarises non-plain objects by class name", () => {
    const fields = sanitizeValue({
      request: new Request("http://x.test/?token=SENTINEL", {
        headers: { authorization: "Bearer SENTINEL" },
      }),
      response: new Response("SENTINEL body"),
      buffer: Buffer.from("SENTINEL"),
      bytes: new Uint8Array([1, 2]),
      map: new Map([["k", "SENTINEL"]]),
      url: new URL("https://u:SENTINEL@x.test/"),
      klass: new (class Pool {
        options = { connectionString: "postgres://u:SENTINEL@h/db" };
      })(),
      fn: () => "SENTINEL",
      sym: Symbol("SENTINEL"),
      date: new Date("2026-01-02T03:04:05.000Z"),
      bad: new Date(Number.NaN),
    });
    expect(JSON.stringify(fields)).not.toContain("SENTINEL");
    expect(fields).toEqual({
      request: "[Object Request]",
      response: "[Object Response]",
      buffer: "[Object Buffer]",
      bytes: "[Object Uint8Array]",
      map: "[Object Map]",
      url: "[Object URL]",
      klass: "[Object Pool]",
      fn: "[function]",
      sym: "[symbol]",
      date: "2026-01-02T03:04:05.000Z",
      bad: "[invalid date]",
    });
  });

  it("survives getters that throw and proxies", () => {
    const hostile = {
      get boom(): string {
        throw new Error("SENTINEL getter");
      },
    };
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("SENTINEL proxy");
        },
      },
    );
    const m = memory();
    m.log.info("a.b", { hostile, proxy });
    expect(m.written[0]!.line).not.toContain("SENTINEL");
    expect(m.records()[0]).toMatchObject({ hostile: { boom: "[unserializable]" } });
  });
});

describe("errors", () => {
  it("never exposes message, stack or cause", () => {
    const cause = Object.assign(new Error(`cause postgres://u:SENTINELpw@h/db`), {
      code: "28P01",
    });
    const error = new Error(`boom ${GH_TOKEN} SENTINELmsg`, { cause });
    const m = memory();
    m.log.error("a.b", { error, nested: { list: [error] } });
    const line = m.written[0]!.line;
    for (const f of ["SENTINEL", "boom", "at ", "stack", "cause", GH_TOKEN]) {
      expect(line).not.toContain(f);
    }
    expect(m.records()[0]).toMatchObject({
      error: { errorName: "Error", code: "28P01" },
      nested: { list: [{ errorName: "Error", code: "28P01" }] },
    });
  });

  it("uses the safe vocabularies of GitHub, persist, sync and OS errors", () => {
    expect(errorFields(new GitHubError("rate_limited", 403, 61_000.4))).toEqual({
      errorName: "GitHubError",
      errorKind: "rate_limited",
      status: 403,
      retryAfterMs: 61_000,
    });
    expect(errorFields(new GitHubError("installation_unavailable", 404))).toEqual({
      errorName: "GitHubError",
      errorKind: "installation_unavailable",
      status: 404,
    });
    expect(errorFields(new RepoSyncError("tree_truncated"))).toEqual({
      errorName: "RepoSyncError",
      errorKind: "tree_truncated",
    });
    expect(errorFields(new PersistError("database", "insert failed: SENTINEL", "23505"))).toEqual({
      errorName: "PersistError",
      errorKind: "database",
      code: "23505",
    });
    expect(
      errorFields(
        Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), {
          code: "ECONNREFUSED",
        }),
      ),
    ).toEqual({ errorName: "Error", code: "ECONNREFUSED" });
    // Drizzle wraps the driver error in `cause`.
    expect(
      errorFields(
        new Error("Failed query: select secret", {
          cause: Object.assign(new Error("x"), { code: "57P01" }),
        }),
      ),
    ).toEqual({ errorName: "Error", code: "57P01" });
  });

  it("ignores unsafe names, kinds, codes and statuses", () => {
    const weird = Object.assign(new Error("m"), {
      name: "Bad Name\nINJECT",
      kind: "Not A Word",
      code: "lower-case secret",
      status: 9999,
      retryAfterMs: -1,
    });
    expect(errorFields(weird)).toEqual({ errorName: "Error" });
    expect(errorFields("a string with ghs_abc")).toEqual({ errorName: "non_error_string" });
    expect(errorFields(undefined)).toEqual({ errorName: "non_error_undefined" });
  });

  it("reports a ConfigError by kind only, never its problems", () => {
    const error = Object.assign(new Error("Invalid configuration: SYNC_SECRET"), {
      name: "ConfigError",
      problems: ["SYNC_SECRET: too short"],
    });
    expect(errorFields(error)).toEqual({ errorName: "ConfigError", errorKind: "config" });
  });
});

describe("never throws", () => {
  it("swallows a failing writer", () => {
    const log = createLogger({
      level: "debug",
      write: () => {
        throw new Error("disk full");
      },
    });
    expect(() => log.error("a.b", { x: 1 })).not.toThrow();
  });

  it("swallows a throwing stdout and stderr", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw new Error("EPIPE");
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("EPIPE");
    });
    try {
      const log = createLogger({ level: "debug" });
      expect(() => log.info("a.b")).not.toThrow();
      expect(() => log.error("a.b")).not.toThrow();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it("swallows a throwing clock and odd fields", () => {
    const log = createLogger({
      level: "debug",
      now: () => {
        throw new Error("clock");
      },
      write: () => undefined,
    });
    expect(() => log.info("a.b")).not.toThrow();
    const m = memory();
    expect(() => m.log.info("a.b", null as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => m.log.info("a.b", "text" as unknown as Record<string, unknown>)).not.toThrow();
    expect(m.records()).toHaveLength(2);
  });
});
