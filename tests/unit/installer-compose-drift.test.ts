// The installer writes its own compose file (packages/create-docmyrepos/src/compose-template.ts).
// It is derived from the repository's docker-compose.yml; this test fails when the hardening keys
// differ, so a change to the repository file cannot be missing from the installer.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { renderCompose } from "../../packages/create-docmyrepos/src/compose-template";

type Service = Record<string, unknown>;
type Compose = {
  name?: string;
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
};

const root = parse(
  readFileSync(fileURLToPath(new URL("../../docker-compose.yml", import.meta.url)), "utf8"),
) as Compose;

const layouts = [true, false] as const;
const generated = (keyAsFile: boolean) =>
  parse(renderCompose({ tag: "1.2.0", keyAsFile })) as Compose;

const HARDENING = [
  "read_only",
  "tmpfs",
  "cap_drop",
  "security_opt",
  "pids_limit",
  "logging",
  "init",
  "stop_grace_period",
  "restart",
  "healthcheck",
  "ports",
  "depends_on",
] as const;

describe("installer compose template vs docker-compose.yml", () => {
  it.each(layouts)("app hardening keys are equal (key as file: %s)", (keyAsFile) => {
    const app = root.services.app as Service;
    const other = generated(keyAsFile).services.app as Service;
    for (const key of HARDENING) {
      expect(app[key], `app.${key} exists in the repository file`).toBeDefined();
      expect(other[key], `app.${key}`).toEqual(app[key]);
    }
  });

  it("the hardening list covers every hardening key of the repository's app service", () => {
    // Keys that are deliberately different or not hardening; anything else new must be added above.
    const allowedDifferences = new Set(["build", "image", "env_file", "environment", "volumes"]);
    const covered = new Set<string>(HARDENING);
    for (const key of Object.keys(root.services.app as Service)) {
      expect(covered.has(key) || allowedDifferences.has(key), `unreviewed app key: ${key}`).toBe(
        true,
      );
    }
  });

  it("the config file is mounted read-only at the same place", () => {
    const target = (volumes: unknown) =>
      (volumes as string[]).map((v) => v.split(":").slice(-2).join(":"));
    const repoMounts = target((root.services.app as Service).volumes);
    const generatedMounts = target((generated(true).services.app as Service).volumes);
    expect(repoMounts).toEqual(["/app/docmyrepos.config.yml:ro"]);
    expect(generatedMounts).toEqual(repoMounts);
  });

  it("db service is the same apart from the published port and the password default", () => {
    const db = root.services.db as Service;
    const other = generated(true).services.db as Service;
    for (const key of ["image", "restart", "volumes", "healthcheck"]) {
      expect(other[key], `db.${key}`).toEqual(db[key]);
    }
    expect(other.ports).toBeUndefined();
    expect(db.ports).toBeDefined(); // if the repository file stops publishing it, revisit this test
    expect(JSON.stringify(other.environment)).not.toMatch(/POSTGRES_PASSWORD:-/);
  });

  it("top level: same project name and volumes; secrets only in the file layout", () => {
    expect(generated(true).name).toBe(root.name);
    expect(generated(true).volumes).toEqual(root.volumes);
    expect(generated(true).secrets).toEqual({
      github_app_key: { file: "./github-app.private-key.pem" },
    });
    expect(generated(false).secrets).toBeUndefined();
    expect((generated(true).services.app as Service).secrets).toEqual(["github_app_key"]);
    expect((generated(false).services.app as Service).secrets).toBeUndefined();
  });

  it("runs the published image, not a build", () => {
    const app = generated(true).services.app as Service;
    expect(app.build).toBeUndefined();
    expect(app.image).toBe("ghcr.io/dash-ai-tools/doc-my-repos:${DOCMYREPOS_VERSION:-1.2.0}");
  });
});
