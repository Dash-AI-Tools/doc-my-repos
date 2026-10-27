import { describe, expect, it, vi } from "vitest";

import {
  MAX_WAIT_SECONDS,
  isTransientConnectionError,
  parseWaitSeconds,
  waitUntilReady,
} from "./wait";

const osError = (code: string) =>
  Object.assign(new Error("connect failed to 10.0.0.5:5432"), { code });

describe("isTransientConnectionError", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH"])(
    "retries OS error %s",
    (code) => {
      expect(isTransientConnectionError(osError(code))).toBe(true);
    },
  );

  it.each(["57P03", "57P01", "53300", "08006", "08001"])("retries SQLSTATE %s", (code) => {
    expect(isTransientConnectionError(osError(code))).toBe(true);
  });

  it("retries a connect timeout", () => {
    expect(isTransientConnectionError(new Error("timeout exceeded when trying to connect"))).toBe(
      true,
    );
  });

  it("finds the code on a wrapped cause", () => {
    expect(
      isTransientConnectionError(new Error("wrapped", { cause: osError("ECONNREFUSED") })),
    ).toBe(true);
  });

  it.each(["28P01", "28000", "3D000", "42P01"])("fails at once on SQLSTATE %s", (code) => {
    expect(isTransientConnectionError(osError(code))).toBe(false);
  });

  it("does not retry unknown errors", () => {
    expect(isTransientConnectionError(new Error("something else"))).toBe(false);
    expect(isTransientConnectionError(undefined)).toBe(false);
  });
});

/** A fake clock whose sleep advances time, so waits take no real time. */
function fakeClock() {
  let time = 1_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: (ms: number) => {
      sleeps.push(ms);
      time += ms;
      return Promise.resolve();
    },
  };
}

describe("waitUntilReady", () => {
  it("returns at once when the first attempt works", async () => {
    const clock = fakeClock();
    const ping = vi.fn().mockResolvedValue(undefined);
    await expect(waitUntilReady(ping, { timeoutMs: 5_000, ...clock })).resolves.toEqual({
      ready: true,
      attempts: 1,
    });
    expect(clock.sleeps).toEqual([]);
  });

  it("retries a refused connection until the database answers", async () => {
    const clock = fakeClock();
    const ping = vi
      .fn()
      .mockRejectedValueOnce(osError("ECONNREFUSED"))
      .mockRejectedValueOnce(osError("57P03"))
      .mockResolvedValue(undefined);
    const onRetry = vi.fn();
    const result = await waitUntilReady(ping, {
      timeoutMs: 60_000,
      intervalMs: 2_000,
      onRetry,
      ...clock,
    });
    expect(result).toEqual({ ready: true, attempts: 3 });
    expect(clock.sleeps).toEqual([2_000, 2_000]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[1]?.[0]).toMatchObject({ attempt: 2, elapsedMs: 2_000 });
  });

  it("gives up at the deadline with the last error and never sleeps past it", async () => {
    const clock = fakeClock();
    const error = osError("ECONNREFUSED");
    const ping = vi.fn().mockRejectedValue(error);
    const result = await waitUntilReady(ping, { timeoutMs: 5_000, intervalMs: 2_000, ...clock });
    expect(result).toEqual({ ready: false, attempts: 4, lastError: error });
    expect(clock.sleeps).toEqual([2_000, 2_000, 1_000]);
  });

  it("makes exactly one attempt when the timeout is 0", async () => {
    const clock = fakeClock();
    const ping = vi.fn().mockRejectedValue(osError("ECONNREFUSED"));
    const result = await waitUntilReady(ping, { timeoutMs: 0, ...clock });
    expect(result).toMatchObject({ ready: false, attempts: 1 });
    expect(ping).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("does not wait for an error that cannot pass, such as a wrong password", async () => {
    const clock = fakeClock();
    const ping = vi.fn().mockRejectedValue(osError("28P01"));
    const result = await waitUntilReady(ping, { timeoutMs: 60_000, ...clock });
    expect(result).toMatchObject({ ready: false, attempts: 1 });
    expect(clock.sleeps).toEqual([]);
  });
});

describe("parseWaitSeconds", () => {
  it("treats unset and blank as no waiting", () => {
    expect(parseWaitSeconds(undefined)).toEqual({ ok: true, seconds: 0 });
    expect(parseWaitSeconds("  ")).toEqual({ ok: true, seconds: 0 });
  });

  it("accepts whole numbers up to the maximum", () => {
    expect(parseWaitSeconds("60")).toEqual({ ok: true, seconds: 60 });
    expect(parseWaitSeconds(" 0 ")).toEqual({ ok: true, seconds: 0 });
    expect(parseWaitSeconds(String(MAX_WAIT_SECONDS))).toEqual({ ok: true, seconds: 600 });
  });

  it.each(["-1", "1.5", "abc", "601", "10000", "1e3"])("rejects %s without echoing it", (value) => {
    const result = parseWaitSeconds(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toMatch(/^DB_WAIT_SECONDS: must be a whole number/);
      expect(result.problem).not.toContain(value);
    }
  });
});
