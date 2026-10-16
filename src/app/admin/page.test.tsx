import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceStatusInput } from "@/lib/workspace-status";

const state = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/server/workspace-state", () => ({ currentWorkspaceState: () => state.read() }));
const setup = vi.hoisted(() => ({ needed: false }));
vi.mock("@/server/onboarding", () => ({ setupNeeded: async () => setup.needed }));

import AdminPage from "./page";

const CLEAN: WorkspaceStatusInput = {
  missingGithub: [],
  encryptionKey: null,
  unreadable: [],
  invalidStored: false,
  retired: [],
};

const html = async () => renderToStaticMarkup(await AdminPage());

beforeEach(() => {
  setup.needed = false;
  state.read.mockReset();
  state.read.mockResolvedValue(CLEAN);
});

describe("admin overview", () => {
  it("links to the branding page", async () => {
    const out = await html();
    expect(out).toContain('href="/admin/branding"');
    expect(out).toContain("Branding");
  });

  it("links to the Workspace configuration page and describes it as editable", async () => {
    const out = await html();
    expect(out).toContain('href="/admin/workspace"');
    expect(out).not.toContain("read-only");
  });

  it("shows the setup state: configured, or what needs attention by name only", async () => {
    let out = await html();
    expect(out).toContain('data-testid="admin-setup-state"');
    expect(out).toContain("Workspace settings: Configured.");

    state.read.mockResolvedValue({ ...CLEAN, missingGithub: ["github_private_key"] });
    out = await html();
    expect(out).toContain("Workspace settings: Needs attention.");
    expect(out).toContain("the GitHub App private key");
  });

  it("leaves the setup line out when the settings cannot be read", async () => {
    state.read.mockRejectedValue(new Error("database down"));
    const out = await html();
    expect(out).not.toContain("admin-setup-state");
    expect(out).toContain("Administration");
  });

  it("shows the setup banner only while GitHub still needs setting up", async () => {
    expect(await html()).not.toContain("setup-banner");
    setup.needed = true;
    const out = await html();
    expect(out).toContain("setup-banner");
    expect(out).toContain('href="/admin/workspace?setup=1"');
  });
});
