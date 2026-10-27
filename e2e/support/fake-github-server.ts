import { createServer } from "node:http";

import { FakeGitHub } from "../../tests/support/fake-github";
import { FAKE_GITHUB_PORT } from "./stack";

/**
 * The fake GitHub API for the `settings` e2e stack, run as one of Playwright's web servers (see
 * `playwright.config.ts`). It serves the same in-memory fixture the unit tests use over HTTP on a
 * fixed loopback port; the `settings` app server's GitHub requests are redirected here by
 * `redirect-github.cjs`. `/__control/requests` lists the requests received (method and path only,
 * never a token) and `/__control/reset` clears that list, so specs can prove GitHub was or was not
 * called. No real GitHub is ever contacted.
 */

export const INSTALLATION_ID = 4242;
export const FAKE_REPO = { id: 9001, name: "field-guide" };

const fake = new FakeGitHub({
  owner: "acme",
  installationId: INSTALLATION_ID,
  repos: [
    {
      id: FAKE_REPO.id,
      name: FAKE_REPO.name,
      files: {
        "README.md": "# Field guide\n",
        "docs/start.md": "# Start here\n\nWelcome to the field guide.\n",
      },
    },
    { id: 9002, name: "private-notes", files: { "docs/a.md": "# A\n" } },
  ],
});

let count = 0;
const received: { method: string; path: string }[] = [];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${FAKE_GITHUB_PORT}`);
  if (url.pathname === "/__control/health") {
    res.end("ok");
    return;
  }
  if (url.pathname === "/__control/requests") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(received));
    return;
  }
  if (url.pathname === "/__control/reset") {
    received.length = 0;
    res.end("ok");
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    count += 1;
    received.push({ method: req.method ?? "GET", path: url.pathname });
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    void fake
      .fetch(`https://api.github.com${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
      })
      .then(async (response) => {
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      })
      .catch(() => {
        res.statusCode = 500;
        res.end("fake github error");
      });
  });
});

server.listen(FAKE_GITHUB_PORT, "127.0.0.1", () => {
  console.log(`[e2e] fake GitHub on http://127.0.0.1:${FAKE_GITHUB_PORT} (${count} requests)`);
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
