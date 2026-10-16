import { describe, expect, it } from "vitest";

import { type Answers, chooseKeyLayout, PlanError, plan } from "./plan.js";
import { rsaPem } from "./test-support.js";

const pem = rsaPem("pkcs1");

const base: Answers = {
  org: "acme",
  url: "http://localhost:3000",
  port: 3000,
  adminEmail: "admin@example.com",
  adminPassword: "correct horse battery",
  repos: "all",
  appId: 4242,
  installationId: 99,
  privateKeyPem: pem,
  webhookSecret: "w".repeat(40),
  sessionSecret: "s".repeat(43),
  syncSecret: "y".repeat(43),
  postgresPassword: "p".repeat(43),
  imageTag: "1.2.0",
  host: { platform: "linux", uid: 1000 },
};

/** Snapshots must not depend on the random test key. */
function view(files: ReturnType<typeof plan>["files"]) {
  return files.map((f) => ({
    path: f.path,
    mode: f.mode.toString(8),
    content: f.content
      .replaceAll(pem.trim(), "<PEM>")
      .replace(/GITHUB_APP_PRIVATE_KEY='[^']*'/, "GITHUB_APP_PRIVATE_KEY='<PEM, \\n escaped>'"),
  }));
}

describe("plan", () => {
  it("all repositories, key as a compose secret (uid 1000)", () => {
    const result = plan(base);
    expect(result.keyLayout).toBe("file");
    expect(view(result.files)).toMatchSnapshot();
  });

  it("picked repositories, key inline (other uid on Linux)", () => {
    const result = plan({
      ...base,
      repos: ["api", "true", "web.app"],
      host: { platform: "linux", uid: 1001 },
    });
    expect(result.keyLayout).toBe("inline");
    expect(result.files.map((f) => f.path)).not.toContain("github-app.private-key.pem");
    expect(view(result.files)).toMatchSnapshot();
  });

  it("inline key uses \\n escapes that the app accepts", () => {
    const env = plan({ ...base, host: { platform: "linux", uid: 0 } }).files.find(
      (f) => f.path === ".env",
    )?.content;
    const value = /GITHUB_APP_PRIVATE_KEY='([^']*)'/.exec(env ?? "")?.[1] ?? "";
    expect(value).not.toContain("\n");
    expect(value.replace(/\\n/g, "\n")).toBe(pem.trim());
  });

  describe("key layout rule", () => {
    it.each([
      [{ platform: "darwin", uid: 501 }, "file"],
      [{ platform: "win32", uid: null }, "file"],
      [{ platform: "linux", uid: 1000 }, "file"],
      [{ platform: "linux", uid: 1001 }, "inline"],
      [{ platform: "linux", uid: 0 }, "inline"],
      [{ platform: "freebsd", uid: null }, "inline"],
    ] as const)("%j -> %s", (host, layout) => {
      const choice = chooseKeyLayout(host);
      expect(choice.layout).toBe(layout);
      expect(choice.reason).not.toBe("");
    });

    it("file layout: compose secret, key file 0600, path var in .env", () => {
      const result = plan(base);
      const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
      expect(byPath["github-app.private-key.pem"]?.mode).toBe(0o600);
      expect(byPath["docker-compose.yml"]?.content).toContain("github_app_key");
      expect(byPath[".env"]?.content).toContain(
        "GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/github_app_key",
      );
      expect(byPath[".env"]?.content).not.toMatch(/^GITHUB_APP_PRIVATE_KEY=/m);
    });

    it("inline layout: no secrets block in compose", () => {
      const compose = plan({ ...base, host: { platform: "linux", uid: 5 } }).files.find(
        (f) => f.path === "docker-compose.yml",
      )?.content;
      expect(compose).not.toContain("github_app_key");
      expect(compose).not.toContain("#KEYFILE#");
    });
  });

  it("owner-only mode for every file that holds a secret", () => {
    for (const layout of [base, { ...base, host: { platform: "linux", uid: 7 } } as Answers]) {
      for (const file of plan(layout).files) {
        if (file.secret) expect(file.mode).toBe(0o600);
        expect(file.content.includes(base.adminPassword)).toBe(file.path === ".env");
      }
    }
  });

  it("has no placeholders, no default database password, no published database port", () => {
    for (const host of [base.host, { platform: "linux", uid: 5 }] as const) {
      const files = plan({ ...base, host }).files;
      const all = files.map((f) => f.content).join("\n");
      expect(all).not.toMatch(/replace-with-/i);
      expect(all).not.toMatch(/POSTGRES_PASSWORD:-/);
      expect(all).not.toMatch(/docmyrepos:docmyrepos/);
      const env = files.find((f) => f.path === ".env")?.content ?? "";
      expect(env).not.toMatch(/^POSTGRES_PASSWORD='?docmyrepos'?$/m);
      const compose = files.find((f) => f.path === "docker-compose.yml")?.content ?? "";
      expect(compose).not.toMatch(/5432:5432/);
      expect(compose.match(/^\s+ports:/gm)).toHaveLength(1); // the app only
    }
  });

  it("pins the image tag to the answer, and keeps it as a variable default", () => {
    const compose = plan(base).files.find((f) => f.path === "docker-compose.yml")?.content;
    expect(compose).toContain("ghcr.io/dash-ai-tools/doc-my-repos:${DOCMYREPOS_VERSION:-1.2.0}");
    expect(compose).not.toContain("__VERSION__");
  });

  it("writes a .gitignore for env files, keys and backups", () => {
    const ignore = plan(base).files.find((f) => f.path === ".gitignore")?.content ?? "";
    for (const entry of [".env", "*.pem", "*.bak-*"]) expect(ignore).toContain(entry);
  });

  describe("rejects invalid answers without echoing them", () => {
    const secretish = "S3cr3t-value-that-must-not-leak";
    it.each<[string, Partial<Answers>]>([
      ["password", { adminPassword: "short" }],
      ["email", { adminEmail: "admin@" }],
      ["url", { url: "http://docs.example.com" }],
      ["port", { port: 70000 }],
      ["repo", { repos: ["a/b"] }],
      ["empty repos", { repos: [] }],
      ["tag", { imageTag: "a b" }],
      ["placeholder", { sessionSecret: "replace-with-a-long-random-string" }],
      ["default db password", { postgresPassword: "docmyrepos" }],
      ["db password chars", { postgresPassword: "p@ss/word-that-is-long" }],
      ["quote in secret", { syncSecret: `${secretish}'` }],
      ["bad key", { privateKeyPem: secretish }],
    ])("%s", (_name, patch) => {
      let error: unknown;
      try {
        plan({ ...base, ...patch });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PlanError);
      expect((error as Error).message).not.toContain(secretish);
      expect((error as Error).message).not.toContain("replace-with-a-long");
    });
  });
});
