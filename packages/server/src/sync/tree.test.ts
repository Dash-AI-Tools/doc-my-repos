import { describe, expect, it, vi } from "vitest";
import { GitHubError, type TreeEntry } from "../github/client";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_SPEC_BYTES,
  MAX_API_SPECS,
  planTree,
  SELECTION_RULES_VERSION,
  selectDocFiles,
  selectionFingerprint,
  type PlanRepo,
  type StoredTreeState,
  type TreeClient,
} from "./tree";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const TREE_SHA = sha(0xaaa);
const COMMIT_SHA = sha(0xccc);

let next = 1;
function blob(path: string, extra: Partial<TreeEntry> = {}): TreeEntry {
  return { path, mode: "100644", type: "blob", sha: sha(next++), size: 100, ...extra };
}
function dir(path: string): TreeEntry {
  return { path, mode: "040000", type: "tree", sha: sha(next++), size: null };
}

const repo: PlanRepo = { owner: "acme", name: "api", defaultBranch: "main", config: {} };
const firstSync: StoredTreeState = { treeSha: null, selectionFingerprint: null };

interface MockOptions {
  entries?: TreeEntry[];
  truncated?: boolean;
  treeSha?: string;
  headError?: GitHubError;
  headNotModified?: boolean;
}

/** A client whose every call is logged; `getBlob` exists only so tests can assert it is unused. */
function mockClient(opts: MockOptions = {}) {
  const calls: string[] = [];
  const treeSha = opts.treeSha ?? TREE_SHA;
  const client = {
    getBranchHead: vi.fn(
      async (_o: string, _r: string, _b: string, o?: { etag?: string | null }) => {
        calls.push(`head${o?.etag ? `:${o.etag}` : ""}`);
        if (opts.headError) throw opts.headError;
        if (opts.headNotModified) return { notModified: true as const };
        return {
          notModified: false as const,
          data: { commitSha: COMMIT_SHA, treeSha },
          etag: '"head-etag"',
        };
      },
    ),
    getTree: vi.fn(async (_o: string, _r: string, s: string) => {
      calls.push(`tree:${s}`);
      return {
        notModified: false as const,
        data: { sha: s, truncated: opts.truncated ?? false, entries: opts.entries ?? [] },
        etag: null,
      };
    }),
    getBlob: vi.fn(async () => {
      calls.push("blob");
      return { bytes: new Uint8Array() };
    }),
  };
  return { client: client as TreeClient & { getBlob: typeof client.getBlob }, calls, raw: client };
}

const sampleTree = () => [
  blob("README.md"),
  dir(".github"),
  blob(".github/CODEOWNERS"),
  dir("docs"),
  blob("docs/index.md"),
  blob("docs/guide.mdx"),
  blob("docs/logo.png"),
  dir("src"),
  blob("src/main.ts"),
];

async function syncedState(selection = {}): Promise<StoredTreeState> {
  return { treeSha: TREE_SHA, selectionFingerprint: selectionFingerprint(selection) };
}

describe("planTree short-circuit", () => {
  it("unchanged tree and same fingerprint: no tree and no blob calls", async () => {
    const { client, calls } = mockClient({ entries: sampleTree() });
    const plan = await planTree(client, repo, await syncedState());
    expect(plan).toMatchObject({ unchanged: true, outcome: "unchanged", treeSha: TREE_SHA });
    expect(calls).toEqual(["head"]);
  });

  it("uses a stored head ETag and short-circuits on 304", async () => {
    const { client, calls } = mockClient({ headNotModified: true });
    const stored = { ...(await syncedState()), headEtag: '"e1"', commitSha: COMMIT_SHA };
    const plan = await planTree(client, repo, stored);
    expect(plan).toMatchObject({ unchanged: true, treeSha: TREE_SHA, commitSha: COMMIT_SHA });
    expect(calls).toEqual(['head:"e1"']);
  });

  it("on 304 with a changed config, fetches the stored tree", async () => {
    const { client, calls } = mockClient({ headNotModified: true, entries: sampleTree() });
    const stored = { ...(await syncedState()), headEtag: '"e1"' };
    const plan = await planTree(client, { ...repo, config: { docsPath: "docs" } }, stored);
    expect(plan.unchanged).toBe(false);
    expect(calls).toEqual(['head:"e1"', `tree:${TREE_SHA}`]);
  });

  it("does not send an ETag without a stored tree SHA", async () => {
    const { client, calls } = mockClient({ entries: sampleTree() });
    await planTree(client, repo, { ...firstSync, headEtag: '"e1"' });
    expect(calls[0]).toBe("head");
  });

  it("first sync fetches the tree once and plans every doc", async () => {
    const { client, calls } = mockClient({ entries: sampleTree() });
    const plan = await planTree(client, repo, firstSync);
    expect(calls).toEqual(["head", `tree:${TREE_SHA}`]);
    if (plan.outcome !== "changed") throw new Error(plan.outcome);
    expect(plan.commitSha).toBe(COMMIT_SHA);
    expect(plan.headEtag).toBe('"head-etag"');
    expect(plan.docsFolder).toBe("docs");
    expect(plan.files.map((f) => f.path)).toEqual(["docs/guide.mdx", "docs/index.md"]);
    expect(plan.selectionFingerprint).toBe(selectionFingerprint());
  });

  it("a new tree SHA refetches the tree", async () => {
    const { client, calls } = mockClient({ entries: sampleTree(), treeSha: sha(0xbbb) });
    const plan = await planTree(client, repo, await syncedState());
    expect(plan.unchanged).toBe(false);
    expect(calls).toEqual(["head", `tree:${sha(0xbbb)}`]);
  });

  it.each([
    ["extension list", { selection: { extensions: [".md"] } }, {}],
    ["size cap", { selection: { maxFileBytes: 1000 } }, {}],
    ["ignored folders", { selection: { ignoredFolders: ["node_modules", "vendor"] } }, {}],
    ["docs override", {}, { docsPath: "handbook" }],
    ["default docs folders", { selection: { docsPaths: ["doc", "docs"] } }, {}],
  ])("same tree but changed %s refetches", async (_name, options, config) => {
    const { client, calls } = mockClient({ entries: sampleTree() });
    const plan = await planTree(client, { ...repo, config }, await syncedState(), options);
    expect(plan.unchanged).toBe(false);
    expect(calls).toEqual(["head", `tree:${TREE_SHA}`]);
  });

  it("a stored state without a fingerprint never short-circuits", async () => {
    const { client, calls } = mockClient({ entries: sampleTree() });
    await planTree(client, repo, { treeSha: TREE_SHA, selectionFingerprint: null });
    expect(calls).toHaveLength(2);
  });
});

describe("planTree failures and outcomes", () => {
  it("a truncated tree is a typed failure, never a partial plan", async () => {
    const { client } = mockClient({ entries: sampleTree(), truncated: true });
    const plan = await planTree(client, repo, firstSync);
    expect(plan).toMatchObject({ unchanged: false, outcome: "failed", reason: "tree_truncated" });
    expect(plan).not.toHaveProperty("files");
  });

  it("more docs than the cap is a capped, successful plan (task 12.3)", async () => {
    const entries = [dir("docs"), ...Array.from({ length: 4 }, (_, i) => blob(`docs/${i}.md`))];
    const { client } = mockClient({ entries });
    const plan = await planTree(client, repo, firstSync, { selection: { maxFiles: 3 } });
    expect(plan).toMatchObject({ outcome: "changed", capped: { found: 4, limit: 3 } });
    if (plan.outcome !== "changed") throw new Error("expected a changed plan");
    expect(plan.files.map((f) => f.path)).toEqual(["docs/0.md", "docs/1.md", "docs/2.md"]);
    expect(plan.skipped).toEqual([{ path: "docs/3.md", reason: "over_limit" }]);
    const ok = await planTree(mockClient({ entries }).client, repo, firstSync, {
      selection: { maxFiles: 4 },
    });
    expect(ok).toMatchObject({ outcome: "changed", capped: null });
  });

  it("no docs folder is a successful no_docs plan that keeps README and CODEOWNERS", async () => {
    const entries = [blob("README.md"), blob("CODEOWNERS"), dir("src"), blob("src/a.md")];
    const plan = await planTree(mockClient({ entries }).client, repo, firstSync);
    if (plan.outcome !== "no_docs") throw new Error(plan.outcome);
    expect(plan.docsFolder).toBeNull();
    expect(plan.files).toEqual([]);
    expect(plan.repoLevelFiles.readme?.path).toBe("README.md");
    expect(plan.repoLevelFiles.codeowners?.path).toBe("CODEOWNERS");
  });

  it("a docs override missing from the tree is no_docs, with no fallback", async () => {
    const plan = await planTree(
      mockClient({ entries: sampleTree() }).client,
      { ...repo, config: { docsPath: "handbook" } },
      firstSync,
    );
    expect(plan.outcome).toBe("no_docs");
  });

  it("an empty repository makes no GitHub calls", async () => {
    const { client, calls } = mockClient();
    const plan = await planTree(client, { ...repo, defaultBranch: "" }, firstSync);
    expect(plan.outcome).toBe("empty_repo");
    expect(calls).toEqual([]);
  });

  it("a head fetch failure propagates as a GitHubError", async () => {
    const { client, calls } = mockClient({ headError: new GitHubError("server", 502) });
    await expect(planTree(client, repo, await syncedState())).rejects.toMatchObject({
      kind: "server",
    });
    expect(calls).toEqual(["head"]);
  });

  it("a 404 on the head surfaces as not_found, not an empty plan", async () => {
    const { client } = mockClient({ headError: new GitHubError("not_found", 404) });
    const err = await planTree(client, repo, firstSync).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).kind).toBe("not_found");
  });

  it("an unexpected 304 without stored state is invalid_response", async () => {
    const { client } = mockClient({ headNotModified: true });
    await expect(planTree(client, repo, firstSync)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });
});

describe("selectDocFiles", () => {
  const paths = (entries: TreeEntry[], options = {}) =>
    selectDocFiles(entries, options).files.map((f) => f.path);

  it("selects .md and .mdx case-insensitively and sorts by path", () => {
    const entries = [dir("docs"), blob("docs/z.MD"), blob("docs/a.Mdx"), blob("docs/m.md")];
    expect(paths(entries)).toEqual(["docs/a.Mdx", "docs/m.md", "docs/z.MD"]);
  });

  it("skips non-doc extensions silently", () => {
    const s = selectDocFiles([dir("docs"), blob("docs/a.png"), blob("docs/b.markdown")]);
    expect(s.files).toEqual([]);
    expect(s.skipped).toEqual([]);
  });

  it("skips files over the cap and reports them; a file at the cap is kept", () => {
    const s = selectDocFiles([
      dir("docs"),
      blob("docs/big.md", { size: DEFAULT_MAX_FILE_BYTES + 1 }),
      blob("docs/edge.md", { size: DEFAULT_MAX_FILE_BYTES }),
      blob("docs/nosize.md", { size: null }),
    ]);
    expect(s.files.map((f) => f.path)).toEqual(["docs/edge.md"]);
    expect(s.skipped).toEqual([
      { path: "docs/big.md", reason: "too_large" },
      { path: "docs/nosize.md", reason: "size_unknown" },
    ]);
  });

  it("skips symlinks and submodules", () => {
    const s = selectDocFiles([
      dir("docs"),
      blob("docs/link.md", { mode: "120000" }),
      { path: "docs/sub.md", mode: "160000", type: "commit", sha: sha(9), size: null },
      blob("docs/exec.md", { mode: "100755" }),
    ]);
    expect(s.files.map((f) => f.path)).toEqual(["docs/exec.md"]);
    expect(s.skipped).toEqual([
      { path: "docs/link.md", reason: "not_regular_file" },
      { path: "docs/sub.md", reason: "not_regular_file" },
    ]);
  });

  it("skips ignored and hidden folders below the docs folder", () => {
    const s = selectDocFiles([
      dir("docs"),
      blob("docs/node_modules/pkg/readme.md"),
      blob("docs/Node_Modules/x.md"),
      blob("docs/.vitepress/theme.md"),
      blob("docs/.draft.md"),
      blob("docs/ok.md"),
    ]);
    expect(s.files.map((f) => f.path)).toEqual(["docs/ok.md"]);
    expect(s.skipped).toEqual([
      { path: "docs/.draft.md", reason: "hidden" },
      { path: "docs/.vitepress/theme.md", reason: "hidden" },
      { path: "docs/Node_Modules/x.md", reason: "ignored_folder" },
      { path: "docs/node_modules/pkg/readme.md", reason: "ignored_folder" },
    ]);
  });

  it("honours extra ignored folders from options", () => {
    const entries = [dir("docs"), blob("docs/vendor/a.md"), blob("docs/b.md")];
    expect(paths(entries, { ignoredFolders: ["node_modules", "vendor"] })).toEqual(["docs/b.md"]);
  });

  it("rejects traversal, NUL, control characters, backslashes and empty segments", () => {
    const s = selectDocFiles([
      dir("docs"),
      blob("docs/../secret.md"),
      blob("docs/./a.md"),
      blob("docs//b.md"),
      blob("docs/a\u0000.md"),
      blob("docs/a\nb.md"),
      blob("docs/a\\b.md"),
      blob(`docs/${"x".repeat(1100)}.md`),
      blob("docs/ok.md"),
    ]);
    expect(s.files.map((f) => f.path)).toEqual(["docs/ok.md"]);
    expect(s.skipped).toHaveLength(7);
    expect(s.skipped.every((x) => x.reason === "invalid_path")).toBe(true);
    // Reported paths are safe to store: no control characters survive.
    expect(s.skipped.some((x) => /[\u0000-\u001f]/.test(x.path))).toBe(false);
  });

  it("rejects entries whose object id is not a SHA", () => {
    const s = selectDocFiles([dir("docs"), blob("docs/a.md", { sha: "nope" })]);
    expect(s.skipped).toEqual([{ path: "docs/a.md", reason: "invalid_entry" }]);
  });

  it("uses the docs folder found in the tree, case kept, and only files under it", () => {
    const s = selectDocFiles([dir("Docs"), blob("Docs/a.md"), blob("other/b.md"), blob("c.md")]);
    expect(s.docsFolder).toBe("Docs");
    expect(s.files.map((f) => f.path)).toEqual(["Docs/a.md"]);
  });

  it("honours a docs override and normalizes it", () => {
    const entries = [dir("docs"), blob("docs/a.md"), dir("handbook"), blob("handbook/h.md")];
    expect(paths(entries, { docsPath: "./handbook/" })).toEqual(["handbook/h.md"]);
    expect(selectDocFiles(entries, { docsPath: "../x" }).docsFolder).toBeNull();
  });

  it("finds the root README and CODEOWNERS in GitHub's precedence", () => {
    const s = selectDocFiles([
      blob("readme.markdown"),
      blob("README.md"),
      blob("CODEOWNERS"),
      blob(".github/CODEOWNERS"),
      blob("sub/README.md"),
    ]);
    expect(s.repoLevelFiles.readme?.path).toBe("README.md");
    expect(s.repoLevelFiles.codeowners?.path).toBe(".github/CODEOWNERS");
    expect(s.repoLevelFiles.readme?.blobSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("README fallbacks: case-insensitive name, .markdown, then no extension", () => {
    expect(selectDocFiles([blob("Readme.md")]).repoLevelFiles.readme?.path).toBe("Readme.md");
    expect(
      selectDocFiles([blob("README"), blob("README.markdown")]).repoLevelFiles.readme?.path,
    ).toBe("README.markdown");
    expect(selectDocFiles([blob("README.txt")]).repoLevelFiles.readme).toBeNull();
    expect(selectDocFiles([blob("sub/README.md")]).repoLevelFiles.readme).toBeNull();
  });

  it("ignores symlinked README/CODEOWNERS and reports an oversized README", () => {
    const s = selectDocFiles([
      blob("README.md", { size: DEFAULT_MAX_FILE_BYTES + 1 }),
      blob(".github/CODEOWNERS", { mode: "120000" }),
      blob("CODEOWNERS"),
    ]);
    expect(s.repoLevelFiles.readme).toBeNull();
    expect(s.repoLevelFiles.codeowners?.path).toBe("CODEOWNERS");
    expect(s.skipped).toEqual([{ path: "README.md", reason: "too_large" }]);
  });

  it("is total on an empty tree", () => {
    expect(selectDocFiles([])).toEqual({
      apiSpecs: { files: [], skipped: [], leftOut: 0, configured: false },
      docsFolder: null,
      files: [],
      skipped: [],
      repoLevelFiles: { readme: null, codeowners: null },
      capped: null,
    });
  });
});

describe("document cap (task 12.3)", () => {
  const docs = (n: number) =>
    Array.from({ length: n }, (_, i) => blob(`docs/p${String(i).padStart(3, "0")}.md`));

  it("keeps exactly N files at the cap and caps at N + 1", () => {
    const atCap = selectDocFiles([dir("docs"), ...docs(5)], { maxFiles: 5 });
    expect(atCap.files).toHaveLength(5);
    expect(atCap.capped).toBeNull();
    expect(atCap.skipped).toEqual([]);

    const over = selectDocFiles([dir("docs"), ...docs(6)], { maxFiles: 5 });
    expect(over.files.map((f) => f.path)).toEqual([
      "docs/p000.md",
      "docs/p001.md",
      "docs/p002.md",
      "docs/p003.md",
      "docs/p004.md",
    ]);
    expect(over.capped).toEqual({ found: 6, limit: 5 });
    expect(over.skipped).toEqual([{ path: "docs/p005.md", reason: "over_limit" }]);
  });

  it("keeps the same files whatever the tree order (path order, code units)", () => {
    const entries = [
      dir("docs"),
      blob("docs/b.md"),
      blob("docs/A.md"),
      blob("docs/a/z.md"),
      blob("docs/a.md"),
      blob("docs/Z.md"),
    ];
    const forward = selectDocFiles(entries, { maxFiles: 3 });
    const backward = selectDocFiles([...entries].reverse(), { maxFiles: 3 });
    expect(forward.files.map((f) => f.path)).toEqual(["docs/A.md", "docs/Z.md", "docs/a.md"]);
    expect(backward.files.map((f) => f.path)).toEqual(forward.files.map((f) => f.path));
    expect(backward.skipped).toEqual(forward.skipped);
    expect(forward.skipped).toEqual([
      { path: "docs/a/z.md", reason: "over_limit" },
      { path: "docs/b.md", reason: "over_limit" },
    ]);
  });

  it("counts only selectable docs: skipped files do not use up the cap", () => {
    const entries = [
      dir("docs"),
      blob("docs/big.md", { size: DEFAULT_MAX_FILE_BYTES + 1 }),
      blob("docs/node_modules/x.md"),
      ...docs(3),
    ];
    const selection = selectDocFiles(entries, { maxFiles: 3 });
    expect(selection.files).toHaveLength(3);
    expect(selection.capped).toBeNull();
    expect(selection.skipped.map((s) => s.reason).sort()).toEqual(["ignored_folder", "too_large"]);
  });

  it("applies the size cap at the boundary and keeps README and CODEOWNERS out of the count", () => {
    const entries = [
      dir("docs"),
      blob("README.md"),
      blob("CODEOWNERS"),
      blob("docs/edge.md", { size: 1024 }),
      blob("docs/over.md", { size: 1025 }),
      blob("docs/small.md", { size: 10 }),
    ];
    const selection = selectDocFiles(entries, { maxFiles: 1, maxFileBytes: 1024 });
    expect(selection.files.map((f) => f.path)).toEqual(["docs/edge.md"]);
    expect(selection.capped).toEqual({ found: 2, limit: 1 });
    expect(selection.skipped).toEqual([
      { path: "docs/over.md", reason: "too_large" },
      { path: "docs/small.md", reason: "over_limit" },
    ]);
    expect(selection.repoLevelFiles.readme?.path).toBe("README.md");
    expect(selection.repoLevelFiles.codeowners?.path).toBe("CODEOWNERS");
  });

  it("defaults to 2000 documents", () => {
    expect(DEFAULT_MAX_FILES).toBe(2000);
    const selection = selectDocFiles([dir("docs"), ...docs(2001)]);
    expect(selection.files).toHaveLength(2000);
    expect(selection.capped).toEqual({ found: 2001, limit: 2000 });
  });

  it("re-plans when the cap or the size cap changes", async () => {
    const entries = [dir("docs"), ...docs(4)];
    const first = await planTree(mockClient({ entries }).client, repo, firstSync, {
      selection: { maxFiles: 3 },
    });
    const stored: StoredTreeState = {
      treeSha: first.treeSha,
      selectionFingerprint: first.selectionFingerprint,
    };
    const same = await planTree(mockClient({ entries }).client, repo, stored, {
      selection: { maxFiles: 3 },
    });
    expect(same.outcome).toBe("unchanged");
    for (const selection of [{ maxFiles: 4 }, { maxFiles: 3, maxFileBytes: 2048 }]) {
      const again = await planTree(mockClient({ entries }).client, repo, stored, { selection });
      expect(again.outcome).toBe("changed");
    }
  });
});

describe("selectionFingerprint", () => {
  it("carries the rules version (3: API spec selection)", () => {
    expect(SELECTION_RULES_VERSION).toBe(3);
    expect(selectionFingerprint()).toMatch(/^v3:[0-9a-f]{64}$/);
  });

  it("is stable for defaults and equivalent explicit settings", () => {
    expect(selectionFingerprint()).toBe(selectionFingerprint({}));
    expect(selectionFingerprint()).toBe(
      selectionFingerprint({
        extensions: [".MDX", ".md"],
        maxFileBytes: DEFAULT_MAX_FILE_BYTES,
        ignoredFolders: ["node_modules"],
        docsPaths: ["docs", "doc", "documentation"],
      }),
    );
    expect(selectionFingerprint({ docsPath: "./docs/" })).toBe(
      selectionFingerprint({ docsPath: "docs" }),
    );
    expect(selectionFingerprint({ apiSpecs: [] })).toBe(selectionFingerprint());
    expect(selectionFingerprint({ apiSpecs: ["b.yaml", "./a.yaml", "b.yaml"] })).toBe(
      selectionFingerprint({ apiSpecs: ["a.yaml", "b.yaml"] }),
    );
    expect(selectionFingerprint({ maxSpecBytes: DEFAULT_MAX_SPEC_BYTES })).toBe(
      selectionFingerprint(),
    );
  });

  it("changes with every selection input", () => {
    const base = selectionFingerprint();
    const variants = [
      { extensions: [".md"] },
      { maxFileBytes: 1024 },
      { ignoredFolders: ["vendor"] },
      { docsPath: "docs" },
      { docsPath: "../bad" },
      { docsPaths: ["doc", "docs", "documentation"] },
      { maxFiles: 10 },
      { apiSpecs: ["openapi.yaml"] },
      { apiSpecs: ["openapi.yaml", "api/spec.yaml"] },
      { maxSpecBytes: 1024 },
    ];
    const prints = variants.map((v) => selectionFingerprint(v));
    for (const p of prints) expect(p).not.toBe(base);
    expect(new Set(prints).size).toBe(prints.length);
  });

  it("rejects nonsense numbers and extensions", () => {
    expect(() => selectionFingerprint({ maxFileBytes: 0 })).toThrow(TypeError);
    expect(() => selectionFingerprint({ maxFiles: Number.NaN })).toThrow(TypeError);
    expect(() => selectionFingerprint({ extensions: ["md"] })).toThrow(TypeError);
    expect(() => selectionFingerprint({ extensions: [] })).toThrow(TypeError);
  });
});

describe("API spec selection", () => {
  const docs = (n: number) => Array.from({ length: n }, (_, i) => blob(`docs/d${i}.md`));
  const paths = (entries: TreeEntry[], options = {}) =>
    selectDocFiles(entries, options).apiSpecs.files.map((f) => f.path);

  it("finds openapi/swagger files at the root, any case and extension", () => {
    const entries = [
      blob("openapi.yaml"),
      blob("Swagger.JSON"),
      blob("OpenAPI.yml"),
      blob("api.yaml"),
      blob("openapi.yaml.bak"),
      blob("my-openapi.yaml"),
      blob("openapi.md"),
    ];
    expect(paths(entries)).toEqual(["OpenAPI.yml", "Swagger.JSON", "openapi.yaml"]);
  });

  it("finds specs anywhere under the docs folder, not elsewhere", () => {
    const entries = [
      dir("docs"),
      blob("docs/api/swagger.json"),
      blob("docs/a/b/c/openapi.yaml"),
      blob("docs/readme.md"),
      blob("src/openapi.yaml"),
      blob("docsx/openapi.yaml"),
    ];
    expect(paths(entries)).toEqual(["docs/a/b/c/openapi.yaml", "docs/api/swagger.json"]);
  });

  it("finds root specs when there is no docs folder, and follows a nested docs override", () => {
    expect(paths([blob("openapi.json"), blob("pkg/openapi.json")])).toEqual(["openapi.json"]);
    const entries = [
      dir("pkg"),
      dir("pkg/docs"),
      blob("pkg/docs/x/openapi.yaml"),
      blob("docs/openapi.yaml"),
    ];
    expect(paths(entries, { docsPath: "pkg/docs" })).toEqual(["pkg/docs/x/openapi.yaml"]);
  });

  it("configured paths replace the search", () => {
    const entries = [
      blob("openapi.yaml"),
      dir("docs"),
      blob("docs/swagger.json"),
      blob("api/v2/spec.yaml"),
      blob("other.yaml"),
    ];
    const sel = selectDocFiles(entries, { apiSpecs: ["./api/v2/spec.yaml", "missing.yaml"] });
    expect(sel.apiSpecs.files.map((f) => f.path)).toEqual(["api/v2/spec.yaml"]);
    expect(sel.apiSpecs.configured).toBe(true);
    expect(sel.apiSpecs.skipped).toEqual([]);
    // Any file name is allowed when configured, and docs are unaffected.
    expect(paths(entries, { apiSpecs: ["other.yaml"] })).toEqual(["other.yaml"]);
    expect(sel.docsFolder).toBe("docs");
  });

  it("an empty configured list means the default search", () => {
    expect(paths([blob("openapi.yaml")], { apiSpecs: [] })).toEqual(["openapi.yaml"]);
  });

  it("skips node_modules and hidden folders in the search, silently", () => {
    const entries = [
      dir("docs"),
      blob("docs/node_modules/x/openapi.yaml"),
      blob("docs/.hidden/openapi.yaml"),
      blob("docs/NODE_MODULES/swagger.json"),
      blob("docs/ok/openapi.yaml"),
      blob("node_modules/openapi.yaml"),
    ];
    const sel = selectDocFiles(entries);
    expect(sel.apiSpecs.files.map((f) => f.path)).toEqual(["docs/ok/openapi.yaml"]);
    expect(sel.apiSpecs.skipped).toEqual([]);
  });

  it("reports hidden and ignored folders for configured paths", () => {
    const entries = [blob(".github/openapi.yaml"), blob("node_modules/pkg/openapi.yaml")];
    const sel = selectDocFiles(entries, {
      apiSpecs: [".github/openapi.yaml", "node_modules/pkg/openapi.yaml"],
    });
    expect(sel.apiSpecs.files).toEqual([]);
    expect(sel.apiSpecs.skipped).toEqual([
      { path: ".github/openapi.yaml", reason: "hidden" },
      { path: "node_modules/pkg/openapi.yaml", reason: "ignored_folder" },
    ]);
  });

  it("skips oversized, symlinked, size-unknown and bad-SHA specs with typed reasons", () => {
    const entries = [
      blob("openapi.yaml", { size: 2000 }),
      blob("swagger.yaml", { size: 1000 }),
      blob("swagger.yml", { size: null }),
      blob("openapi.json", { mode: "120000" }),
      blob("swagger.json", { sha: "nothex" }),
    ];
    const sel = selectDocFiles(entries, { maxSpecBytes: 1000 });
    expect(sel.apiSpecs.files.map((f) => f.path)).toEqual(["swagger.yaml"]);
    expect(sel.apiSpecs.skipped).toEqual([
      { path: "openapi.json", reason: "not_regular_file" },
      { path: "openapi.yaml", reason: "too_large" },
      { path: "swagger.json", reason: "invalid_entry" },
      { path: "swagger.yml", reason: "size_unknown" },
    ]);
    expect(sel.skipped).toEqual([]);
  });

  it("allows specs up to the spec limit, larger than the document limit", () => {
    const entries = [blob("openapi.yaml", { size: DEFAULT_MAX_FILE_BYTES + 1 })];
    expect(paths(entries)).toEqual(["openapi.yaml"]);
    expect(selectDocFiles(entries).apiSpecs.skipped).toEqual([]);
  });

  it("keeps the first 10 in path order and counts the rest", () => {
    const names = Array.from(
      { length: 13 },
      (_, i) => `docs/s${String(i).padStart(2, "0")}/openapi.yaml`,
    );
    const sel = selectDocFiles([dir("docs"), ...names.reverse().map((n) => blob(n))]);
    expect(MAX_API_SPECS).toBe(10);
    expect(sel.apiSpecs.files.map((f) => f.path)).toEqual([...names].sort().slice(0, 10));
    expect(sel.apiSpecs.leftOut).toBe(3);
    expect(sel.apiSpecs.skipped.map((s) => s.reason)).toEqual([
      "over_limit",
      "over_limit",
      "over_limit",
    ]);
    expect(sel.apiSpecs.skipped.map((s) => s.path)).toEqual([...names].sort().slice(10));
  });

  it("exactly 10 specs is not over the limit", () => {
    const names = Array.from({ length: 10 }, (_, i) => `docs/s${i}/swagger.json`);
    const sel = selectDocFiles([dir("docs"), ...names.map((n) => blob(n))]);
    expect(sel.apiSpecs.files).toHaveLength(10);
    expect(sel.apiSpecs.leftOut).toBe(0);
  });

  it("never counts toward the document cap or the document list", () => {
    const entries = [dir("docs"), ...docs(3), blob("docs/openapi.yaml"), blob("swagger.json")];
    const sel = selectDocFiles(entries, { maxFiles: 3 });
    expect(sel.files).toHaveLength(3);
    expect(sel.capped).toBeNull();
    expect(sel.skipped).toEqual([]);
    expect(sel.apiSpecs.files.map((f) => f.path)).toEqual(["docs/openapi.yaml", "swagger.json"]);
  });

  it("is deterministic whatever the tree order", () => {
    const entries = [
      dir("docs"),
      blob("docs/b/openapi.yaml"),
      blob("docs/a/swagger.json"),
      blob("openapi.json"),
      blob("docs/c/openapi.yml", { size: 99_999_999 }),
    ];
    const a = selectDocFiles(entries);
    const b = selectDocFiles([...entries].reverse());
    expect(b.apiSpecs).toEqual(a.apiSpecs);
  });

  it("plans specs even without a docs folder (no_docs)", async () => {
    const plan = await planTree(
      mockClient({ entries: [blob("openapi.yaml")] }).client,
      repo,
      firstSync,
    );
    expect(plan.outcome).toBe("no_docs");
    if (plan.outcome !== "no_docs") return;
    expect(plan.apiSpecs.files.map((f) => f.path)).toEqual(["openapi.yaml"]);
  });

  it("planTree uses the repo's configured paths, and an empty repo has none", async () => {
    const entries = [blob("openapi.yaml"), blob("api/spec.yaml")];
    const configured = { ...repo, config: { apiSpecs: ["api/spec.yaml"] } };
    const plan = await planTree(mockClient({ entries }).client, configured, firstSync);
    if (plan.outcome !== "no_docs") throw new Error("expected no_docs");
    expect(plan.apiSpecs.files.map((f) => f.path)).toEqual(["api/spec.yaml"]);
    const empty = await planTree(mockClient().client, { ...repo, defaultBranch: "" }, firstSync);
    if (empty.outcome !== "empty_repo") throw new Error("expected empty_repo");
    expect(empty.apiSpecs.files).toEqual([]);
  });

  it("changing only the spec settings re-plans an otherwise unchanged repo", async () => {
    const entries = [dir("docs"), ...docs(2), blob("openapi.yaml")];
    const first = await planTree(mockClient({ entries }).client, repo, firstSync);
    const stored: StoredTreeState = {
      treeSha: first.treeSha,
      selectionFingerprint: first.selectionFingerprint,
    };
    const same = await planTree(mockClient({ entries }).client, repo, stored);
    expect(same.outcome).toBe("unchanged");
    const withPaths = await planTree(
      mockClient({ entries }).client,
      { ...repo, config: { apiSpecs: ["openapi.yaml"] } },
      stored,
    );
    expect(withPaths.outcome).toBe("changed");
    const smaller = await planTree(mockClient({ entries }).client, repo, stored, {
      selection: { maxSpecBytes: 1024 },
    });
    expect(smaller.outcome).toBe("changed");
  });
});
