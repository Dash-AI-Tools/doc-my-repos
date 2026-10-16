/**
 * A small fake of the parts of the GitHub API the installer uses, on a loopback port. Test support
 * only: it is excluded from the build and from the published package.
 */
import { createPublicKey, createVerify } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeInstallation {
  id: number;
  login: string;
  type?: string;
}

export interface FakeGithubState {
  appId: number;
  slug: string;
  name: string;
  /** Public key (PEM) the App JWT must verify against; `null` skips the signature check. */
  publicKeyPem: string | null;
  permissions: Record<string, string>;
  events: string[];
  installations: FakeInstallation[];
  repositories: string[];
  /** Total reported by the repositories endpoint (defaults to the list length). */
  repositoriesTotal: number | null;
  /** Code the conversion endpoint accepts, and what it returns. */
  manifestCode: string;
  manifestResult: { pem: string; webhook_secret: string };
  installationToken: string;
  /** When set, the next request answers with this instead. */
  failNext: { status: number; headers?: Record<string, string>; body?: unknown } | null;
  /** When true, every request answers 429. */
  rateLimited: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
}

export interface FakeGithub {
  readonly url: string;
  readonly state: FakeGithubState;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") === true ? header.slice(7) : undefined;
}

function verifyJwt(jwt: string, state: FakeGithubState, nowSeconds: number): boolean {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts as [string, string, string];
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims !== "object" || claims === null) return false;
    const { iss, exp, iat } = claims as Record<string, unknown>;
    if (iss !== String(state.appId)) return false;
    if (typeof exp !== "number" || typeof iat !== "number") return false;
    if (exp <= nowSeconds || exp - iat > 10 * 60 + 60) return false;
    if (state.publicKeyPem === null) return true;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    return verifier.verify(
      createPublicKey(state.publicKeyPem),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export async function startFakeGithub(
  overrides: Partial<FakeGithubState> = {},
): Promise<FakeGithub> {
  const state: FakeGithubState = {
    appId: 12345,
    slug: "docmyrepos-acme",
    name: "DocMyRepos (acme)",
    publicKeyPem: null,
    permissions: { contents: "read", metadata: "read" },
    events: ["push", "repository"],
    installations: [],
    repositories: [],
    repositoriesTotal: null,
    manifestCode: "good-code",
    manifestResult: {
      pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
      webhook_secret: "fake-webhook-secret-0123456789",
    },
    installationToken: "ghs_fakeInstallationToken0123456789abcdef",
    failNext: null,
    rateLimited: false,
    ...overrides,
  };
  const requests: RecordedRequest[] = [];

  const send = (
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(body));
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "http://fake");
    const method = request.method ?? "GET";
    const token = bearer(request);
    requests.push({ method, path: `${url.pathname}${url.search}`, authorization: token });

    if (state.failNext !== null) {
      const failure = state.failNext;
      state.failNext = null;
      send(response, failure.status, failure.body ?? { message: "failure" }, failure.headers);
      return;
    }
    if (state.rateLimited) {
      send(response, 429, { message: "API rate limit exceeded" }, { "retry-after": "60" });
      return;
    }

    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(url.pathname);
    if (method === "POST" && conversion !== null) {
      if (conversion[1] !== state.manifestCode) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      send(response, 201, {
        id: state.appId,
        slug: state.slug,
        name: state.name,
        client_id: "Iv1.fakeclient",
        client_secret: "fake-client-secret",
        ...state.manifestResult,
      });
      return;
    }

    const needsJwt = url.pathname === "/app" || url.pathname.startsWith("/app/installations");
    if (needsJwt) {
      if (token === undefined || !verifyJwt(token, state, Math.floor(Date.now() / 1000))) {
        send(response, 401, { message: "A JSON web token could not be decoded" });
        return;
      }
    }

    if (method === "GET" && url.pathname === "/app") {
      send(response, 200, {
        id: state.appId,
        slug: state.slug,
        name: state.name,
        permissions: state.permissions,
        events: state.events,
      });
      return;
    }
    if (method === "GET" && url.pathname === "/app/installations") {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = state.installations.slice((page - 1) * perPage, page * perPage);
      send(
        response,
        200,
        slice.map((i) => ({
          id: i.id,
          account: { login: i.login, type: i.type ?? "Organization" },
        })),
      );
      return;
    }
    const tokenRoute = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (method === "POST" && tokenRoute !== null) {
      const id = Number(tokenRoute[1]);
      if (!state.installations.some((i) => i.id === id)) {
        send(response, 404, { message: "Not Found" });
        return;
      }
      send(response, 201, { token: state.installationToken, expires_at: "2099-01-01T00:00:00Z" });
      return;
    }
    if (method === "GET" && url.pathname === "/installation/repositories") {
      if (token !== state.installationToken) {
        send(response, 401, { message: "Bad credentials" });
        return;
      }
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const slice = state.repositories.slice((page - 1) * perPage, page * perPage);
      send(response, 200, {
        total_count: state.repositoriesTotal ?? state.repositories.length,
        repositories: slice.map((name) => ({ name, full_name: `acme/${name}` })),
      });
      return;
    }
    send(response, 404, { message: "Not Found" });
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
