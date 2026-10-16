import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "./db/client";
import type { AskState } from "./ask/settings";
import { Secret } from "./config/secret";

const getRepo = vi.fn();
const listRepos = vi.fn();
vi.mock("./queries", () => ({
  getRepo: (...args: unknown[]) => getRepo(...args),
  listRepos: (...args: unknown[]) => listRepos(...args),
}));

import { loadAskPage } from "./ask-page";

const db = (() => ({}) as Db) as () => Db;
const providers = async () => ({
  anthropicKey: new Secret("k"),
  openaiBaseUrl: null,
  openaiKey: null,
});
const ready = (provider: "anthropic" | "openai-compatible" = "anthropic"): AskState => ({
  state: "ready",
  provider,
  model: "m",
});

beforeEach(() => {
  getRepo.mockReset();
  listRepos.mockReset();
  getRepo.mockResolvedValue(null);
  listRepos.mockResolvedValue([
    { owner: "acme", name: "api" },
    { owner: "acme", name: "handbook" },
  ]);
});

describe("loadAskPage", () => {
  it("is off unless Ask is ready, and reads nothing then", async () => {
    for (const state of [
      { state: "off" },
      { state: "unavailable", missing: ["AI_ANTHROPIC_API_KEY"] },
    ] as AskState[]) {
      expect(await loadAskPage({}, { state: async () => state, db, providers })).toEqual({
        status: "off",
      });
    }
    expect(listRepos).not.toHaveBeenCalled();
  });

  it("names the provider, and the endpoint host only for the OpenAI-compatible one", async () => {
    const openaiProviders = async () => ({
      anthropicKey: new Secret("k"),
      openaiBaseUrl: "https://models.example.com/v1/secret-path",
      openaiKey: new Secret("k"),
    });
    const openai = await loadAskPage(
      {},
      { state: async () => ready("openai-compatible"), db, providers: openaiProviders },
    );
    expect(openai).toMatchObject({
      status: "ready",
      providerLabel: "OpenAI-compatible endpoint",
      host: "models.example.com",
    });
    expect(JSON.stringify(openai)).not.toContain("secret-path");
    const anthropic = await loadAskPage(
      {},
      { state: async () => ready(), db, providers: openaiProviders },
    );
    expect(anthropic).toMatchObject({ providerLabel: "Anthropic", host: null });
  });

  it("lists the visible repositories and checks the scope through the query layer", async () => {
    getRepo.mockResolvedValue({ owner: "acme", name: "API" });
    const view = await loadAskPage(
      { repo: "acme/api" },
      { state: async () => ready(), db, providers },
    );
    expect(view).toMatchObject({ scope: "acme/API", repos: ["acme/api", "acme/handbook"] });
    expect(getRepo.mock.calls[0]?.slice(1, 3)).toEqual(["acme", "api"]);
  });

  it("ignores a scope the reader cannot see or that is malformed", async () => {
    for (const repo of ["nobody/none", "not a repo", "a/b/c", "", undefined, ["x/y", "z/w"]]) {
      getRepo.mockClear();
      const view = await loadAskPage({ repo }, { state: async () => ready(), db, providers });
      expect(view).toMatchObject({ status: "ready", scope: null });
    }
  });

  it("prefills the question from ?q= (trimmed, bounded) without sending anything", async () => {
    const view = await loadAskPage(
      { q: `  ${"x".repeat(2500)}  ` },
      { state: async () => ready(), db, providers },
    );
    expect(view).toMatchObject({ initialQuestion: "x".repeat(2000) });
    expect(
      await loadAskPage({ q: ["first", "second"] }, { state: async () => ready(), db, providers }),
    ).toMatchObject({ initialQuestion: "first" });
    expect(await loadAskPage({}, { state: async () => ready(), db, providers })).toMatchObject({
      initialQuestion: "",
    });
  });

  it("still renders when the repository reads fail, logging only the kind", async () => {
    listRepos.mockRejectedValue(
      Object.assign(new Error("connect postgres://u:sentinel@h/db"), { code: "ECONNREFUSED" }),
    );
    const log = vi.fn();
    const view = await loadAskPage(
      { repo: "acme/api" },
      { state: async () => ready(), db, log, providers },
    );
    expect(view).toMatchObject({ status: "ready", scope: null, repos: [] });
    expect(JSON.stringify(log.mock.calls)).not.toContain("sentinel");
    expect(log).toHaveBeenCalledWith("ask.page.load_failed", expect.any(Object));
  });
});
