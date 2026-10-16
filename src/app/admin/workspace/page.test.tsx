import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { configSchema } from "@/server/config/schema";

import AdminLayout from "../layout";
import AdminGithubPage from "./page";

const guide = vi.hoisted(() => ({ props: [] as { autoOpen: boolean }[] }));
vi.mock("@/components/setup-guide", () => ({
  SetupGuide: (props: { autoOpen: boolean }) => {
    guide.props.push(props);
    return <button type="button">Setup instructions</button>;
  },
}));

const state = vi.hoisted(() => ({ role: "admin" as "admin" | "user" }));
vi.mock("@/server/admin/ask", () => ({
  getAdminAskView: async () => ({
    settings: { enabled: false, provider: null, model: null },
    providers: {
      anthropic: { configured: true, missing: [] },
      "openai-compatible": { configured: false, missing: ["OpenAI-compatible base URL"] },
    },
    state: { state: "off" },
    credentials: {
      version: 0,
      openaiBaseUrl: null,
      anthropicKey: { set: false, updatedAt: null },
      openaiKey: { set: false, updatedAt: null },
    },
  }),
}));

vi.mock("@/server/admin/service", () => ({
  getAdminRepos: async () => [
    {
      id: 1,
      owner: "acme",
      name: "api",
      visibility: "public",
      isAllowed: true,
      starPosition: null,
      isStarred: false,
      syncStatus: "ok",
    },
  ],
}));

vi.mock("@/server/admin/settings", () => ({
  getAdminSettingsView: async () => ({
    version: 2,
    settings: configSchema.parse({ github: { appId: 123, installationId: 456 } }),
    secrets: {
      github_private_key: { set: true, updatedAt: new Date("2026-10-16T09:30:00Z") },
      github_webhook_secret: { set: false, updatedAt: null },
      anthropic_api_key: { set: false, updatedAt: null },
      openai_api_key: { set: false, updatedAt: null },
    },
    problems: { missingGithub: [], encryptionKey: null, unreadable: [], invalidStored: false },
  }),
}));
vi.mock("@/server/auth/current-user", () => ({
  getCurrentUser: async () => ({ email: "v@example.com", role: state.role }),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const params = (p: { setup?: string; tab?: string }) => Promise.resolve(p);

beforeEach(() => {
  state.role = "admin";
});

describe("/admin/workspace", () => {
  it("renders the editable settings with secrets as set or not, never as text", async () => {
    const html = renderToStaticMarkup(await AdminGithubPage({ searchParams: params({}) }));
    expect(html).toContain("Workspace configuration");
    expect(html).toContain('value="123"');
    expect(html).toContain("Set, changed 2026-10-16 09:30 UTC.");
    expect(html).toContain("Test GitHub connection");
    // The only PEM text on the page is the placeholder hint, never a stored key body.
    expect(html).not.toMatch(/PRIVATE KEY-----\s*[A-Za-z0-9+/]{20,}/);
  });

  it("shows a non-administrator the access-denied panel, never the form", async () => {
    state.role = "user";
    const html = renderToStaticMarkup(await AdminLayout({ children: <p>never</p> }));
    expect(html).toContain("Access denied");
    expect(html).not.toContain("Test GitHub connection");
  });

  it("offers the setup instructions, and opens them on its own only for ?setup=1", async () => {
    for (const [setup, auto] of [
      ["1", true],
      [undefined, false],
    ] as const) {
      guide.props.length = 0;
      const html = renderToStaticMarkup(await AdminGithubPage({ searchParams: params({ setup }) }));
      expect(html).toContain("Setup instructions");
      expect(guide.props.at(-1)?.autoOpen).toBe(auto);
      expect(html).toContain("Test GitHub connection");
    }
  });

  it("holds Ask in its own tab, and opens that tab for ?tab=ask", async () => {
    const html = renderToStaticMarkup(
      await AdminGithubPage({ searchParams: params({ tab: "ask" }) }),
    );
    expect(html).toContain("GitHub &amp; sync");
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*data-testid="tab-ask"/);
    expect(html).toContain("Turn Ask on");
  });

  it("holds Repository access in its own tab, and opens that tab for ?tab=repos", async () => {
    const html = renderToStaticMarkup(
      await AdminGithubPage({ searchParams: params({ tab: "repos" }) }),
    );
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*data-testid="tab-repos"/);
    expect(html).toContain("acme/api");
  });
});
