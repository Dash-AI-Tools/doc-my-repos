#!/usr/bin/env node
// Pack check (install-wizard task 5.3): lists what `npm publish` would upload for the installer
// package (`npm pack --dry-run --json`) and fails when anything is outside the allowed list.
//
//   node scripts/check-pack.mjs [package folder]     # default packages/create-docmyrepos
//
// Allowed: package.json, README.md, LICENSE, the bin file and the compiled JavaScript under dist/
// (no source maps, tests or test support). Never allowed: environment files, keys, sources.
// The manifest must declare no dependencies of any kind and no install-time scripts.
// The checks are pure functions so tests can run them on made-up lists.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "bin/create-docmyrepos.js",
  "dist/index.js",
  "dist/run.js",
  "dist/cli.js",
];

const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^bin\/create-docmyrepos\.js$/,
  /^dist\/[A-Za-z0-9._-]+\.js$/,
];

const FORBIDDEN = [
  [/\.map$/i, "a source map"],
  [/(^|\/)[^/]*\.test\.[cm]?[jt]sx?$/, "a test"],
  [/(^|\/)test-support[^/]*$/, "test support code"],
  [/(^|\/)\.env(\.|$)/, "an environment file"],
  [/\.(pem|key|p12|pfx|crt)$/i, "a key or certificate"],
  [/\.tsx?$/, "TypeScript source"],
  [/(^|\/)src\//, "a source folder"],
  [/(^|\/)node_modules\//, "a dependency folder"],
];

/** Problems with a list of packed file paths (forward slashes). */
export function checkPackedFiles(paths) {
  const problems = [];
  const set = new Set(paths);
  for (const path of paths) {
    const forbidden = FORBIDDEN.find(([pattern]) => pattern.test(path));
    if (forbidden !== undefined) {
      problems.push(`${path}: ${forbidden[1]} would be published`);
    } else if (!ALLOWED.some((pattern) => pattern.test(path))) {
      problems.push(`${path}: not on the allowed list`);
    }
  }
  for (const required of REQUIRED_FILES) {
    if (!set.has(required)) problems.push(`${required}: missing from the package`);
  }
  return problems;
}

/** Problems with the package manifest. */
export function checkManifest(manifest) {
  const problems = [];
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    const value = manifest[field];
    if (
      value !== undefined &&
      (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0)
    ) {
      problems.push(`package.json declares ${field}; the installer must have no dependencies`);
    }
  }
  for (const script of ["preinstall", "install", "postinstall", "prepare", "prepublish"]) {
    if (manifest.scripts?.[script] !== undefined) {
      problems.push(`package.json has a "${script}" script that would run on the user's machine`);
    }
  }
  if (typeof manifest.engines?.node !== "string") {
    problems.push("package.json does not declare engines.node");
  }
  if (typeof manifest.bin !== "object" || manifest.bin?.["create-docmyrepos"] === undefined) {
    problems.push('package.json has no "create-docmyrepos" bin');
  }
  if (manifest.private === true) problems.push("package.json is marked private");
  return problems;
}

/** Runs `npm pack --dry-run --json` in a folder and returns the packed paths. */
export function packedPaths(folder) {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: folder,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(output);
  const files = parsed?.[0]?.files;
  if (!Array.isArray(files)) throw new Error("npm pack --json did not list files");
  return files.map((file) => String(file.path).replaceAll("\\", "/")).sort();
}

export function checkPackage(folder) {
  const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  return [...checkManifest(manifest), ...checkPackedFiles(packedPaths(folder))];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const folder = resolve(
    process.argv[2] ?? fileURLToPath(new URL("../packages/create-docmyrepos", import.meta.url)),
  );
  let problems;
  try {
    problems = checkPackage(folder);
  } catch (error) {
    console.error(`Could not check the package: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`error: ${problem}`);
    process.exit(1);
  }
  console.log(`Pack check passed for ${folder}.`);
}
