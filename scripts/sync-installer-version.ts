// After `changeset version` bumps the packages (they share one version, `fixed`), gives the app's
// root package.json and install.sh's DOCMYREPOS_VERSION the same version, so the installer of a
// release installs the image of that release. `scripts/check-release-versions.sh` checks it.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const version = (JSON.parse(read("packages/core/package.json")) as { version: string }).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(
    `packages/core/package.json has no MAJOR.MINOR.PATCH version (found "${version}")`,
  );
}

const root = read("package.json").replace(
  /^ {2}"version": "[^"]*",$/m,
  `  "version": "${version}",`,
);
writeFileSync(join(ROOT, "package.json"), root);
const installer = read("install.sh").replace(
  /^DOCMYREPOS_VERSION="[^"]*"$/m,
  `DOCMYREPOS_VERSION="${version}"`,
);
writeFileSync(join(ROOT, "install.sh"), installer);
console.log(`sync-installer-version: package.json and install.sh are at ${version}`);
