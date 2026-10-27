import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * Static checks of the CI files (task 13.3), with no network and no Docker. They catch the
 * mistakes that matter without a GitHub run: a trigger that exposes secrets to fork pull requests,
 * a job without a timeout, an unpinned action, or the e2e fixture switch leaking into CI. The real
 * run is verified on a pull request.
 */

const root = (name: string) => fileURLToPath(new URL(`../../${name}`, import.meta.url));
const read = (name: string) => readFileSync(root(name), "utf8");

interface Step {
  uses?: string;
  run?: string;
  name?: string;
}
interface Job {
  uses?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string> | string;
  steps?: Step[];
  services?: Record<string, { image?: string }>;
  env?: Record<string, unknown>;
}
interface Workflow {
  on?: unknown;
  permissions?: Record<string, string> | string;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  env?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const workflowFiles = readdirSync(root(".github/workflows")).filter((f) => /\.ya?ml$/.test(f));
const workflowTexts = workflowFiles.map((f) => ({
  file: f,
  text: read(`.github/workflows/${f}`),
  doc: parse(read(`.github/workflows/${f}`)) as Workflow,
}));
const ci = workflowTexts.find((w) => w.file === "ci.yml");

const actionFiles = [
  ...readdirSync(root(".github/actions"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `.github/actions/${d.name}/action.yml`),
];

/** Every `uses:` value in a parsed document, found by walking it. */
function usesValues(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(usesValues);
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) =>
      key === "uses" && typeof value === "string" ? [value] : usesValues(value),
    );
  }
  return [];
}

describe("workflow files", () => {
  it("exist and parse as YAML objects with jobs", () => {
    expect(workflowTexts.length).toBeGreaterThan(0);
    expect(ci).toBeDefined();
    for (const { file, doc } of workflowTexts) {
      expect(typeof doc, file).toBe("object");
      expect(Object.keys(doc.jobs ?? {}).length, file).toBeGreaterThan(0);
    }
  });

  it("set top-level permissions, read-only", () => {
    for (const { file, doc } of workflowTexts) {
      expect(doc.permissions, `${file}: permissions`).toBeDefined();
      expect(doc.permissions, file).toEqual({ contents: "read" });
    }
  });

  // The only write grants in the repository: the release workflow's image job pushes to GHCR with
  // the workflow token. Nothing else, and nowhere else (tests/unit/release-workflow.test.ts).
  const ALLOWED_WRITES: Record<string, string[]> = {
    "release.yml/image": ["packages"],
    // CodeQL uploads its results as code scanning alerts; it cannot do that without this scope.
    "security.yml/codeql": ["security-events"],
  };

  it("never grant a job write permissions, except the release image push", () => {
    for (const { file, doc } of workflowTexts) {
      for (const [name, job] of Object.entries(doc.jobs)) {
        if (job.permissions === undefined) continue;
        const key = `${file}/${name}`;
        if (typeof job.permissions === "string") {
          expect(/write|write-all/.test(job.permissions), key).toBe(false);
          continue;
        }
        const writes = Object.entries(job.permissions)
          .filter(([, v]) => /write|write-all/.test(v))
          .map(([scope]) => scope);
        expect(writes, key).toEqual(ALLOWED_WRITES[key] ?? []);
      }
    }
  });

  it("never trigger on pull_request_target or workflow_run (they run with secrets for fork code)", () => {
    for (const { file, doc } of workflowTexts) {
      const on = doc.on;
      const triggers =
        typeof on === "string"
          ? [on]
          : Array.isArray(on)
            ? on.map(String)
            : Object.keys((on ?? {}) as Record<string, unknown>);
      expect(triggers, file).not.toContain("pull_request_target");
      expect(triggers, file).not.toContain("workflow_run");
    }
  });

  it("reference no secret other than GITHUB_TOKEN", () => {
    for (const { file, text } of workflowTexts) {
      const names = [...text.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      expect(
        names.filter((n) => n !== "GITHUB_TOKEN"),
        file,
      ).toEqual([]);
      expect(text, file).not.toMatch(/secrets\s*:\s*inherit/);
    }
  });

  it("give every job a timeout", () => {
    for (const { file, doc } of workflowTexts) {
      for (const [name, job] of Object.entries(doc.jobs)) {
        // A job that calls a reusable workflow cannot set a timeout; the called jobs have theirs.
        if (job.uses) continue;
        expect(job["timeout-minutes"], `${file}/${name}`).toBeTypeOf("number");
        expect(job["timeout-minutes"], `${file}/${name}`).toBeLessThanOrEqual(60);
      }
    }
  });

  it("never set E2E_FIXTURES (the e2e stack sets it for its own server only)", () => {
    for (const { file, text } of workflowTexts) expect(text, file).not.toMatch(/E2E_FIXTURES/);
    for (const f of actionFiles) expect(read(f), f).not.toMatch(/E2E_FIXTURES/);
    // The playwright fixtures server takes the environment the stack defines, and there the flag
    // is set for `fixtures` alone (`e2e/support/stack.ts`), so no other server ever serves the
    // fixture pages.
    expect(read("playwright.config.ts")).toMatch(/env: serverEnv\("fixtures"\)/);
    const stack = read("e2e/support/stack.ts");
    expect(stack.match(/E2E_FIXTURES/g)).toHaveLength(1);
    expect(stack).toMatch(/name === "fixtures"/);
  });

  it("pin every third-party action to a full commit SHA", () => {
    const uses = [
      ...workflowTexts.flatMap((w) => usesValues(w.doc)),
      ...actionFiles.flatMap((f) => usesValues(parse(read(f)))),
    ];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      if (u.startsWith("./")) {
        // A local composite action (a folder) or a local reusable workflow (a file).
        expect(
          existsSync(root(`${u.slice(2)}/action.yml`)) || existsSync(root(u.slice(2))),
          u,
        ).toBe(true);
        continue;
      }
      expect(u, "unpinned action").toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it("checkout does not persist credentials", () => {
    for (const { file, doc } of workflowTexts) {
      for (const [name, job] of Object.entries(doc.jobs)) {
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith("actions/checkout@")) {
            expect(
              (step as { with?: Record<string, unknown> }).with?.["persist-credentials"],
              `${file}/${name}`,
            ).toBe(false);
          }
        }
      }
    }
  });
});

describe("ci.yml", () => {
  const doc = (ci as NonNullable<typeof ci>).doc;
  const text = (ci as NonNullable<typeof ci>).text;
  const jobs = doc.jobs;
  const allRuns = (job: Job) => (job.steps ?? []).map((s) => s.run ?? "").join("\n");

  it("runs on pull requests and on pushes to main", () => {
    const on = doc.on as { pull_request?: unknown; push?: { branches?: string[] } };
    expect(on).toHaveProperty("pull_request");
    expect(on.push?.branches).toEqual(["main"]);
  });

  it("cancels superseded runs of the same pull request or branch", () => {
    expect(doc.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(doc.concurrency?.group).toContain("github.event.pull_request.number");
  });

  it("has the jobs the deployment-and-oss spec asks for", () => {
    expect(Object.keys(jobs)).toEqual(
      expect.arrayContaining(["lint-typecheck", "unit", "build", "e2e", "docker", "openspec"]),
    );
  });

  it("lints, checks formatting and types", () => {
    const runs = allRuns(jobs["lint-typecheck"] as Job);
    for (const cmd of ["pnpm lint", "pnpm format:check", "pnpm typecheck"]) {
      expect(runs).toContain(cmd);
    }
  });

  it("installs from the frozen lockfile through the shared setup action", () => {
    const setup = read(".github/actions/setup/action.yml");
    expect(setup).toContain("pnpm install --frozen-lockfile");
    expect(setup).toMatch(/node-version: 24/);
    expect(setup).toMatch(/version: 11\.25\.0/);
    expect(read("Dockerfile")).toMatch(/ARG PNPM_VERSION=11\.25\.0/);
    for (const [name, job] of Object.entries(jobs)) {
      // These need no Node or pnpm: Docker builds its own, OpenSpec uses npx, ShellCheck is installed.
      if (name === "docker" || name === "openspec" || name === "shellcheck") continue;
      expect(usesValues(job), name).toContain("./.github/actions/setup");
    }
  });

  it("runs the unit tests and the e2e tests against a Postgres 17 service with a health check", () => {
    for (const name of ["unit", "e2e", "docker"]) {
      const job = jobs[name] as Job;
      expect(job.services?.postgres?.image, name).toBe("postgres:17");
      expect(JSON.stringify(job.services), name).toContain("--health-cmd");
    }
    expect(allRuns(jobs.unit as Job)).toContain("pnpm test");
    expect(jobs.unit?.env?.DATABASE_URL).toBeTypeOf("string");
    expect(jobs.unit?.env?.TEST_DATABASE_URL).toBeTypeOf("string");
    expect(jobs.e2e?.env?.DATABASE_URL_E2E).toBeTypeOf("string");
  });

  it("builds the app and the migration bundle", () => {
    const runs = allRuns(jobs.build as Job);
    expect(runs).toContain("pnpm build");
    expect(runs).toContain("pnpm build:migrate");
  });

  it("installs Chromium, runs Playwright and uploads the report only on failure", () => {
    const job = jobs.e2e as Job;
    const runs = allRuns(job);
    expect(runs).toContain("pnpm exec playwright install --with-deps chromium");
    expect(runs).toContain("pnpm test:e2e");
    const upload = (job.steps ?? []).find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(upload).toBeDefined();
    expect((upload as Step & { if?: string }).if).toBe("failure()");
    const paths = String((upload as Step & { with?: { path?: string } }).with?.path);
    expect(paths).toContain("playwright-report/");
    expect(paths).toContain("test-results/");
  });

  it("builds the Docker image for amd64 without pushing it, then smoke tests it", () => {
    const job = jobs.docker as Job;
    const build = (job.steps ?? []).find((s) => s.uses?.startsWith("docker/build-push-action@")) as
      (Step & { with?: Record<string, unknown> }) | undefined;
    expect(build?.with?.push).toBe(false);
    expect(build?.with?.platforms).toBe("linux/amd64");
    expect(build?.with?.["cache-from"]).toBeDefined();
    expect(allRuns(job)).toContain("scripts/docker-smoke.sh");
    expect(text).not.toMatch(/docker\/login-action/);
    expect(existsSync(root("scripts/docker-smoke.sh"))).toBe(true);
  });

  it("installs with install.sh against the image it built, then checks the result", () => {
    const docker = jobs.docker as Job;
    const steps = docker.steps ?? [];
    const install = steps.find((s) => s.run?.includes("scripts/install-e2e.sh"));
    expect(install, "install step").toBeDefined();
    expect((install as { env?: Record<string, string> }).env?.DOCMYREPOS_IMAGE).toBe(
      "docmyrepos:ci",
    );
    const smoke = steps.findIndex((s) => s.run?.includes("scripts/docker-smoke.sh"));
    expect(steps.indexOf(install as Step)).toBeGreaterThan(smoke);
  });

  it("runs ShellCheck on the installer and the scripts it ships with", () => {
    const runs = allRuns(jobs.shellcheck as Job);
    for (const file of [
      "install.sh",
      "scripts/check-release-versions.sh",
      "scripts/install-e2e.sh",
    ]) {
      expect(runs).toContain(file);
    }
    expect(runs).toContain("shellcheck -s sh");
  });

  it("validates every OpenSpec spec and change with a pinned CLI version", () => {
    expect(allRuns(jobs.openspec as Job)).toMatch(
      /@fission-ai\/openspec@\d+\.\d+\.\d+ validate --all/,
    );
  });

  it("contains no real-looking credentials (the fixtures are placeholders)", () => {
    expect(text).not.toMatch(/-----BEGIN/);
    expect(text).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
  });
});

describe(".github/dependabot.yml", () => {
  const dependabot = parse(read(".github/dependabot.yml")) as {
    version: number;
    updates: { "package-ecosystem": string }[];
  };

  it("keeps the actions, npm packages and Docker files current", () => {
    expect(dependabot.version).toBe(2);
    const ecosystems = dependabot.updates.map((u) => u["package-ecosystem"]);
    expect(ecosystems).toEqual(expect.arrayContaining(["github-actions", "npm", "docker"]));
  });
});
