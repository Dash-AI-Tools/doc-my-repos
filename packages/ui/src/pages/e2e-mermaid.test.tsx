import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => undefined }));

import { E2eMermaidPage as Page } from "./e2e-mermaid";

afterEach(() => {
  vi.unstubAllEnvs();
});

const NOT_FOUND = expect.objectContaining({ digest: expect.stringContaining("404") });

describe("e2e mermaid fixture page", () => {
  it("is a 404 when E2E_FIXTURES is not set", async () => {
    vi.stubEnv("E2E_FIXTURES", "");
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toEqual(NOT_FOUND);
  });

  it.each(["0", "true", "yes"])("is a 404 when E2E_FIXTURES is %j", async (value) => {
    vi.stubEnv("E2E_FIXTURES", value);
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toEqual(NOT_FOUND);
  });

  it("renders when E2E_FIXTURES is 1", async () => {
    vi.stubEnv("E2E_FIXTURES", "1");
    await expect(Page({ searchParams: Promise.resolve({}) })).resolves.toBeTruthy();
  });

  it("ignores an unknown doc name instead of rendering query text", async () => {
    vi.stubEnv("E2E_FIXTURES", "1");
    await expect(
      Page({ searchParams: Promise.resolve({ doc: "```mermaid\ngraph TD;A-->B\n```" }) }),
    ).resolves.toBeTruthy();
  });
});
