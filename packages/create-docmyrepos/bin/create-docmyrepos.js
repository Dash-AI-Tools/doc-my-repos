#!/usr/bin/env node
// Plain JavaScript on purpose: this file must run on any Node version so that an old one gets a
// clear message. Nothing is imported before the version check, and nothing is written.
const major = Number(process.versions.node.split(".")[0]);
if (!(major >= 20)) {
  process.stderr.write(
    `create-docmyrepos needs Node.js 20 or newer; this is ${process.versions.node}. Nothing was changed.\n`,
  );
  process.exit(1);
}

await import("../dist/index.js");
