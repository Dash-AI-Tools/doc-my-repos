import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AskPageView } from "@docmyrepos/server/internal/ask-page";

const state = vi.hoisted(() => ({ view: null as unknown, params: null as unknown }));
vi.mock("@docmyrepos/server/internal/ask-page", () => ({
  loadAskPage: async (params: unknown) => {
    state.params = params;
    return state.view;
  },
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { AskPage, metadata } from "./ask";
import { testApp } from "./test-app";

const TEST_APP = testApp();

const READY: AskPageView = {
  status: "ready",
  providerLabel: "Anthropic",
  host: null,
  scope: "acme/api",
  repos: ["acme/api"],
  initialQuestion: "prefilled?",
};

beforeEach(() => {
  state.view = READY;
  state.params = null;
});

describe("/ask page", () => {
  it("is not indexed", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("answers 404 when Ask is off", async () => {
    state.view = { status: "off" };
    await expect(AskPage({ app: TEST_APP, searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("renders the heading, the notice, the scope and the prefilled question", async () => {
    const html = renderToStaticMarkup(
      await AskPage({
        app: TEST_APP,
        searchParams: Promise.resolve({ repo: "acme/api", q: "prefilled?" }),
      }),
    );
    expect(html).toContain("Ask the docs");
    expect(html).toContain("Anthropic");
    expect(html).toContain("Searching in <strong>acme/api</strong>");
    expect(html).toContain("prefilled?");
    expect(state.params).toEqual({ repo: "acme/api", q: "prefilled?" });
  });

  it("has exactly one level-one heading", async () => {
    const html = renderToStaticMarkup(
      await AskPage({ app: TEST_APP, searchParams: Promise.resolve({}) }),
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
  });
});
