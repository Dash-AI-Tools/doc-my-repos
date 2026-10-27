import { describe, expect, it } from "vitest";
import { GitHubError, type CallOptions } from "../github/client";
import {
  decodeBlobText,
  diffFiles,
  fetchBlobs,
  syncBlobs,
  type BlobClient,
  type BlobFile,
} from "./blobs";
import type { PlannedFile } from "./tree";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const repo = { owner: "acme", name: "api" };
const enc = (s: string) => new TextEncoder().encode(s);

/** A file whose blob content is `content`; the SHA is derived from `n`. */
function file(path: string, n: number, content = `# ${path}`): BlobFile & { content: string } {
  return { path, blobSha: sha(n), size: enc(content).length, content };
}

function planned(f: BlobFile): PlannedFile {
  return { path: f.path, blobSha: f.blobSha, size: f.size, mode: "100644" };
}

interface Deferred {
  sha: string;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
}

/**
 * A client serving blobs by SHA. With `manual`, each call stays pending until the test settles it,
 * so in-flight counts and completion order are under test control. Calls honour the signal.
 */
function mockClient(
  blobs: Record<string, Uint8Array | GitHubError>,
  opts: { manual?: boolean } = {},
) {
  const calls: string[] = [];
  const pending: Deferred[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const client: BlobClient = {
    getBlob(_owner: string, _repo: string, blobSha: string, o?: CallOptions) {
      calls.push(blobSha);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let finished = false;
      const done = () => {
        if (!finished) inFlight--;
        finished = true;
      };
      return new Promise<{ bytes: Uint8Array }>((resolve, reject) => {
        const settle = (value: Uint8Array | GitHubError | undefined) => {
          done();
          if (value === undefined) reject(new GitHubError("not_found", 404));
          else if (value instanceof GitHubError) reject(value);
          else resolve({ bytes: value });
        };
        o?.signal?.addEventListener(
          "abort",
          () => {
            done();
            reject(new GitHubError("aborted"));
          },
          { once: true },
        );
        if (opts.manual) {
          pending.push({
            sha: blobSha,
            resolve: (bytes) => settle(bytes),
            reject: (error) => {
              done();
              reject(error);
            },
          });
        } else {
          queueMicrotask(() => settle(blobs[blobSha]));
        }
      });
    },
  };
  return {
    client,
    calls,
    pending,
    get maxInFlight() {
      return maxInFlight;
    },
    get inFlight() {
      return inFlight;
    },
  };
}

function serve(files: (BlobFile & { content: string })[]): Record<string, Uint8Array> {
  return Object.fromEntries(files.map((f) => [f.blobSha, enc(f.content)]));
}

/** Lets queued microtasks and promise continuations run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("diffFiles", () => {
  it("splits files into added, modified, unchanged and removed, sorted by path", () => {
    const files = [file("docs/c.md", 3), file("docs/a.md", 1), file("docs/b.md", 2)];
    const stored = new Map([
      ["docs/b.md", sha(99)],
      ["docs/c.md", sha(3)],
      ["docs/z.md", sha(7)],
      ["docs/old.md", sha(8)],
    ]);
    const diff = diffFiles(files, stored);
    expect(diff.added.map((f) => f.path)).toEqual(["docs/a.md"]);
    expect(diff.modified.map((f) => f.path)).toEqual(["docs/b.md"]);
    expect(diff.unchanged.map((f) => f.path)).toEqual(["docs/c.md"]);
    expect(diff.removed).toEqual([
      { path: "docs/old.md", blobSha: sha(8) },
      { path: "docs/z.md", blobSha: sha(7) },
    ]);
  });

  it("treats a rename as removed plus added", () => {
    const diff = diffFiles([file("docs/new.md", 1)], new Map([["docs/old.md", sha(1)]]));
    expect(diff.added.map((f) => f.path)).toEqual(["docs/new.md"]);
    expect(diff.removed.map((f) => f.path)).toEqual(["docs/old.md"]);
  });

  it("compares paths case-sensitively", () => {
    const diff = diffFiles([file("docs/Guide.md", 1)], new Map([["docs/guide.md", sha(1)]]));
    expect(diff.added.map((f) => f.path)).toEqual(["docs/Guide.md"]);
    expect(diff.removed.map((f) => f.path)).toEqual(["docs/guide.md"]);
  });

  it("compares blob SHAs case-insensitively", () => {
    const f = file("docs/a.md", 0xabc);
    const diff = diffFiles([f], new Map([["docs/a.md", f.blobSha.toUpperCase()]]));
    expect(diff.unchanged).toHaveLength(1);
  });

  it("rejects duplicate planned paths", () => {
    expect(() => diffFiles([file("docs/a.md", 1), file("docs/a.md", 2)], new Map())).toThrow(
      TypeError,
    );
  });

  it("handles empty input", () => {
    expect(diffFiles([], new Map())).toEqual({
      added: [],
      modified: [],
      unchanged: [],
      removed: [],
    });
  });
});

describe("decodeBlobText", () => {
  it("strips a leading BOM", () => {
    const out = decodeBlobText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("# Hi")]));
    expect(out).toEqual({ text: "# Hi", warnings: [] });
  });

  it("replaces invalid UTF-8 and warns", () => {
    const out = decodeBlobText(new Uint8Array([0x61, 0xff, 0x62, 0xc3]));
    expect(out.text).toBe("a�b�");
    expect(out.warnings).toEqual(["invalid_utf8"]);
  });

  it("removes NUL characters and warns", () => {
    const out = decodeBlobText(new Uint8Array([0x61, 0x00, 0x62, 0x00]));
    expect(out).toEqual({ text: "ab", warnings: ["nul_stripped"] });
  });

  it("keeps valid multi-byte text unchanged", () => {
    expect(decodeBlobText(enc("héllo ✓ 𝄞")).text).toBe("héllo ✓ 𝄞");
  });
});

describe("fetchBlobs", () => {
  it("makes no request for an empty list", async () => {
    const m = mockClient({});
    expect(await fetchBlobs(m.client, repo, [])).toEqual({ fetched: [], failed: [] });
    expect(m.calls).toEqual([]);
  });

  it("rejects duplicate paths before any request", async () => {
    const m = mockClient({});
    await expect(
      fetchBlobs(m.client, repo, [file("docs/a.md", 1), file("docs/a.md", 1)]),
    ).rejects.toThrow(TypeError);
    expect(m.calls).toEqual([]);
  });

  it("fetches case-differing paths as distinct files", async () => {
    const files = [file("docs/A.md", 1, "upper"), file("docs/a.md", 2, "lower")];
    const m = mockClient(serve(files));
    const out = await fetchBlobs(m.client, repo, files);
    expect(out.fetched.map((f) => [f.path, f.text])).toEqual([
      ["docs/A.md", "upper"],
      ["docs/a.md", "lower"],
    ]);
  });

  it("never exceeds the concurrency limit", async () => {
    const files = Array.from({ length: 10 }, (_, i) => file(`docs/${i}.md`, i + 1));
    const m = mockClient(serve(files), { manual: true });
    const run = fetchBlobs(m.client, repo, files, { concurrency: 3 });
    for (let settled = 0; settled < files.length; settled++) {
      await flush();
      expect(m.inFlight).toBeLessThanOrEqual(3);
      const d = m.pending.shift() as Deferred;
      const f = files.find((x) => x.blobSha === d.sha) as BlobFile & { content: string };
      d.resolve(enc(f.content));
    }
    const out = await run;
    expect(m.maxInFlight).toBe(3);
    expect(out.fetched).toHaveLength(10);
  });

  it("keeps input order whatever order requests finish in", async () => {
    const files = [file("docs/a.md", 1), file("docs/b.md", 2), file("docs/c.md", 3)];
    const m = mockClient(serve(files), { manual: true });
    const run = fetchBlobs(m.client, repo, files, { concurrency: 3 });
    await flush();
    expect(m.pending).toHaveLength(3);
    for (const d of [...m.pending].reverse()) {
      const f = files.find((x) => x.blobSha === d.sha) as BlobFile & { content: string };
      d.resolve(enc(f.content));
      await flush();
    }
    const out = await run;
    expect(out.fetched.map((f) => f.path)).toEqual(["docs/a.md", "docs/b.md", "docs/c.md"]);
  });

  it("records a 404 for one file and fetches the others", async () => {
    const files = [file("docs/a.md", 1), file("docs/gone.md", 2), file("docs/c.md", 3)];
    const blobs: Record<string, Uint8Array | GitHubError> = serve(files);
    blobs[sha(2)] = new GitHubError("not_found", 404);
    const m = mockClient(blobs);
    const out = await fetchBlobs(m.client, repo, files);
    expect(out.fetched.map((f) => f.path)).toEqual(["docs/a.md", "docs/c.md"]);
    expect(out.failed).toEqual([{ path: "docs/gone.md", blobSha: sha(2), kind: "not_found" }]);
  });

  it("records a server error per file", async () => {
    const files = [file("docs/a.md", 1), file("docs/b.md", 2)];
    const blobs: Record<string, Uint8Array | GitHubError> = serve(files);
    blobs[sha(1)] = new GitHubError("server", 502);
    const out = await fetchBlobs(mockClient(blobs).client, repo, files);
    expect(out.failed.map((f) => f.kind)).toEqual(["server"]);
    expect(out.fetched.map((f) => f.path)).toEqual(["docs/b.md"]);
  });

  it("aborts on rate_limited, keeps retryAfterMs, and starts no further fetches", async () => {
    const files = Array.from({ length: 6 }, (_, i) => file(`docs/${i}.md`, i + 1));
    const m = mockClient(serve(files), { manual: true });
    const run = fetchBlobs(m.client, repo, files, { concurrency: 2 });
    const caught = run.catch((e: unknown) => e);
    await flush();
    expect(m.calls).toHaveLength(2);
    (m.pending[0] as Deferred).reject(new GitHubError("rate_limited", 403, 30_000));
    const error = await caught;
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).kind).toBe("rate_limited");
    expect((error as GitHubError).retryAfterMs).toBe(30_000);
    await flush();
    expect(m.calls).toHaveLength(2);
    // The other in-flight request was cancelled through its signal.
    expect(m.inFlight).toBe(0);
  });

  it.each(["unauthorized", "forbidden", "installation_unavailable", "app_credentials"] as const)(
    "aborts the whole fetch on %s",
    async (kind) => {
      const files = [file("docs/a.md", 1), file("docs/b.md", 2), file("docs/c.md", 3)];
      const blobs: Record<string, Uint8Array | GitHubError> = serve(files);
      blobs[sha(1)] = new GitHubError(kind);
      const m = mockClient(blobs);
      await expect(fetchBlobs(m.client, repo, files, { concurrency: 1 })).rejects.toMatchObject({
        kind,
      });
      expect(m.calls).toEqual([sha(1)]);
    },
  );

  it("rethrows errors that are not GitHubErrors", async () => {
    const client: BlobClient = {
      getBlob: () => Promise.reject(new Error("bug")),
    };
    await expect(fetchBlobs(client, repo, [file("docs/a.md", 1)])).rejects.toThrow("bug");
  });

  it("stops starting fetches when the signal aborts", async () => {
    const files = Array.from({ length: 5 }, (_, i) => file(`docs/${i}.md`, i + 1));
    const m = mockClient(serve(files), { manual: true });
    const controller = new AbortController();
    const run = fetchBlobs(m.client, repo, files, { concurrency: 2, signal: controller.signal });
    const caught = run.catch((e: unknown) => e);
    await flush();
    expect(m.calls).toHaveLength(2);
    controller.abort();
    expect(await caught).toMatchObject({ kind: "aborted" });
    await flush();
    expect(m.calls).toHaveLength(2);
    expect(m.inFlight).toBe(0);
  });

  it("makes no request when the signal is already aborted", async () => {
    const m = mockClient({});
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchBlobs(m.client, repo, [file("docs/a.md", 1)], { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(m.calls).toEqual([]);
  });

  it("decodes text: BOM, invalid UTF-8 and NUL", async () => {
    const files = [file("docs/a.md", 1), file("docs/b.md", 2), file("docs/c.md", 3)];
    const bytes = [
      new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
      new Uint8Array([0x61, 0xff]),
      new Uint8Array([0x61, 0x00]),
    ];
    const blobs = Object.fromEntries(files.map((f, i) => [f.blobSha, bytes[i] as Uint8Array]));
    const sized = files.map((f, i) => ({ ...f, size: (bytes[i] as Uint8Array).length }));
    const out = await fetchBlobs(mockClient(blobs).client, repo, sized);
    expect(out.fetched.map((f) => [f.text, f.warnings])).toEqual([
      ["a", []],
      ["a�", ["invalid_utf8"]],
      ["a", ["nul_stripped"]],
    ]);
  });

  it("fails a file whose content length differs from the tree size", async () => {
    const files = [file("docs/a.md", 1, "short"), file("docs/b.md", 2)];
    const blobs: Record<string, Uint8Array> = serve(files);
    blobs[sha(1)] = enc("much longer than the tree said");
    const out = await fetchBlobs(mockClient(blobs).client, repo, files);
    expect(out.failed).toEqual([{ path: "docs/a.md", blobSha: sha(1), kind: "size_mismatch" }]);
    expect(out.fetched.map((f) => f.path)).toEqual(["docs/b.md"]);
  });

  it("fails a file larger than the per-file cap without aborting the others", async () => {
    const big = file("docs/big.md", 1, "x".repeat(10));
    const small = file("docs/small.md", 2, "ok");
    const blobs = serve([big, small]);
    // The tree said 2 bytes, GitHub sent 10: over the cap of 5.
    const m = mockClient(blobs);
    const out = await fetchBlobs(m.client, repo, [{ ...big, size: 2 }, small], {
      maxFileBytes: 5,
    });
    expect(out.failed).toEqual([{ path: "docs/big.md", blobSha: sha(1), kind: "too_large" }]);
    expect(out.fetched.map((f) => f.path)).toEqual(["docs/small.md"]);
  });

  it("does not fetch a file the tree already reports over the cap", async () => {
    const big = file("docs/big.md", 1, "x".repeat(10));
    const m = mockClient(serve([big]));
    const out = await fetchBlobs(m.client, repo, [big], { maxFileBytes: 5 });
    expect(out.failed.map((f) => f.kind)).toEqual(["too_large"]);
    expect(m.calls).toEqual([]);
  });

  it("enforces the total byte budget in input order", async () => {
    const files = [
      file("docs/a.md", 1, "x".repeat(6)),
      file("docs/b.md", 2, "x".repeat(6)),
      file("docs/c.md", 3, "x".repeat(3)),
    ];
    const m = mockClient(serve(files));
    const out = await fetchBlobs(m.client, repo, files, { maxTotalBytes: 10, concurrency: 3 });
    expect(out.fetched.map((f) => f.path)).toEqual(["docs/a.md", "docs/c.md"]);
    expect(out.failed).toEqual([{ path: "docs/b.md", blobSha: sha(2), kind: "budget_exceeded" }]);
    expect(m.calls).not.toContain(sha(2));
  });

  it("rejects a non-positive concurrency", async () => {
    await expect(
      fetchBlobs(mockClient({}).client, repo, [file("docs/a.md", 1)], { concurrency: 0 }),
    ).rejects.toThrow(TypeError);
  });
});

describe("syncBlobs", () => {
  it("fetches exactly one blob when one file of many changed", async () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`docs/${i}.md`, i + 1));
    const stored = new Map(files.map((f) => [f.path, f.blobSha]));
    const changed = file("docs/7.md", 999, "# changed");
    const plan = files.map((f) => (f.path === changed.path ? changed : f));
    const m = mockClient(serve(plan));
    const out = await syncBlobs(m.client, repo, { files: plan, stored });
    expect(m.calls).toEqual([changed.blobSha]);
    expect(out.modified.map((f) => f.path)).toEqual(["docs/7.md"]);
    expect(out.unchanged).toHaveLength(19);
    expect(out.fetched.map((f) => [f.path, f.text])).toEqual([["docs/7.md", "# changed"]]);
    expect(out.removed).toEqual([]);
  });

  it("fetches nothing when nothing changed", async () => {
    const files = [file("docs/a.md", 1), file("docs/b.md", 2)];
    const m = mockClient(serve(files));
    const out = await syncBlobs(m.client, repo, {
      files,
      stored: new Map(files.map((f) => [f.path, f.blobSha])),
    });
    expect(m.calls).toEqual([]);
    expect(out.fetched).toEqual([]);
  });

  it("fetches added and modified, not unchanged, and lists removed", async () => {
    const a = file("docs/a.md", 1);
    const b = file("docs/b.md", 2);
    const c = file("docs/c.md", 3);
    const stored = new Map([
      [b.path, sha(20)],
      [c.path, c.blobSha],
      ["docs/gone.md", sha(40)],
    ]);
    const m = mockClient(serve([a, b, c]));
    const out = await syncBlobs(m.client, repo, { files: [a, b, c], stored });
    expect([...m.calls].sort()).toEqual([a.blobSha, b.blobSha]);
    expect(out.added.map((f) => f.path)).toEqual(["docs/a.md"]);
    expect(out.modified.map((f) => f.path)).toEqual(["docs/b.md"]);
    expect(out.unchanged.map((f) => f.path)).toEqual(["docs/c.md"]);
    expect(out.removed.map((f) => f.path)).toEqual(["docs/gone.md"]);
    expect(out.fetched.map((f) => f.path)).toEqual(["docs/a.md", "docs/b.md"]);
  });

  it("reports a failed modified file as failed, never as removed", async () => {
    const b = file("docs/b.md", 2);
    const blobs: Record<string, Uint8Array | GitHubError> = {
      [b.blobSha]: new GitHubError("not_found", 404),
    };
    const out = await syncBlobs(mockClient(blobs).client, repo, {
      files: [b],
      stored: new Map([[b.path, sha(20)]]),
    });
    expect(out.failed).toEqual([{ path: "docs/b.md", blobSha: b.blobSha, kind: "not_found" }]);
    expect(out.removed).toEqual([]);
    expect(out.fetched).toEqual([]);
  });

  it("fetches a changed README and skips an unchanged CODEOWNERS", async () => {
    const readme = file("README.md", 50, "# Readme");
    const owners = file(".github/CODEOWNERS", 51, "* @acme/team");
    const doc = file("docs/a.md", 1);
    const m = mockClient(serve([readme, owners, doc]));
    const out = await syncBlobs(m.client, repo, {
      files: [doc],
      stored: new Map([[doc.path, doc.blobSha]]),
      repoLevel: {
        files: { readme: planned(readme), codeowners: planned(owners) },
        stored: { readmeSha: sha(49), codeownersSha: owners.blobSha },
      },
    });
    expect(m.calls).toEqual([readme.blobSha]);
    expect(out.repoLevel.readme).toMatchObject({ state: "fetched", text: "# Readme" });
    expect(out.repoLevel.codeowners).toMatchObject({ state: "unchanged" });
    expect(out.fetched).toEqual([]);
  });

  it("reports absent and failed repo-level files", async () => {
    const owners = file("CODEOWNERS", 51, "* @acme/team");
    const blobs: Record<string, Uint8Array | GitHubError> = {
      [owners.blobSha]: new GitHubError("server", 500),
    };
    const out = await syncBlobs(mockClient(blobs).client, repo, {
      files: [],
      stored: new Map(),
      repoLevel: {
        files: { readme: null, codeowners: planned(owners) },
        stored: { readmeSha: sha(49), codeownersSha: null },
      },
    });
    expect(out.repoLevel.readme).toEqual({ state: "absent" });
    expect(out.repoLevel.codeowners).toMatchObject({ state: "failed", kind: "server" });
    expect(out.failed).toEqual([]);
  });

  it("propagates a fatal error from a repo-level fetch", async () => {
    const readme = file("README.md", 50);
    const blobs: Record<string, Uint8Array | GitHubError> = {
      [readme.blobSha]: new GitHubError("rate_limited", 429, 1000),
    };
    await expect(
      syncBlobs(mockClient(blobs).client, repo, {
        files: [],
        stored: new Map(),
        repoLevel: {
          files: { readme: planned(readme), codeowners: null },
          stored: { readmeSha: null, codeownersSha: null },
        },
      }),
    ).rejects.toMatchObject({ kind: "rate_limited", retryAfterMs: 1000 });
  });

  it("diffs and fetches specs apart from documents, with their own size cap", async () => {
    const doc = file("docs/a.md", 1);
    const keep = file("openapi.yaml", 2, "openapi: 3.0.3");
    const edit = file("docs/swagger.json", 3, "x".repeat(300_000));
    const fresh = file("swagger.yaml", 4, "swagger: '2.0'");
    const m = mockClient(serve([doc, keep, edit, fresh]));
    const out = await syncBlobs(
      m.client,
      repo,
      {
        files: [doc],
        stored: new Map(),
        apiSpecs: {
          files: [keep, edit, fresh],
          stored: new Map([
            [keep.path, keep.blobSha],
            [edit.path, sha(90)],
            ["old.yaml", sha(91)],
          ]),
          maxBytes: 400_000,
        },
      },
      { maxFileBytes: 262_144 },
    );
    // The 300 KB spec is over the document cap but under the spec cap, and is fetched.
    expect(m.calls.sort()).toEqual([doc.blobSha, edit.blobSha, fresh.blobSha].sort());
    expect(out.fetched.map((f) => f.path)).toEqual(["docs/a.md"]);
    expect(out.apiSpecs.fetched.map((f) => f.path)).toEqual(["docs/swagger.json", "swagger.yaml"]);
    expect(out.apiSpecs.unchanged.map((f) => f.path)).toEqual(["openapi.yaml"]);
    expect(out.apiSpecs.removed.map((f) => f.path)).toEqual(["old.yaml"]);
    expect(out.apiSpecs.failed).toEqual([]);
  });

  it("reports a spec over its own cap as failed too_large without fetching it", async () => {
    const big = file("openapi.yaml", 5, "x".repeat(2000));
    const m = mockClient(serve([big]));
    const out = await syncBlobs(m.client, repo, {
      files: [],
      stored: new Map(),
      apiSpecs: { files: [big], stored: new Map(), maxBytes: 1000 },
    });
    expect(m.calls).toEqual([]);
    expect(out.apiSpecs.failed).toEqual([
      { path: "openapi.yaml", blobSha: big.blobSha, kind: "too_large" },
    ]);
  });
});
