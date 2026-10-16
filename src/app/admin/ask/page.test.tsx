import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AskSettingsView } from "@/components/ask-settings-form";

import AdminLayout from "../layout";
import AdminAskPage from "./page";

const state = vi.hoisted(() => ({ role: "admin" as "admin" | "user", read: vi.fn() }));
const VIEW: AskSettingsView = {
  settings: { enabled: false, provider: null, model: null },
  providers: {
    anthropic: { configured: true, missing: [] },
    "openai-compatible": { configured: false, missing: ["AI_OPENAI_BASE_URL"] },
  },
  state: { state: "off" },
};

vi.mock("@/server/admin/ask", () => ({
  getAdminAskView: async () => {
    state.read();
    return VIEW;
  },
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

beforeEach(() => {
  state.role = "admin";
  state.read.mockReset();
});

describe("/admin/ask", () => {
  it("renders the settings form for an administrator", async () => {
    const guarded = await AdminLayout({ children: await AdminAskPage() });
    const html = renderToStaticMarkup(guarded);
    expect(html).toContain("<h1");
    expect(html).toContain("Turn Ask on");
    expect(html).toContain("Anthropic (configured)");
    expect(html).toContain("OpenAI-compatible endpoint (missing AI_OPENAI_BASE_URL)");
    expect(state.read).toHaveBeenCalledTimes(1);
  });

  it("shows a non-administrator the access-denied panel, never the form", async () => {
    state.role = "user";
    // The layout decides before the children render: the page element is never rendered.
    const html = renderToStaticMarkup(await AdminLayout({ children: <p>never</p> }));
    expect(html).toContain("Access denied");
    expect(html).not.toContain("Turn Ask on");
  });
});
