import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ENV_VARS, FLAGS, helpText } from "../../packages/create-docmyrepos/src/args";

/**
 * Install wizard task 6.1: every option the documentation shows exists in the installer's `--help`,
 * and every option the installer has is documented. The flag table in `args.ts` is the single
 * source: the parser, the help text and these pages are all compared with it.
 */

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), "utf8");

const HELP = helpText("0.0.0");
const KNOWN_FLAGS = new Set(FLAGS.map((f) => f.name));
const KNOWN_SHORT = new Set(FLAGS.flatMap((f) => (f.short === undefined ? [] : [f.short])));
/** Options of other programs that the install pages legitimately show (docker compose, npm, tar). */
const OTHER_PROGRAMS = new Set(["wait", "wait-timeout", "pack-destination", "build", "filter"]);

/** The README's installer subsection, from its heading to the next `###` heading. */
function readmeInstallerSection(): string {
  const readme = read("README.md");
  const start = readme.indexOf("### With the installer");
  const end = readme.indexOf("\n### ", start + 1);
  expect(start, "README has an installer section").toBeGreaterThan(-1);
  return readme.slice(start, end);
}

/** Text where commands are shown: fenced blocks, inline code and the first column of tables. */
function commandText(markdown: string): string {
  const fenced = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const rest = markdown.replace(/```[\s\S]*?```/g, "");
  const inline = [...rest.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
  return [...fenced, ...inline].join("\n");
}

function longFlags(text: string): string[] {
  return [...text.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1] as string);
}

function shortFlags(text: string): string[] {
  return [...text.matchAll(/(?<![\w-])-([a-zA-Z])(?![\w-])/g)].map((m) => m[1] as string);
}

const DOCS: [string, () => string][] = [
  ["README.md installer section", readmeInstallerSection],
  ["docs/guides/install-wizard.md", () => read("docs/guides/install-wizard.md")],
  ["packages/create-docmyrepos/README.md", () => read("packages/create-docmyrepos/README.md")],
];

describe.each(DOCS)("%s", (_name, load) => {
  const code = () => commandText(load());

  it("shows only options the installer has", () => {
    const shown = longFlags(code());
    expect(shown.length).toBeGreaterThan(0);
    for (const flag of shown) {
      expect(KNOWN_FLAGS.has(flag) || OTHER_PROGRAMS.has(flag), `--${flag}`).toBe(true);
    }
  });

  it("shows only short options the installer has", () => {
    // -d (docker compose up -d), -x, -z, -f (tar) belong to other programs.
    for (const flag of shortFlags(code())) {
      if ("dxzfCc".includes(flag)) continue;
      expect(KNOWN_SHORT.has(flag), `-${flag}`).toBe(true);
    }
  });

  it("names only environment variables the installer reads", () => {
    const known = new Set(ENV_VARS.map((e) => e.name));
    for (const name of code().match(/\bDOCMYREPOS_[A-Z_]+\b/g) ?? []) {
      // DOCMYREPOS_VERSION is the compose file's own variable, DOCMYREPOS_CONFIG the repository's.
      if (name === "DOCMYREPOS_VERSION" || name === "DOCMYREPOS_CONFIG") continue;
      expect(known.has(name), name).toBe(true);
    }
  });
});

describe("every installer option is documented and in --help", () => {
  const guide = read("docs/guides/install-wizard.md");
  const packageReadme = read("packages/create-docmyrepos/README.md");

  it.each(FLAGS.map((f) => [f.name, f] as const))("--%s", (name, flag) => {
    expect(HELP, "--help").toContain(`--${name}`);
    expect(guide, "the install wizard guide").toContain(`\`--${name}`);
    expect(packageReadme, "the package README").toContain(`--${name}`);
    if (flag.short !== undefined) expect(HELP).toContain(`-${flag.short},`);
  });

  it.each(ENV_VARS.map((e) => [e.name] as const))("%s", (name) => {
    expect(HELP, "--help").toContain(name);
    expect(guide, "the install wizard guide").toContain(name);
  });

  it("the README names the command, the dry run, the non-interactive mode and how to read the source", () => {
    const section = readmeInstallerSection();
    for (const needle of [
      "npx create-docmyrepos",
      "--dry-run",
      "--yes",
      "npm view create-docmyrepos",
      "npm pack create-docmyrepos",
    ]) {
      expect(section, needle).toContain(needle);
    }
  });

  it("the README keeps the clone-and-compose and the development paths", () => {
    const readme = read("README.md");
    expect(readme).toContain("### With Docker Compose, from a checkout");
    expect(readme).toContain("docker compose up -d --build --wait");
    expect(readme).toContain("### On your machine (development)");
  });
});
