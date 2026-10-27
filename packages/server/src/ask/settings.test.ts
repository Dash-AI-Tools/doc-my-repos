import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Secret } from "../config/secret";
import { providerAvailability } from "./credentials";
import { askSettings } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import {
  UNSET_ASK_SETTINGS,
  getAskState,
  isAiProvider,
  readAskSettings,
  resolveAsk,
  saveAskSettings,
  validateModel,
  type AskSettings,
} from "./settings";

describe("validateModel", () => {
  it("accepts real model names, trimmed", () => {
    for (const name of ["llama3.1:8b", "org/model", "gpt-4o-mini", "m", "a.b_c-d:e/f@g+h"]) {
      expect(validateModel(name)).toEqual({ ok: true, value: name });
    }
    expect(validateModel("  model-x \n")).toEqual({ ok: true, value: "model-x" });
    expect(validateModel("x".repeat(100)).ok).toBe(true);
  });

  it("rejects empty, over-long, spaced, control, bidi and badly started names", () => {
    const bad: unknown[] = [
      "",
      "   ",
      "x".repeat(101),
      "two words",
      "tab\tname",
      "new\nline",
      "nul\u0000byte",
      "bidi‮evil",
      "zero​width",
      ".hidden",
      "-flag",
      "/abs",
      ":colon",
      'quote"d',
      "semi;colon",
      "ünï",
      null,
      undefined,
      42,
      {},
    ];
    for (const name of bad) expect(validateModel(name).ok, String(name)).toBe(false);
  });
});

describe("isAiProvider", () => {
  it("knows exactly the two fixed providers", () => {
    expect(isAiProvider("anthropic")).toBe(true);
    expect(isAiProvider("openai-compatible")).toBe(true);
    for (const v of ["openai", "Anthropic", "", null, undefined, 1])
      expect(isAiProvider(v)).toBe(false);
  });
});

describe("resolveAsk", () => {
  const noKeys = { anthropicKey: null, openaiKey: null, openaiBaseUrl: null };
  const keyed = providerAvailability({ ...noKeys, anthropicKey: new Secret("k") });
  const bare = providerAvailability(noKeys);
  const on: AskSettings = { enabled: true, provider: "anthropic", model: "m" };

  it("is off unless an admin turned it on, whatever else is set", () => {
    expect(resolveAsk(UNSET_ASK_SETTINGS, keyed)).toEqual({ state: "off" });
    expect(resolveAsk({ ...on, enabled: false }, keyed)).toEqual({ state: "off" });
    expect(resolveAsk({ ...on, enabled: false }, bare)).toEqual({ state: "off" });
  });

  it("is ready with the provider and model when on and configured", () => {
    expect(resolveAsk(on, keyed)).toEqual({ state: "ready", provider: "anthropic", model: "m" });
  });

  it("is unavailable, naming settings only, when the credentials are missing", () => {
    expect(resolveAsk(on, bare)).toEqual({
      state: "unavailable",
      missing: ["Anthropic API key"],
    });
  });

  it("carries the problem text of an invalid group, which never contains a value", () => {
    const availability = providerAvailability({
      anthropicKey: null,
      openaiKey: null,
      openaiBaseUrl: "http://models.example.com/x",
    });
    const state = resolveAsk(
      { enabled: true, provider: "openai-compatible", model: "m" },
      availability,
    );
    expect(state).toMatchObject({ state: "unavailable", missing: [] });
    expect(JSON.stringify(state)).toContain("OpenAI-compatible base URL");
    expect(JSON.stringify(state)).not.toContain("models.example.com");
  });

  it("is unavailable when on but the provider or model is unset", () => {
    expect(resolveAsk({ enabled: true, provider: null, model: "m" }, keyed)).toEqual({
      state: "unavailable",
      missing: [],
    });
    expect(resolveAsk({ enabled: true, provider: "anthropic", model: null }, keyed)).toMatchObject({
      state: "unavailable",
    });
  });
});

const noKeys = { anthropicKey: null, openaiKey: null, openaiBaseUrl: null };
const withKey = { ...noKeys, anthropicKey: new Secret("k") };

describeDb("ask settings in the database", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("reads as unset (off) before anyone saved", async () => {
    expect(await readAskSettings(t.db)).toEqual(UNSET_ASK_SETTINGS);
  });

  it("saves and reads back the choice", async () => {
    const saved = await saveAskSettings(
      t.db,
      { enabled: true, provider: "openai-compatible", model: "llama3.1:8b" },
      null,
    );
    expect(saved).toEqual({ enabled: true, provider: "openai-compatible", model: "llama3.1:8b" });
    expect(await readAskSettings(t.db)).toEqual(saved);
  });

  it("keeps the saved provider and model when turned off", async () => {
    await saveAskSettings(t.db, { enabled: false }, null);
    expect(await readAskSettings(t.db)).toEqual({
      enabled: false,
      provider: "openai-compatible",
      model: "llama3.1:8b",
    });
    // Turned on again later, the choice is still there.
    await saveAskSettings(t.db, { enabled: true }, null);
    expect((await readAskSettings(t.db)).model).toBe("llama3.1:8b");
  });

  it("replaces the model on the same single row", async () => {
    await saveAskSettings(t.db, { enabled: true, provider: "anthropic", model: "new-model" }, null);
    expect(await readAskSettings(t.db)).toEqual({
      enabled: true,
      provider: "anthropic",
      model: "new-model",
    });
    expect(await t.db.select().from(askSettings)).toHaveLength(1);
  });

  it("reads a corrupted provider or model as unset, so it can never reach an adapter", async () => {
    await t.db
      .update(askSettings)
      .set({ provider: "evil", model: "has space" })
      .where(eq(askSettings.id, 1));
    expect(await readAskSettings(t.db)).toEqual({ enabled: true, provider: null, model: null });
    expect(await getAskState(t.db, withKey)).toEqual({
      state: "unavailable",
      missing: [],
    });
  });

  it("getAskState is ready from the row plus the environment, and off when the read fails", async () => {
    await saveAskSettings(t.db, { enabled: true, provider: "anthropic", model: "m1" }, null);
    expect(await getAskState(t.db, withKey)).toEqual({
      state: "ready",
      provider: "anthropic",
      model: "m1",
    });
    expect(await getAskState(t.db, noKeys)).toEqual({
      state: "unavailable",
      missing: ["Anthropic API key"],
    });
    const broken = {
      select: () => {
        throw new Error("db down");
      },
    } as never;
    expect(await getAskState(broken, withKey)).toEqual({ state: "off" });
  });
});
