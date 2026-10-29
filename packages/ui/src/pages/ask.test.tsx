import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AskPageView } from "@docmyrepos/server/internal/ask-page";

const state = vi.hoisted(() => ({
  view: null as unknown,
  params: null as unknown,
  reader: null as unknown,
  ask: true,
}));
vi.mock("@docmyrepos/server/internal/ask-page", () => ({
  loadAskPage: async (params: unknown, deps: { reader?: unknown }) => {
    state.params = params;
    state.reader = deps.reader;
    return state.view;
  },
}));
vi.mock("@docmyrepos/server/internal/public-access/reader", () => ({
  ANONYMOUS: { kind: "anonymous" },
  MEMBER: { kind: "member" },
  anonymousMayUse: async () => state.ask,
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
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
  state.reader = null;
  state.ask = true;
});

describe("/ask page for a visitor without a session (public access)", () => {
  const anonymousApp = testApp({}, { user: async () => null });

  it("renders for an anonymous visitor when anonymous Ask is allowed, reading as anonymous", async () => {
    const html = renderToStaticMarkup(
      await AskPage({ app: anonymousApp, searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain("Ask the docs");
    expect(state.reader).toEqual({ kind: "anonymous" });
  });

  it("sends the visitor to sign in when anonymous Ask is not allowed, loading nothing", async () => {
    state.ask = false;
    await expect(AskPage({ app: anonymousApp, searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_REDIRECT:/login",
    );
    expect(state.params).toBeNull();
  });

  it("answers 404 for an anonymous visitor when Ask itself is off, like for a member", async () => {
    state.view = { status: "off" };
    await expect(AskPage({ app: anonymousApp, searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("reads a signed-in user as a member", async () => {
    await AskPage({ app: TEST_APP, searchParams: Promise.resolve({}) });
    expect(state.reader).toEqual({ kind: "member" });
  });
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
