import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * Static checks of the release workflow and the installer jobs (install-wizard tasks 5.1 to 5.3).
 * A real release needs a tag, the `release` environment and registry credentials, so this cannot
 * run it; it catches the mistakes that would only show on release day: a trigger other than a
 * version tag, a job that can run in a fork, a publishing job outside the gated environment,
 * labels that differ from the local build script, or an installer test that dropped a key layout.
 * Syntax is checked separately with actionlint (see CONTRIBUTING.md).
 */

const root = (name: string) => fileURLToPath(new URL(`../../${name}`, import.meta.url));
const read = (name: string) => readFileSync(root(name), "utf8");

interface Step {
  uses?: string;
  run?: string;
  name?: string;
  id?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
}
interface Job {
  if?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
  outputs?: Record<string, string>;
}
interface Workflow {
  on?: { push?: { tags?: string[]; branches?: string[] }; [key: string]: unknown };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const SLUG = "Dash-AI-Tools/doc-my-repos";
const release = parse(read(".github/workflows/release.yml")) as Workflow;
const releaseText = read(".github/workflows/release.yml");
const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
const jobs = release.jobs;
const runs = (job: Job) => (job.steps ?? []).map((s) => s.run ?? "").join("\n");
const stepUsing = (job: Job, prefix: string) =>
  (job.steps ?? []).find((s) => s.uses?.startsWith(prefix));

describe("release.yml", () => {
  it("starts on version tags only", () => {
    expect(Object.keys(release.on ?? {})).toEqual(["push"]);
    expect(release.on?.push?.tags).toEqual(["v*.*.*"]);
    expect(release.on?.push?.branches).toBeUndefined();
  });

  it("has the verify, image and npm jobs, and publishes in that order", () => {
    expect(Object.keys(jobs)).toEqual(["verify", "image", "npm"]);
    expect(jobs.image?.needs).toBe("verify");
    expect(jobs.npm?.needs).toEqual(["verify", "image"]);
  });

  it("keeps every job inside the main repository, so a fork publishes nothing", () => {
    for (const [name, job] of Object.entries(jobs)) {
      expect(job.if, name).toBe(`github.repository == '${SLUG}'`);
    }
  });

  it("sends the two publishing jobs through the release environment with the least permissions", () => {
    expect(release.permissions).toEqual({ contents: "read" });
    expect(jobs.verify?.permissions).toBeUndefined();
    expect(jobs.verify?.environment).toBeUndefined();
    expect(jobs.image?.environment).toBe("release");
    expect(jobs.npm?.environment).toBe("release");
    expect(jobs.image?.permissions).toEqual({
      contents: "read",
      packages: "write",
      "id-token": "write",
      attestations: "write",
    });
    expect(jobs.npm?.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  it("uses no secret but GITHUB_TOKEN (npm trusted publishing needs none)", () => {
    const names = [...releaseText.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(names.every((n) => n === "GITHUB_TOKEN")).toBe(true);
    expect(releaseText).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/);
  });

  it("verifies the versions, runs the full test set and the installer test on the image built in the run", () => {
    const verify = jobs.verify as Job;
    const text = runs(verify);
    expect(text).toContain('node scripts/check-release-versions.mjs "$GITHUB_REF_NAME"');
    for (const command of [
      "pnpm lint",
      "pnpm format:check",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
      "pnpm test:e2e",
      "node scripts/check-pack.mjs",
      "scripts/installer-e2e.sh",
    ]) {
      expect(text, command).toContain(command);
    }
    const build = stepUsing(verify, "docker/build-push-action@");
    expect(build?.with?.load).toBe(true);
    expect(build?.with?.push).toBe(false);
    const e2e = (verify.steps ?? []).find((s) => s.run === "scripts/installer-e2e.sh") as
      (Step & { env?: Record<string, string> }) | undefined;
    expect(e2e?.env?.IMAGE).toBe(String(build?.with?.tags));
    expect(verify.outputs?.version).toContain("steps.versions.outputs.version");
  });

  it("pushes both architectures with provenance and an SBOM, and refuses an existing version", () => {
    const image = jobs.image as Job;
    const build = stepUsing(image, "docker/build-push-action@");
    expect(build?.with?.platforms).toBe("linux/amd64,linux/arm64");
    expect(build?.with?.push).toBe(true);
    expect(build?.with?.provenance).toBe("mode=max");
    expect(build?.with?.sbom).toBe(true);
    expect(String(build?.with?.tags)).toContain("env.VERSION");
    // No build cache: a published image is built from scratch.
    expect(build?.with?.["cache-from"]).toBeUndefined();
    expect(build?.with?.["cache-to"]).toBeUndefined();
    expect(stepUsing(image, "docker/setup-qemu-action@")).toBeDefined();
    expect(stepUsing(image, "actions/attest-build-provenance@")?.with?.["push-to-registry"]).toBe(
      true,
    );

    const steps = image.steps ?? [];
    const guard = steps.findIndex((s) => s.name === "Refuse to replace an existing version");
    const push = steps.findIndex((s) => s === build);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(push);
    expect(steps[guard]?.run).toContain("imagetools inspect");
    expect(steps[guard]?.run).toContain("exit 1");
    // Latest is not moved by this workflow: a tag is only ever the exact version.
    expect(String(build?.with?.tags)).not.toContain("latest");
  });

  it("publishes the package with provenance only after the checks", () => {
    const npm = jobs.npm as Job;
    const steps = npm.steps ?? [];
    const names = steps.map((s) => s.run ?? "");
    const publish = steps.findIndex((s) => (s.run ?? "").startsWith("npm publish"));
    expect(publish).toBe(steps.length - 1);
    expect(steps[publish]?.run).toContain("--provenance");
    expect(steps[publish]?.run).toContain("--access public");
    expect(steps[publish]?.["working-directory"]).toBe("packages/create-docmyrepos");
    const before = names.slice(0, publish).join("\n");
    expect(before).toContain("scripts/check-release-versions.mjs");
    expect(before).toContain("pnpm --filter create-docmyrepos build");
    expect(before).toContain("scripts/check-pack.mjs");
  });

  it("gives the image the same four labels as the local build script, and the Dockerfile's source", () => {
    const script = read("scripts/docker-build-labeled.sh");
    const dockerfile = read("Dockerfile");
    const build = stepUsing(jobs.image as Job, "docker/build-push-action@");
    const labels = String(build?.with?.labels)
      .trim()
      .split("\n")
      .map((line) => line.split("=")[0]);
    const keys = [
      "org.opencontainers.image.source",
      "org.opencontainers.image.version",
      "org.opencontainers.image.revision",
      "org.opencontainers.image.licenses",
    ];
    expect(labels).toEqual(keys);
    for (const key of keys) expect(script, key).toContain(`--label "${key}=`);
    expect(script).toContain(`SOURCE="https://github.com/${SLUG}"`);
    expect(dockerfile).toContain(`org.opencontainers.image.source="https://github.com/${SLUG}"`);
    expect(String(build?.with?.labels)).toContain("licenses=MIT");
    expect(script).toContain('LICENSES="MIT"');
  });
});

describe("installer end-to-end test", () => {
  it("runs in ci.yml on every pull request: pack check, image build, then the script", () => {
    const installer = ci.jobs.installer as Job;
    expect(installer).toBeDefined();
    const text = runs(installer);
    expect(text).toContain("pnpm --filter create-docmyrepos build");
    expect(text).toContain("node scripts/check-pack.mjs");
    expect(text).toContain("scripts/installer-e2e.sh");
    const build = stepUsing(installer, "docker/build-push-action@");
    expect(build?.with?.load).toBe(true);
    expect(build?.with?.push).toBe(false);
    expect(build?.with?.tags).toBe("docmyrepos:ci");
    expect(installer.permissions).toBeUndefined();
  });

  it("the script covers both key layouts, the fake GitHub, sign-in, health and the sync", () => {
    const script = read("scripts/installer-e2e.sh");
    expect(script).toContain('LAYOUTS="${E2E_LAYOUTS:-inline file}"');
    for (const needle of [
      "DOCMYREPOS_GITHUB_API_URL",
      "installer-e2e-fake-github.mjs",
      "/api/health",
      "/api/auth/login",
      "/api/sync",
      "--yes",
      "--app existing",
      "GITHUB_APP_PRIVATE_KEY_PATH",
      "api.github.com:127.0.0.1",
    ]) {
      expect(script, needle).toContain(needle);
    }
    // The secrets travel in the environment and in header files, never as installer arguments.
    expect(script).not.toMatch(/--(admin-password|password|webhook-secret|app-key)/);
  });

  it("the helper scripts exist and the shell scripts are executable", () => {
    for (const file of ["scripts/installer-e2e.sh", "scripts/docker-build-labeled.sh"]) {
      expect(statSync(root(file)).mode & 0o111, file).not.toBe(0);
    }
    for (const file of [
      "scripts/installer-e2e-fake-github.mjs",
      "scripts/installer-e2e-host.mjs",
      "scripts/check-pack.mjs",
      "scripts/check-release-versions.mjs",
    ]) {
      expect(statSync(root(file)).size, file).toBeGreaterThan(100);
    }
  });

  it("the fake GitHub server stays out of the build and the package", () => {
    const tsconfig = read("packages/create-docmyrepos/tsconfig.json");
    expect(tsconfig).toContain("src/test-support*.ts");
  });
});
