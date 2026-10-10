import { describe, expect, it, vi } from "vitest";
import { GitHubError, type RepoInfo } from "../github/client";
import { configSchema } from "../config/schema";
import { discoverRepositories, repoNameSelection, type DiscoveryClient } from "./discovery";

function repo(id: number, name: string, extra: Partial<RepoInfo> = {}): RepoInfo {
  return {
    id,
    owner: "Acme",
    name,
    fullName: `Acme/${name}`,
    defaultBranch: "main",
    archived: false,
    visibility: "public",
    description: null,
    htmlUrl: `https://github.com/Acme/${name}`,
    ...extra,
  };
}

function clientOf(repos: RepoInfo[]): DiscoveryClient {
  return { listInstallationRepositories: vi.fn().mockResolvedValue(repos) };
}

const cfg = (input: unknown = {}) => configSchema.parse(input);

function names(result: Awaited<ReturnType<typeof discoverRepositories>>) {
  return result.repos.map((r) => r.name);
}

describe("discoverRepositories", () => {
  it("returns every accessible repo when config narrows nothing", async () => {
    const r = await discoverRepositories(clientOf([repo(1, "a"), repo(2, "b")]), cfg());
    expect(r.complete).toBe(true);
    expect(names(r)).toEqual(["a", "b"]);
    expect(r.skipped).toEqual([]);
    expect(r.inaccessible).toEqual([]);
    expect(r.repos[0]).toMatchObject({
      githubId: 1,
      owner: "Acme",
      defaultBranch: "main",
      visibility: "public",
      archived: false,
      config: {},
    });
  });

  it("narrows to the explicit list and carries per-repo overrides", async () => {
    const r = await discoverRepositories(
      clientOf([repo(1, "a"), repo(2, "b"), repo(3, "c")]),
      cfg({ repos: ["a", { name: "c", docsPath: "handbook" }] }),
    );
    expect(names(r)).toEqual(["a", "c"]);
    expect(r.repos[0]?.config).toEqual({});
    expect(r.repos[1]?.config).toEqual({ docsPath: "handbook" });
    expect(r.skipped).toEqual([]);
  });

  it("removes excluded repos and reports them", async () => {
    const r = await discoverRepositories(
      clientOf([repo(1, "a"), repo(2, "sandbox")]),
      cfg({ exclude: ["sandbox"] }),
    );
    expect(names(r)).toEqual(["a"]);
    expect(r.skipped).toEqual([
      { githubId: 2, owner: "Acme", name: "sandbox", reason: "excluded" },
    ]);
  });

  it("skips archived repos", async () => {
    const r = await discoverRepositories(
      clientOf([repo(1, "a"), repo(2, "old", { archived: true })]),
      cfg(),
    );
    expect(names(r)).toEqual(["a"]);
    expect(r.skipped).toEqual([{ githubId: 2, owner: "Acme", name: "old", reason: "archived" }]);
  });

  it("treats a listed archived repo as skipped, not inaccessible", async () => {
    const r = await discoverRepositories(
      clientOf([repo(2, "old", { archived: true })]),
      cfg({ repos: ["old"] }),
    );
    expect(r.repos).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.inaccessible).toEqual([]);
  });

  it("flags a listed repo the installation cannot see, others unaffected", async () => {
    const r = await discoverRepositories(clientOf([repo(1, "a")]), cfg({ repos: ["a", "ghost"] }));
    expect(r.complete).toBe(true);
    expect(names(r)).toEqual(["a"]);
    expect(r.inaccessible).toEqual([
      { name: "ghost", code: "not_accessible", message: "not accessible by the GitHub App" },
    ]);
  });

  it("matches config names case-insensitively and keeps GitHub's case", async () => {
    const r = await discoverRepositories(
      clientOf([repo(1, "Api-Service")]),
      cfg({ repos: [{ name: "api-service", docsPath: "d" }] }),
    );
    expect(r.repos).toHaveLength(1);
    expect(r.repos[0]).toMatchObject({
      name: "Api-Service",
      owner: "Acme",
      config: { docsPath: "d" },
    });
    expect(r.inaccessible).toEqual([]);

    const ex = await discoverRepositories(
      clientOf([repo(1, "Sandbox")]),
      cfg({ exclude: ["SANDBOX"] }),
    );
    expect(ex.repos).toEqual([]);
    expect(ex.skipped[0]?.reason).toBe("excluded");
  });

  it("propagates a listing failure as an incomplete result with nothing in it", async () => {
    const client: DiscoveryClient = {
      listInstallationRepositories: vi.fn().mockRejectedValue(new GitHubError("server", 502)),
    };
    const r = await discoverRepositories(client, cfg({ repos: ["a"] }));
    expect(r.complete).toBe(false);
    if (!r.complete) expect(r.error.kind).toBe("server");
    expect(r.repos).toEqual([]);
    expect(r.inaccessible).toEqual([]);
  });

  it("rethrows errors that are not GitHubErrors", async () => {
    const client: DiscoveryClient = {
      listInstallationRepositories: vi.fn().mockRejectedValue(new TypeError("bug")),
    };
    await expect(discoverRepositories(client, cfg())).rejects.toThrow("bug");
  });

  it("treats an empty installation as a valid complete listing", async () => {
    const r = await discoverRepositories(clientOf([]), cfg());
    expect(r).toEqual({ complete: true, repos: [], skipped: [], inaccessible: [] });
  });

  it("flags every listed repo when the installation is empty", async () => {
    const r = await discoverRepositories(clientOf([]), cfg({ repos: ["a"] }));
    expect(r.complete).toBe(true);
    expect(r.inaccessible.map((i) => i.name)).toEqual(["a"]);
  });

  it("collapses duplicate repository ids in the listing", async () => {
    const r = await discoverRepositories(
      clientOf([repo(1, "a"), repo(1, "a"), repo(2, "b")]),
      cfg(),
    );
    expect(names(r)).toEqual(["a", "b"]);
  });

  it("collapses duplicate config entries", async () => {
    const r = await discoverRepositories(clientOf([repo(1, "a")]), {
      repos: ["a", "A"],
      exclude: undefined,
    });
    expect(names(r)).toEqual(["a"]);
  });

  it("passes through the private visibility the client mapped from internal", async () => {
    // The client maps `internal` to `private` (see client.test.ts); discovery must not undo it.
    const r = await discoverRepositories(
      clientOf([repo(1, "a", { visibility: "private" }), repo(2, "b", { visibility: "public" })]),
      cfg(),
    );
    expect(r.repos.map((x) => x.visibility)).toEqual(["private", "public"]);
  });
});

describe("repoNameSelection", () => {
  it("selects every name when the config narrows nothing", () => {
    expect(repoNameSelection(cfg(), "anything")).toBe("selected");
  });

  it("matches an explicit list case-insensitively", () => {
    const config = cfg({ repos: ["Handbook", { name: "metrics", docsPath: "kb" }] });
    expect(repoNameSelection(config, "handbook")).toBe("selected");
    expect(repoNameSelection(config, "METRICS")).toBe("selected");
    expect(repoNameSelection(config, "sandbox")).toBe("not_listed");
  });

  it("matches exclusions case-insensitively", () => {
    const config = cfg({ exclude: ["Sandbox"] });
    expect(repoNameSelection(config, "sandbox")).toBe("excluded");
    expect(repoNameSelection(config, "handbook")).toBe("selected");
  });

  it("agrees with discoverRepositories on which names are synced", async () => {
    const listing = [repo(1, "a"), repo(2, "B"), repo(3, "c")];
    for (const config of [cfg(), cfg({ repos: ["a", "b"] }), cfg({ exclude: ["C"] })]) {
      const r = await discoverRepositories(clientOf(listing), config);
      const selected = listing.filter((x) => repoNameSelection(config, x.name) === "selected");
      expect(names(r)).toEqual(selected.map((x) => x.name));
    }
  });
});
