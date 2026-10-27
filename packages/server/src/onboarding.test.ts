import { describe, expect, it } from "vitest";

import { setupNeeded, type OnboardingDeps } from "./onboarding";

const deps = (over: OnboardingDeps = {}): OnboardingDeps => ({
  user: async () => ({ role: "admin" }),
  missingGithub: async () => ["github.appId", "github_private_key"],
  ...over,
});

describe("setupNeeded", () => {
  it("is true for an administrator whose GitHub App is incomplete", async () => {
    expect(await setupNeeded(deps())).toBe(true);
  });

  it("is false once GitHub is complete", async () => {
    expect(await setupNeeded(deps({ missingGithub: async () => [] }))).toBe(false);
  });

  it("never affects readers or signed-out visitors", async () => {
    expect(await setupNeeded(deps({ user: async () => ({ role: "user" }) }))).toBe(false);
    expect(await setupNeeded(deps({ user: async () => null }))).toBe(false);
  });

  it("is false, rather than failing, when the session or settings cannot be read", async () => {
    const boom = async () => {
      throw new Error("database down");
    };
    expect(await setupNeeded(deps({ user: boom }))).toBe(false);
    expect(await setupNeeded(deps({ missingGithub: boom }))).toBe(false);
  });
});
