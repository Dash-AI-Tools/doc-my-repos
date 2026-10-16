import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * Static checks of the open-source project files (task 13.4): they exist, the README shows every
 * screenshot in both themes, every relative link in the Markdown files resolves, and the issue
 * templates parse. No network.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const path = (name: string) => resolve(ROOT, name);
const read = (name: string) => readFileSync(path(name), "utf8");

describe("project files", () => {
  it.each([
    "LICENSE",
    "README.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    ".env.example",
    ".editorconfig",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    "docs/github-app-setup.md",
  ])("%s exists and is not empty", (file) => {
    expect(existsSync(path(file)), file).toBe(true);
    expect(statSync(path(file)).size, file).toBeGreaterThan(100);
  });

  it("the license is MIT and package.json agrees", () => {
    expect(read("LICENSE")).toMatch(/^MIT License/);
    expect((JSON.parse(read("package.json")) as { license: string }).license).toBe("MIT");
    expect(read("README.md")).toMatch(/\[MIT License\]\(LICENSE\)/);
  });

  it("the README is not stale", () => {
    expect(read("README.md")).not.toMatch(/Status: planning|No application code exists yet/i);
  });

  it("the example environment file holds no real secret", () => {
    const env = read(".env.example");
    expect(env).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----\\?n?[A-Za-z0-9+/]{20,}/);
    expect(env).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
  });

  it("the contributing guide covers the documented workflow", () => {
    const text = read("CONTRIBUTING.md");
    for (const needle of [
      "pnpm db:up",
      "pnpm db:migrate",
      "pnpm test",
      "pnpm test:e2e",
      "openspec validate",
      "visibility filter",
      "CODE_OF_CONDUCT.md",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });
});

/**
 * Spec "New contributor": a contributor who reads the README and the contributing guide can
 * install, start the database, migrate and run the tests with the documented commands. A real
 * fresh clone is the manual check of task 13.4; what is checked here is that every `pnpm`
 * command the two documents show is something that exists, so a renamed script cannot leave
 * the documentation behind.
 */
describe("documented commands", () => {
  const scripts = new Set(
    Object.keys((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts),
  );
  const builtIn = new Set(["install", "exec", "add", "dlx", "update", "remove", "run"]);

  /** The code spans and fenced blocks of a Markdown file: that is where commands are shown. */
  function codeOf(text: string): string {
    const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
    const inline = [...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map(
      (m) => m[1] ?? "",
    );
    return [...fenced, ...inline].join("\n");
  }

  function pnpmCommands(text: string): string[] {
    const found: string[] = [];
    for (const m of codeOf(text).matchAll(/\bpnpm\s+(?:run\s+)?([a-z][a-z0-9:-]*)/g)) {
      found.push(m[1] ?? "");
    }
    return found;
  }

  it.each(["README.md", "CONTRIBUTING.md"])("%s shows only pnpm commands that exist", (file) => {
    const commands = pnpmCommands(read(file));
    expect(commands.length, file).toBeGreaterThan(3);
    for (const command of commands) {
      expect(scripts.has(command) || builtIn.has(command), `${file}: pnpm ${command}`).toBe(true);
    }
  });

  it("the contributing guide's set-up path is install, database, migrations, tests", () => {
    const commands = pnpmCommands(read("CONTRIBUTING.md"));
    for (const command of ["install", "db:up", "db:migrate", "test", "test:e2e", "dev"]) {
      expect(commands, command).toContain(command);
    }
    for (const script of ["db:up", "db:migrate", "test", "test:e2e", "dev", "typecheck", "lint"]) {
      expect(scripts.has(script), script).toBe(true);
    }
  });
});

describe("README screenshots", () => {
  const readme = read("README.md");
  const sources = [...readme.matchAll(/(?:src|srcset)="(docs-assets\/screenshots\/[^"]+)"/g)].map(
    (m) => m[1] as string,
  );
  const names = new Set(sources.map((s) => s.replace(/-(light|dark)\.png$/, "")));

  it("shows at least the home page, a document and search, each in light and dark", () => {
    for (const name of ["home", "doc", "search"]) {
      expect(names.has(`docs-assets/screenshots/${name}`), name).toBe(true);
    }
    for (const name of names) {
      expect(sources, name).toContain(`${name}-light.png`);
      expect(sources, name).toContain(`${name}-dark.png`);
    }
  });

  it("uses a prefers-color-scheme picture for every image", () => {
    // Screenshots only: the logo in the header is a branding picture with its own light and white files.
    const pictures = (readme.match(/<picture>[\s\S]*?<\/picture>/g) ?? []).filter((p) =>
      p.includes("docs-assets/screenshots/"),
    );
    expect(pictures.length).toBeGreaterThanOrEqual(names.size);
    for (const picture of pictures) {
      expect(picture).toMatch(
        /<source media="\(prefers-color-scheme: dark\)" srcset="[^"]+-dark\.png"/,
      );
      expect(picture).toMatch(/<img alt="[^"]+" src="[^"]+-light\.png"/);
    }
  });

  it("every image exists, is a 1280 pixel wide PNG, and the total stays small", () => {
    let total = 0;
    for (const source of sources) {
      expect(existsSync(path(source)), source).toBe(true);
      const bytes = readFileSync(path(source));
      expect(bytes.subarray(1, 4).toString("ascii"), source).toBe("PNG");
      expect(bytes.readUInt32BE(16), `${source} width`).toBe(1280);
      total += bytes.length;
    }
    for (const file of readdirSync(path("docs-assets/screenshots"))) {
      expect(sources, file).toContain(`docs-assets/screenshots/${file}`);
    }
    expect(total).toBeLessThan(3 * 1024 * 1024);
  });
});

describe("Markdown links", () => {
  const files = [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
  ];

  /** GitHub's anchor for a heading: lowercase, punctuation dropped, spaces to hyphens. */
  const slug = (heading: string) =>
    heading
      .trim()
      .toLowerCase()
      .replace(/`/g, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
  const anchors = (text: string) =>
    new Set(
      [...text.replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
        slug(m[1] as string),
      ),
    );

  it.each(files)("%s: relative links and anchors resolve", (file) => {
    const text = read(file);
    const links = [...text.replace(/```[\s\S]*?```/g, "").matchAll(/\]\(([^)\s]+)\)/g)].map(
      (m) => m[1] as string,
    );
    for (const link of links) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
      const [target = "", hash] = link.split("#");
      const targetFile = target === "" ? path(file) : resolve(dirname(path(file)), target);
      expect(existsSync(targetFile), `${file} -> ${link}`).toBe(true);
      if (hash && targetFile.endsWith(".md")) {
        expect(anchors(readFileSync(targetFile, "utf8")).has(hash), `${file} -> ${link}`).toBe(
          true,
        );
      }
    }
  });
});

describe("issue templates", () => {
  it("parse, and blank issues are off with a link for security reports", () => {
    const config = parse(read(".github/ISSUE_TEMPLATE/config.yml")) as {
      blank_issues_enabled: boolean;
      contact_links: { url: string }[];
    };
    expect(config.blank_issues_enabled).toBe(false);
    expect(config.contact_links.some((l) => l.url.endsWith("/security/advisories/new"))).toBe(true);
    for (const file of ["bug_report.yml", "feature_request.yml"]) {
      const form = parse(read(`.github/ISSUE_TEMPLATE/${file}`)) as {
        name: string;
        body: { type: string }[];
      };
      expect(form.name, file).toBeTruthy();
      expect(
        form.body.some((b) => b.type === "textarea"),
        file,
      ).toBe(true);
    }
  });

  it("the pull request template asks for spec, tests, validate, docs and both themes", () => {
    const text = read(".github/PULL_REQUEST_TEMPLATE.md");
    for (const needle of [
      "spec",
      "Tests",
      "openspec validate",
      "Documentation",
      "light and dark",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });
});
