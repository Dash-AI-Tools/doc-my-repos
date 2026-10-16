#!/usr/bin/env node
// Runs the installer's fake GitHub server on a loopback port for scripts/installer-e2e.sh.
//
//   FAKE_GITHUB_PUBLIC_KEY_FILE=<public key PEM> FAKE_GITHUB_URL_FILE=<file to write the URL to> \
//     node scripts/installer-e2e-fake-github.mjs
//
// The server lives in packages/create-docmyrepos/src/test-support-github.ts, which is excluded from
// the build and from the published package, so this script loads that TypeScript file directly
// (Node 22.18 or newer strips the types). It answers as an organization `acme` with one
// installation (777) and a few repositories, and checks the App JWT against the given public key.
// It stops on SIGINT or SIGTERM.
import { readFileSync, writeFileSync } from "node:fs";

const publicKeyFile = process.env.FAKE_GITHUB_PUBLIC_KEY_FILE;
const urlFile = process.env.FAKE_GITHUB_URL_FILE;
if (!publicKeyFile || !urlFile) {
  console.error("FAKE_GITHUB_PUBLIC_KEY_FILE and FAKE_GITHUB_URL_FILE are required.");
  process.exit(2);
}

const { startFakeGithub } = await import(
  new URL("../packages/create-docmyrepos/src/test-support-github.ts", import.meta.url).href
);

const fake = await startFakeGithub({
  appId: 12345,
  publicKeyPem: readFileSync(publicKeyFile, "utf8"),
  installations: [{ id: 777, login: "acme" }],
  repositories: ["handbook", "api", "web"],
});
writeFileSync(urlFile, `${fake.url}\n`);
console.log(`fake GitHub listening on ${fake.url}`);

const stop = () => {
  void fake.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
