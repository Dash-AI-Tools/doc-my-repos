import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * Static checks of .github/workflows/release.yml (container-image-release spec): when it runs,
 * where it may publish, with which permissions, and in which order. The real run happens on the
 * first version tag. The repository-wide rules (pinned actions, timeouts, no other secret, no
 * persisted checkout credentials) are in ci-hygiene.test.ts and cover this file too.
 */

const root = (name: string) => fileURLToPath(new URL(`../../${name}`, import.meta.url));
const text = readFileSync(root(".github/workflows/release.yml"), "utf8");
// The workflow without its comment lines, for checks that must not trip on prose.
const body = text
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

interface Step {
  uses?: string;
  run?: string;
  name?: string;
  id?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Job {
  if?: string;
  needs?: string | string[];
  uses?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}
const doc = parse(text) as {
  on: { push?: { tags?: string[]; branches?: string[] } } & Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const image = doc.jobs.image as Job;
const packages = doc.jobs.packages as Job;
const steps = image.steps ?? [];
const indexOf = (predicate: (s: Step) => boolean) => steps.findIndex(predicate);

const GUARD = "github.repository == 'Dash-AI-Tools/doc-my-repos'";
const needs = (job: Job) => (Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []);

describe("release workflow trigger and scope", () => {
  it("runs only for version tags", () => {
    expect(Object.keys(doc.on)).toEqual(["push"]);
    expect(doc.on.push?.tags).toEqual(["v*.*.*"]);
    expect(doc.on.push?.branches).toBeUndefined();
  });

  it("publishes only from the project's own repository, never from a fork", () => {
    expect(doc.jobs.versions?.if).toBe(GUARD);
    expect(image.if).toBe(GUARD);
    expect(packages.if).toBe(GUARD);
    expect(needs(doc.jobs.ci as Job)).toContain("versions");
  });

  it("serializes releases and never cancels one in progress", () => {
    const concurrency = (doc as unknown as { concurrency: Record<string, unknown> }).concurrency;
    expect(concurrency["cancel-in-progress"]).toBe(false);
  });
});

describe("release workflow permissions", () => {
  it("is read-only by default; only the image job writes packages, only the npm job mints an OIDC token", () => {
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(image.permissions).toEqual({ contents: "read", packages: "write" });
    expect(packages.permissions).toEqual({ contents: "read", "id-token": "write" });
    for (const [name, job] of Object.entries(doc.jobs)) {
      if (name !== "image" && name !== "packages") expect(job.permissions, name).toBeUndefined();
    }
  });

  it("uses no long-lived credential: npm trusted publishing, no secret but the workflow token", () => {
    expect(body).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
    const secrets = [...body.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(new Set(secrets)).toEqual(new Set(["GITHUB_TOKEN"]));
  });

  it("never puts the tag name into a shell script directly", () => {
    for (const step of Object.values(doc.jobs).flatMap((j) => j.steps ?? [])) {
      expect(step.run ?? "", step.name).not.toMatch(/\$\{\{\s*github\.(ref_name|head_ref)/);
    }
  });
});

describe("release workflow order", () => {
  it("checks versions, runs the CI set on the same commit, then publishes", () => {
    expect((doc.jobs.ci as Job).uses).toBe("./.github/workflows/ci.yml");
    expect(needs(image)).toEqual(expect.arrayContaining(["versions", "ci"]));
    const versionStep = (doc.jobs.versions?.steps ?? []).find((s) =>
      s.run?.includes("check-release-versions"),
    );
    expect(versionStep?.run).toBe('scripts/check-release-versions.sh "$TAG"');
  });

  it("is gated by the release environment", () => {
    expect(image.environment).toBe("release");
  });

  it("logs in with the workflow token, then refuses an existing version, then builds", () => {
    const login = indexOf((s) => s.uses?.startsWith("docker/login-action@") ?? false);
    const guard = indexOf((s) => s.name === "Refuse to overwrite a published version");
    const build = indexOf((s) => s.uses?.startsWith("docker/build-push-action@") ?? false);
    expect(login).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(login);
    expect(build).toBeGreaterThan(guard);
    expect(steps[login]?.with?.registry).toBe("ghcr.io");
    expect(steps[login]?.with?.password).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(steps[guard]?.run).toContain("imagetools inspect");
    expect(steps[guard]?.run).toContain("exit 1");
  });
});

describe("release workflow packages", () => {
  const run = (packages.steps ?? []).map((step) => step.run ?? "");

  it("publishes after the versions check and CI, gated by the release environment", () => {
    expect(needs(packages)).toEqual(expect.arrayContaining(["versions", "ci"]));
    expect(packages.environment).toBe("release");
  });

  it("refuses a version npm already has, then builds and publishes with provenance", () => {
    const guard = run.findIndex((r) => r.includes("npm view"));
    const build = run.findIndex((r) => r.includes("pnpm build:packages"));
    const publish = run.findIndex((r) => r.includes("pnpm -r publish"));
    expect(guard).toBeGreaterThan(-1);
    expect(run[guard]).toContain("exit 1");
    expect(build).toBeGreaterThan(guard);
    expect(publish).toBeGreaterThan(build);
    expect(run[publish]).toContain("--provenance");
    expect(run[publish]).toContain("--access public");
  });
});

describe("release workflow image", () => {
  const build = steps.find((s) => s.uses?.startsWith("docker/build-push-action@"));

  it("builds for amd64 and arm64 and pushes the version and latest to GHCR", () => {
    expect(build?.with?.platforms).toBe("linux/amd64,linux/arm64");
    expect(String(build?.with?.push)).toBe("true");
    expect(build?.with?.tags).toContain("${{ env.IMAGE }}:${{ steps.version.outputs.number }}");
    expect(build?.with?.tags).toContain("${{ env.IMAGE }}:latest");
    expect(text).toContain("IMAGE: ghcr.io/dash-ai-tools/doc-my-repos");
  });

  it("attaches provenance and an SBOM and sets the labels' build arguments from the tag", () => {
    expect(build?.with?.provenance).toBe("mode=max");
    expect(String(build?.with?.sbom)).toBe("true");
    expect(build?.with?.["build-args"]).toContain("VERSION=${{ steps.version.outputs.number }}");
    expect(build?.with?.["build-args"]).toContain("REVISION=${{ github.sha }}");
  });

  it("is built from the Dockerfile that declares the labels it fills", () => {
    const dockerfile = readFileSync(root("Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^ARG VERSION=/m);
    expect(dockerfile).toMatch(/^ARG REVISION=/m);
    for (const label of ["source", "version", "revision", "licenses"]) {
      expect(dockerfile).toContain(`org.opencontainers.image.${label}=`);
    }
  });
});
