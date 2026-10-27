import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
  notFound: () => notFound(),
}));

import { RepoDocsRedirect as DocsIndexRedirect } from "./repo-docs-redirect";

const run = (owner: string, repo: string) =>
  DocsIndexRedirect({ params: Promise.resolve({ owner, repo }) });

beforeEach(() => {
  redirect.mockClear();
  notFound.mockClear();
});

describe("/<owner>/<repo>/docs", () => {
  it("redirects a valid address to the repository page", async () => {
    await expect(run("acme", "api-service")).rejects.toThrow("NEXT_REDIRECT:/acme/api-service");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("answers 404 instead of redirecting an address that cannot name a repository", async () => {
    for (const [owner, repo] of [
      ["acme", "my%20repo"],
      ["acme", "my repo"],
      ["ac%20me", "api"],
      ["acme", "a%2Fb"],
      ["acme", ".."],
      ["acme", ""],
      ["-bad-", "api"],
      ["api", "x"],
      ["search", "x"],
    ] as const) {
      await expect(run(owner, repo), `${owner}/${repo}`).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(redirect).not.toHaveBeenCalled();
  });

  it("never double-encodes a percent escape", async () => {
    await expect(run("acme", "100%25")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(redirect).not.toHaveBeenCalled();
  });
});
