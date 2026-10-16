#!/usr/bin/env node
// Release gate (install-wizard task 5.2): the root package version, the installer package version
// and the git tag must be the same number, because the installer pins the image with its own
// version and the image is published under the tag.
//
//   node scripts/check-release-versions.mjs v1.2.0
//   node scripts/check-release-versions.mjs            # uses GITHUB_REF_NAME
//   node scripts/check-release-versions.mjs v1.2.0 --root <folder>   # for tests
//
// Prints the version and the npm dist-tag to use (`latest`, or `next` for a pre-release) and, in
// GitHub Actions, writes them to $GITHUB_OUTPUT. Exits 1 with every mismatch listed.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const TAG = /^v(.+)$/;

/**
 * Pure check. `tag` is the git tag (`v1.2.0`), the versions are the `version` fields.
 * Returns `{ ok, version, npmTag, errors }`.
 */
export function checkVersions({ tag, rootVersion, packageVersion }) {
  const errors = [];
  let version = null;

  const fromTag = typeof tag === "string" ? TAG.exec(tag) : null;
  if (fromTag === null) {
    errors.push(`The tag "${String(tag)}" must look like v1.2.3 (a "v" and a semantic version).`);
  } else if (!SEMVER.test(fromTag[1])) {
    errors.push(`The tag "${tag}" is not a semantic version (v1.2.3 or v1.2.3-rc.1).`);
  } else {
    version = fromTag[1];
  }

  for (const [label, value] of [
    ["root package.json", rootVersion],
    ["packages/create-docmyrepos/package.json", packageVersion],
  ]) {
    if (typeof value !== "string" || !SEMVER.test(value)) {
      errors.push(`The version in ${label} ("${String(value)}") is not a semantic version.`);
    } else if (version !== null && value !== version) {
      errors.push(`The version in ${label} is ${value} but the tag is ${tag}.`);
    }
  }
  if (
    typeof rootVersion === "string" &&
    typeof packageVersion === "string" &&
    rootVersion !== packageVersion
  ) {
    errors.push(
      `The root version (${rootVersion}) and the installer version (${packageVersion}) differ.`,
    );
  }

  const ok = errors.length === 0;
  const npmTag = ok && version !== null && version.includes("-") ? "next" : "latest";
  return { ok, version: ok ? version : null, npmTag, errors };
}

function readVersion(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return parsed.version;
}

function main(argv, env) {
  const args = [...argv];
  let root = fileURLToPath(new URL("..", import.meta.url));
  const rootFlag = args.indexOf("--root");
  if (rootFlag !== -1) {
    root = args[rootFlag + 1] ?? "";
    args.splice(rootFlag, 2);
  }
  const tag = args[0] ?? env.GITHUB_REF_NAME;

  let result;
  try {
    result = checkVersions({
      tag,
      rootVersion: readVersion(join(root, "package.json")),
      packageVersion: readVersion(join(root, "packages", "create-docmyrepos", "package.json")),
    });
  } catch {
    console.error("Could not read the package.json files.");
    return 1;
  }

  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    return 1;
  }
  console.log(
    `Release ${result.version}: tag, root and installer versions agree (npm tag ${result.npmTag}).`,
  );
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `version=${result.version}\nnpm_tag=${result.npmTag}\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
