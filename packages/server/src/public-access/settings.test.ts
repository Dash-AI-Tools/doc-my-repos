import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import {
  DEFAULT_PUBLIC_ACCESS,
  checkPublicAccessChange,
  readPublicAccessSettings,
  savePublicAccessSettings,
} from "./settings";

describe("checkPublicAccessChange", () => {
  it("accepts any subset of the four fields", () => {
    expect(checkPublicAccessChange({})).toEqual({ ok: true, value: {} });
    expect(
      checkPublicAccessChange({
        searchEnabled: false,
        askEnabled: true,
        askQuestionsPerDay: 1,
        askQuestionsPerTenMinutes: 1000,
      }),
    ).toEqual({
      ok: true,
      value: {
        searchEnabled: false,
        askEnabled: true,
        askQuestionsPerDay: 1,
        askQuestionsPerTenMinutes: 1000,
      },
    });
  });

  it("names the field and the range, never the submitted value", () => {
    for (const [input, field] of [
      [{ askQuestionsPerDay: 0 }, "askQuestionsPerDay"],
      [{ askQuestionsPerDay: 10_001 }, "askQuestionsPerDay"],
      [{ askQuestionsPerDay: 1.5 }, "askQuestionsPerDay"],
      [{ askQuestionsPerTenMinutes: 2000 }, "askQuestionsPerTenMinutes"],
      [{ askQuestionsPerTenMinutes: "20" }, "askQuestionsPerTenMinutes"],
      [{ searchEnabled: "yes" }, "searchEnabled"],
      [{ askEnabled: 1 }, "askEnabled"],
    ] as const) {
      const result = checkPublicAccessChange(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.field).toBe(field);
        expect(result.error).not.toContain(String(Object.values(input)[0]) + "\u0000");
      }
    }
    const tooBig = checkPublicAccessChange({ askQuestionsPerDay: 123456 });
    expect(tooBig.ok ? "" : tooBig.error).not.toContain("123456");
  });

  it("rejects unknown keys and non-objects", () => {
    expect(checkPublicAccessChange({ extra: true }).ok).toBe(false);
    for (const bad of [null, 1, "x", [], undefined])
      expect(checkPublicAccessChange(bad).ok).toBe(false);
  });
});

describeDb("public access settings row", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("reads the defaults when nothing was saved", async () => {
    expect(await readPublicAccessSettings(t.db)).toEqual(DEFAULT_PUBLIC_ACCESS);
    expect(DEFAULT_PUBLIC_ACCESS).toEqual({
      searchEnabled: true,
      askEnabled: false,
      askQuestionsPerDay: 200,
      askQuestionsPerTenMinutes: 20,
    });
  });

  it("saves a partial change and keeps the rest", async () => {
    const saved = await savePublicAccessSettings(t.db, { askEnabled: true }, null);
    expect(saved).toEqual({ ...DEFAULT_PUBLIC_ACCESS, askEnabled: true });
    const again = await savePublicAccessSettings(t.db, { askQuestionsPerDay: 50 }, null);
    expect(again).toEqual({ ...DEFAULT_PUBLIC_ACCESS, askEnabled: true, askQuestionsPerDay: 50 });
  });
});
