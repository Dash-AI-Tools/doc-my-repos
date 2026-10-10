import { createHash } from "node:crypto";

/**
 * Test support: an in-memory GitHub that answers the REST calls `createGitHubClient` and the App
 * token provider make, so sync tests run the real client code over an injected `fetch` and never
 * touch the network.
 *
 * Built from a fixture (repositories and their files) and mutable between syncs: change or delete
 * a file, flip visibility, rename, archive, add or remove a repository, make the installation
 * disappear. Git object ids are computed from content (blob ids are real Git blob SHA-1s; tree and
 * commit ids are stable hashes of the tree), so unchanged content keeps its ids across syncs.
 *
 * Every request is appended to `requests` (method, path, query; never the token), and failure
 * rules can make matching requests answer with any status and headers.
 *
 * Endpoints: `POST /app/installations/{id}/access_tokens`, `GET /installation/repositories`,
 * `GET /repos/{o}/{r}`, `.../branches/{b}` (ETag + `If-None-Match` -> 304), `.../git/trees/{sha}`,
 * `.../git/blobs/{sha}` (base64, wrapped like GitHub's) and `.../contents/{path}` (raw).
 */

export type FakeVisibility = "public" | "private" | "internal";

export interface FakeRepoInit {
  id: number;
  name: string;
  /** Defaults to the fake's owner. */
  owner?: string;
  visibility?: FakeVisibility;
  archived?: boolean;
  description?: string | null;
  /** Default "main". null: an empty repository with no default branch. */
  defaultBranch?: string | null;
  /** Path -> content. */
  files?: Record<string, string | Uint8Array>;
  /** Report the recursive tree as truncated. */
  truncatedTree?: boolean;
}

export interface FakeGitHubOptions {
  owner?: string;
  installationId?: number;
  /** Installation token the token endpoint mints and the API accepts. */
  token?: string;
  repos: FakeRepoInit[];
  /** Clock for token expiry. */
  now?: () => number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  /** Whether an Authorization header was sent (its value is never recorded). */
  authorized: boolean;
}

export interface FailureRule {
  method?: string;
  /** Matched against the request path (no query). A string must match exactly. */
  path: RegExp | string;
  status: number;
  headers?: Record<string, string>;
  /** How many matching requests fail. Default: all of them. */
  times?: number;
}

/** Called before a request is answered; may be async (for example to change the database). */
export type RequestHook = (request: RecordedRequest) => void | Promise<void>;

interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  visibility: FakeVisibility;
  archived: boolean;
  description: string | null;
  defaultBranch: string | null;
  files: Map<string, Uint8Array>;
  truncatedTree: boolean;
}

interface TreeJson {
  sha: string;
  truncated: boolean;
  tree: { path: string; mode: string; type: string; sha: string; size?: number }[];
}

const sha1 = (data: string | Uint8Array) => createHash("sha1").update(data).digest("hex");

/** Git's blob id: sha1("blob <size>\0" + bytes). */
export function gitBlobSha(content: string | Uint8Array): string {
  const bytes = toBytes(content);
  return sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export class FakeGitHub {
  readonly owner: string;
  readonly installationId: number;
  readonly token: string;
  readonly requests: RecordedRequest[] = [];
  /** When true the installation is gone: token minting and the listing answer 404. */
  installationGone = false;
  onRequest: RequestHook | null = null;

  private readonly repos: FakeRepo[] = [];
  /** Every blob ever served, per repo id. */
  private readonly blobs = new Map<number, Map<string, Uint8Array>>();
  /** Every tree ever computed, per repo id. */
  private readonly trees = new Map<number, Map<string, TreeJson>>();
  private rules: (FailureRule & { left: number })[] = [];
  private readonly now: () => number;

  constructor(options: FakeGitHubOptions) {
    this.owner = options.owner ?? "acme";
    this.installationId = options.installationId ?? 4242;
    this.token = options.token ?? "ghs_faketoken0123456789";
    this.now = options.now ?? Date.now;
    for (const init of options.repos) this.addRepo(init);
  }

  // -------------------------------------------------------------------------------------------
  // Fixture mutation

  addRepo(init: FakeRepoInit): void {
    if (this.repos.some((r) => r.id === init.id)) throw new Error(`repo id ${init.id} exists`);
    const files = new Map<string, Uint8Array>();
    for (const [path, content] of Object.entries(init.files ?? {}))
      files.set(path, toBytes(content));
    this.repos.push({
      id: init.id,
      owner: init.owner ?? this.owner,
      name: init.name,
      visibility: init.visibility ?? "public",
      archived: init.archived ?? false,
      description: init.description ?? null,
      defaultBranch: init.defaultBranch === undefined ? "main" : init.defaultBranch,
      files,
      truncatedTree: init.truncatedTree ?? false,
    });
  }

  /** Removes the repository from the installation (and from GitHub). */
  removeRepo(id: number): void {
    const index = this.repos.findIndex((r) => r.id === id);
    if (index < 0) throw new Error(`no repo ${id}`);
    this.repos.splice(index, 1);
  }

  updateRepo(
    id: number,
    patch: Partial<
      Pick<
        FakeRepo,
        | "owner"
        | "name"
        | "visibility"
        | "archived"
        | "description"
        | "defaultBranch"
        | "truncatedTree"
      >
    >,
  ): void {
    Object.assign(this.repo(id), patch);
  }

  setFile(id: number, path: string, content: string | Uint8Array): void {
    this.repo(id).files.set(path, toBytes(content));
  }

  deleteFile(id: number, path: string): void {
    if (!this.repo(id).files.delete(path)) throw new Error(`no file ${path}`);
  }

  fail(rule: FailureRule): void {
    this.rules.push({ ...rule, left: rule.times ?? Number.POSITIVE_INFINITY });
  }

  clearFailures(): void {
    this.rules = [];
  }

  clearRequests(): void {
    this.requests.length = 0;
  }

  /** Recorded requests whose path matches. */
  requestsTo(pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((r) => pattern.test(r.path));
  }

  /** Current root tree id of a repository. */
  treeSha(id: number): string {
    return this.computeTree(this.repo(id)).sha;
  }

  /** A token provider stub (`getToken`) for `createGitHubClient`. */
  readonly getToken = async (): Promise<string> => this.token;

  // -------------------------------------------------------------------------------------------
  // fetch

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const auth = headers.get("authorization");
    const request: RecordedRequest = {
      method,
      path: url.pathname,
      query: url.search.replace(/^\?/, ""),
      authorized: auth !== null,
    };
    this.requests.push(request);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (this.onRequest) await this.onRequest(request);

    for (const rule of this.rules) {
      if (rule.left <= 0) continue;
      if (rule.method !== undefined && rule.method.toUpperCase() !== method) continue;
      const hit =
        typeof rule.path === "string" ? rule.path === url.pathname : rule.path.test(url.pathname);
      if (!hit) continue;
      rule.left--;
      return json(rule.status, { message: "injected failure" }, rule.headers);
    }
    return this.route(method, url, auth, headers);
  };

  private route(method: string, url: URL, auth: string | null, headers: Headers): Response {
    const notFound = () => json(404, { message: "Not Found" });
    const path = url.pathname;

    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (tokenMatch && method === "POST") {
      if (!auth || !/^bearer [\w-]+\.[\w-]+\.[\w-]+$/i.test(auth)) {
        return json(401, { message: "A JSON web token could not be decoded" });
      }
      if (this.installationGone || Number(tokenMatch[1]) !== this.installationId) return notFound();
      const now = this.now();
      return json(
        201,
        { token: this.token, expires_at: new Date(now + 60 * 60 * 1000).toISOString() },
        { date: new Date(now).toUTCString() },
      );
    }

    if (method !== "GET") return notFound();
    if (auth !== `Bearer ${this.token}`) return json(401, { message: "Bad credentials" });

    if (path === "/installation/repositories") {
      if (this.installationGone) return notFound();
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = this.repos.slice((page - 1) * perPage, page * perPage);
      return json(200, {
        total_count: this.repos.length,
        repositories: slice.map((r) => this.repoJson(r)),
      });
    }

    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return notFound();
    const repo = this.findRepo(decodeURIComponent(m[1] ?? ""), decodeURIComponent(m[2] ?? ""));
    if (!repo) return notFound();
    const rest = m[3] ?? "";
    if (rest === "") return json(200, this.repoJson(repo));

    const branch = /^\/branches\/(.+)$/.exec(rest);
    if (branch) {
      const name = decodeURIComponent(branch[1] ?? "");
      if (repo.defaultBranch === null || name !== repo.defaultBranch) return notFound();
      const tree = this.computeTree(repo);
      const commitSha = sha1(`commit\0${tree.sha}`);
      const etag = `W/"${commitSha}"`;
      if (headers.get("if-none-match") === etag)
        return new Response(null, { status: 304, headers: { etag } });
      return json(
        200,
        { name, commit: { sha: commitSha, commit: { tree: { sha: tree.sha } } } },
        { etag },
      );
    }

    const tree = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest);
    if (tree) {
      const found = this.trees.get(repo.id)?.get(tree[1] ?? "");
      if (!found) return notFound();
      return json(200, { ...found, truncated: repo.truncatedTree });
    }

    const blob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (blob) {
      const bytes = this.blobs.get(repo.id)?.get(blob[1] ?? "");
      if (!bytes) return notFound();
      const b64 = Buffer.from(bytes).toString("base64");
      const wrapped = (b64.match(/.{1,60}/g) ?? []).join("\n");
      return json(200, { sha: blob[1], size: bytes.length, encoding: "base64", content: wrapped });
    }

    const contents = /^\/contents\/(.+)$/.exec(rest);
    if (contents) {
      const filePath = contents[1]?.split("/").map(decodeURIComponent).join("/") ?? "";
      const bytes = repo.files.get(filePath);
      if (!bytes) return notFound();
      return new Response(Buffer.from(bytes), { status: 200 });
    }
    return notFound();
  }

  // -------------------------------------------------------------------------------------------
  // Internals

  private repo(id: number): FakeRepo {
    const repo = this.repos.find((r) => r.id === id);
    if (!repo) throw new Error(`no repo ${id}`);
    return repo;
  }

  private findRepo(owner: string, name: string): FakeRepo | undefined {
    return this.repos.find(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.name.toLowerCase() === name.toLowerCase(),
    );
  }

  private repoJson(repo: FakeRepo) {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      default_branch: repo.defaultBranch,
      archived: repo.archived,
      private: repo.visibility !== "public",
      visibility: repo.visibility,
      description: repo.description,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
    };
  }

  /** The recursive tree of the current files, remembered so its id stays resolvable. */
  private computeTree(repo: FakeRepo): TreeJson {
    const blobStore = this.blobs.get(repo.id) ?? new Map<string, Uint8Array>();
    this.blobs.set(repo.id, blobStore);
    const entries: TreeJson["tree"] = [];
    const dirs = new Set<string>();
    for (const [path, bytes] of [...repo.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      const sha = gitBlobSha(bytes);
      blobStore.set(sha, bytes);
      entries.push({ path, mode: "100644", type: "blob", sha, size: bytes.length });
    }
    for (const dir of dirs) {
      const inside = entries
        .filter((e) => e.path.startsWith(`${dir}/`))
        .map((e) => `${e.path} ${e.sha}`);
      entries.push({
        path: dir,
        mode: "040000",
        type: "tree",
        sha: sha1(`tree\0${dir}\0${inside.join("\n")}`),
      });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const sha = sha1(`tree\0${entries.map((e) => `${e.mode} ${e.path} ${e.sha}`).join("\n")}`);
    const tree: TreeJson = { sha, truncated: false, tree: entries };
    const store = this.trees.get(repo.id) ?? new Map<string, TreeJson>();
    store.set(sha, tree);
    this.trees.set(repo.id, store);
    return tree;
  }
}
