import { describe, expect, it } from "vitest";

import { parseDatabaseUrl } from "./env";

const PASSWORD = "pw-sentinel-9f3";

function ok(url: string): string {
  const result = parseDatabaseUrl({ DATABASE_URL: url });
  expect(result.problems, url.replace(PASSWORD, "***")).toEqual([]);
  expect(result.url).not.toBeNull();
  return result.url!.reveal();
}

function problems(env: Record<string, string | undefined>): string[] {
  const result = parseDatabaseUrl(env);
  expect(result.url).toBeNull();
  expect(result.problems.length).toBeGreaterThan(0);
  return result.problems;
}

describe("parseDatabaseUrl", () => {
  it("accepts postgres:// and postgresql:// URLs and returns the trimmed value", () => {
    expect(ok(`postgres://u:${PASSWORD}@db.example.com:5432/app`)).toBe(
      `postgres://u:${PASSWORD}@db.example.com:5432/app`,
    );
    expect(ok("postgresql://u@localhost/app")).toBe("postgresql://u@localhost/app");
    expect(ok("  postgres://localhost/app  ")).toBe("postgres://localhost/app");
  });

  it("accepts a socket host given as ?host= without a hostname", () => {
    expect(ok("postgres:///app?host=/var/run/postgresql")).toContain("host=");
  });

  it("accepts credentials with a socket host (Cloud SQL form)", () => {
    expect(ok(`postgres://u:${PASSWORD}@/app?host=/cloudsql/proj:region:inst`)).toContain("@/app");
  });

  it("rejects a URL with no host and no ?host=", () => {
    expect(problems({ DATABASE_URL: "postgres:///app" })).toEqual([
      "DATABASE_URL: must be a postgres:// or postgresql:// URL with a host",
    ]);
    expect(problems({ DATABASE_URL: `postgres://u:${PASSWORD}@/app` })).toHaveLength(1);
    expect(problems({ DATABASE_URL: `postgres://u:${PASSWORD}@/app?host=` })).toHaveLength(1);
  });

  it("rejects other schemes", () => {
    for (const url of ["http://localhost/app", "mysql://localhost/app", "localhost:5432/app"]) {
      expect(problems({ DATABASE_URL: url })).toHaveLength(1);
    }
  });

  it("rejects unset, empty and whitespace-only values as not set", () => {
    for (const value of [undefined, "", "   "]) {
      expect(problems({ DATABASE_URL: value })).toEqual(["DATABASE_URL: is not set"]);
    }
  });

  it("rejects unbalanced brackets and spaces in the host", () => {
    for (const url of [
      `postgres://u:${PASSWORD}@[::1/app`,
      `postgres://u:${PASSWORD}@exa mple.com/app`,
    ]) {
      expect(problems({ DATABASE_URL: url })).toHaveLength(1);
    }
  });

  it("does not throw on bad percent-encoding in credentials or path, and never echoes it", () => {
    // WHATWG URL keeps an invalid %-escape literally, so the URL still validates; node-postgres
    // decodes it leniently too. What matters here is: no exception and no echo.
    for (const url of [`postgres://u:%zz${PASSWORD}@host/app`, `postgres://u:pw@host/%zz`]) {
      const result = parseDatabaseUrl({ DATABASE_URL: url });
      expect(result.problems.join("\n")).not.toContain(PASSWORD);
    }
  });

  it("never puts the input in a problem message", () => {
    const inputs = [
      `postgres://u:${PASSWORD}@/app`,
      `http://u:${PASSWORD}@localhost/app`,
      `postgres://u:${PASSWORD}@[::1/app`,
      `u:${PASSWORD}`,
      PASSWORD,
    ];
    for (const input of inputs) {
      const text = problems({ DATABASE_URL: input }).join("\n");
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain("app");
    }
  });
});
