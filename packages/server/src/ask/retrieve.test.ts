import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "../db/client";
import type { SearchHit } from "../queries";
import { ProviderError, type ProviderAdapter } from "./providers";

const searchDocuments = vi.fn();
const getDocumentByPath = vi.fn();
const getRepo = vi.fn();
vi.mock("../queries", () => ({
  searchDocuments: (...args: unknown[]) => searchDocuments(...args),
  getDocumentByPath: (...args: unknown[]) => getDocumentByPath(...args),
  getRepo: (...args: unknown[]) => getRepo(...args),
}));

import { MAX_DOCUMENTS, mergeHits, retrieve } from "./retrieve";

const db = {} as Db;

function hit(path: string, repoId = 1): SearchHit {
  return {
    repo: { id: repoId, owner: "acme", name: `r${repoId}`, visibility: "public", docsPath: "docs" },
    doc: {
      path,
      title: path,
      description: null,
      type: null,
      tags: [],
      status: null,
      reserved: null,
    },
    rank: 1,
    snippet: "",
    heading: null,
  } as SearchHit;
}

function detail(path: string, body: string) {
  return { path, title: `Title of ${path}`, body, headings: [] };
}

function provider(reply: () => Promise<string>): ProviderAdapter {
  return {
    provider: "anthropic",
    stream: () => {
      throw new Error("not used");
    },
    completeOnce: async () => ({
      text: await reply(),
      inputTokens: 10,
      outputTokens: 4,
      cutOff: false,
    }),
  };
}

beforeEach(() => {
  searchDocuments.mockReset();
  getDocumentByPath.mockReset();
  getRepo.mockReset();
  getRepo.mockResolvedValue(null);
});

describe("mergeHits", () => {
  it("ranks by reciprocal rank across lists, so a document found by two queries wins", () => {
    const merged = mergeHits([
      [hit("a.md"), hit("b.md"), hit("c.md")],
      [hit("d.md"), hit("b.md")],
    ]);
    expect(merged.map((h) => h.doc.path)).toEqual(["b.md", "a.md", "d.md", "c.md"]);
  });

  it("keeps documents of different repositories apart and the first list's order on ties", () => {
    const merged = mergeHits([[hit("x.md", 1)], [hit("x.md", 2)]]);
    expect(merged.map((h) => h.repo.id)).toEqual([1, 2]);
  });

  it("is empty for no hits", () => {
    expect(mergeHits([[], []])).toEqual([]);
  });
});

describe("retrieve", () => {
  const input = { question: "how do I rotate keys?", history: [] };

  it("searches each model-written query with limit 5 and keeps the top six documents", async () => {
    searchDocuments.mockImplementation(async (_db, params: { q: string }) => ({
      hits: Array.from({ length: 5 }, (_, i) => hit(`${params.q}-${i}.md`)),
    }));
    getDocumentByPath.mockImplementation(async (_db, _ref, path: string) =>
      detail(path, "rotate keys body"),
    );
    const result = await retrieve(
      { db, provider: provider(async () => '["rotate", "keys"]') },
      input,
    );
    expect(searchDocuments).toHaveBeenCalledTimes(2);
    expect(searchDocuments.mock.calls.map((c) => [c[1].q, c[1].limit])).toEqual([
      ["rotate", 5],
      ["keys", 5],
    ]);
    expect(result.queries).toEqual(["rotate", "keys"]);
    expect(getDocumentByPath).toHaveBeenCalledTimes(MAX_DOCUMENTS);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("falls back to the question's keywords for a reply that is not a JSON array of strings", async () => {
    searchDocuments.mockResolvedValue({ hits: [] });
    for (const reply of [
      "sure! here you go",
      '{"q": 1}',
      "[1, 2]",
      "[]",
      '[""]',
      "```text\nx\n```",
    ]) {
      searchDocuments.mockClear();
      const result = await retrieve({ db, provider: provider(async () => reply) }, input);
      expect(result.queries).toEqual(["rotate keys"]);
      expect(searchDocuments.mock.calls.map((c) => c[1].q)).toEqual(["rotate keys"]);
    }
  });

  it("falls back to the raw question when the provider fails, and rethrows an abort", async () => {
    searchDocuments.mockResolvedValue({ hits: [] });
    const failing = provider(async () => {
      throw new ProviderError("unavailable");
    });
    expect((await retrieve({ db, provider: failing }, input)).queries).toEqual(["rotate keys"]);

    const aborted = provider(async () => {
      throw new ProviderError("aborted");
    });
    await expect(retrieve({ db, provider: aborted }, input)).rejects.toMatchObject({
      kind: "aborted",
    });
  });

  it("searches the question itself when it has no keyword", async () => {
    searchDocuments.mockResolvedValue({ hits: [] });
    const result = await retrieve(
      { db, provider: provider(async () => "nope") },
      { question: "what is it?", history: [] },
    );
    expect(result.queries).toEqual(["what is it?"]);
  });

  it("skips a document that vanished between search and read", async () => {
    searchDocuments.mockResolvedValue({ hits: [hit("gone.md"), hit("here.md")] });
    getDocumentByPath.mockImplementation(async (_db, _ref, path: string) =>
      path === "gone.md" ? null : detail(path, "rotate keys here"),
    );
    const result = await retrieve({ db, provider: provider(async () => '["rotate keys"]') }, input);
    expect(result.excerpts.map((e) => e.path)).toEqual(["here.md"]);
    expect(result.excerpts[0]?.n).toBe(1);
  });

  it("returns no excerpts when nothing matched or every document vanished", async () => {
    searchDocuments.mockResolvedValue({ hits: [] });
    expect((await retrieve({ db, provider: provider(async () => "[]") }, input)).excerpts).toEqual(
      [],
    );
    searchDocuments.mockResolvedValue({ hits: [hit("gone.md")] });
    getDocumentByPath.mockResolvedValue(null);
    expect((await retrieve({ db, provider: provider(async () => "[]") }, input)).excerpts).toEqual(
      [],
    );
  });

  it("passes the visibility options to every read", async () => {
    const options = { visibility: () => ({}) as never };
    searchDocuments.mockResolvedValue({ hits: [hit("a.md")] });
    getDocumentByPath.mockResolvedValue(detail("a.md", "rotate keys"));
    getRepo.mockResolvedValue({ owner: "acme", name: "r1" });
    await retrieve(
      { db, provider: provider(async () => '["rotate"]'), options },
      { ...input, repo: "acme/r1" },
    );
    expect(getRepo.mock.calls[0]?.[3]).toBe(options);
    expect(searchDocuments.mock.calls[0]?.[2]).toBe(options);
    expect(getDocumentByPath.mock.calls[0]?.[3]).toBe(options);
  });

  it("scopes to a visible repository and ignores one the reader cannot see", async () => {
    searchDocuments.mockResolvedValue({ hits: [] });
    getRepo.mockResolvedValueOnce({ owner: "Acme", name: "Handbook" });
    const scoped = await retrieve(
      { db, provider: provider(async () => '["x"]') },
      { ...input, repo: "acme/handbook" },
    );
    expect(scoped.scope).toBe("Acme/Handbook");
    expect(searchDocuments.mock.calls[0]?.[1].repo).toBe("Acme/Handbook");

    searchDocuments.mockClear();
    for (const repo of ["nobody/none", "not a repo", "a/b/c", "", null, undefined]) {
      const result = await retrieve(
        { db, provider: provider(async () => '["x"]') },
        {
          ...input,
          repo,
        },
      );
      expect(result.scope).toBeNull();
    }
    expect(searchDocuments.mock.calls.every((c) => !("repo" in c[1]))).toBe(true);
  });
});
