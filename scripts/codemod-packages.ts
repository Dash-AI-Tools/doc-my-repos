/**
 * One-off codemod for the move of `src/` into the workspace packages
 * (openspec change prepare-core-for-open-core-extensibility, tasks 2.1 to 2.3).
 *
 *   pnpm exec tsx scripts/codemod-packages.ts <step> [--dry-run]
 *
 * A step is a list of moves (a folder or a file, old path to new path). The script:
 * 1. resolves every import specifier of every source file against the layout before the move
 *    (`@/` is `src/`; relative specifiers resolve from the importer), and works out the
 *    specifier for the layout after it;
 * 2. moves the files with `git mv`, so history follows them;
 * 3. writes the rewritten sources;
 * 4. rewrites path mentions (`src/server/...`, `@/server/...`) in comments, docs and config.
 *
 * Specifier rules after the move:
 * - same package, or both files outside the packages and the app: a relative path;
 * - both files in the app (`src/`): `@/...`;
 * - the target in another package: `@docmyrepos/<package>/internal/<path in its src>`;
 * - a package never imports the app; that is reported as an error.
 * Imports that do not change their target or importer location are left as written.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

interface Move {
  readonly from: string;
  readonly to: string;
}

const STEPS: Readonly<Record<string, readonly Move[]>> = {
  core: [
    { from: "src/server/config/schema.ts", to: "packages/core/src/config/schema.ts" },
    { from: "src/server/config/schema.test.ts", to: "packages/core/src/config/schema.test.ts" },
    // Checks the guidelines against the server's validator, so it is a server test.
    {
      from: "src/lib/okf-authoring/guidelines.test.ts",
      to: "src/server/docs/okf-guidelines.test.ts",
    },
    {
      from: "src/lib/okf-authoring/__snapshots__/guidelines.test.ts.snap",
      to: "src/server/docs/__snapshots__/okf-guidelines.test.ts.snap",
    },
    { from: "src/lib", to: "packages/core/src" },
  ],
  server: [
    // These check the wiring of route files and a component, so they belong to the app and the UI.
    { from: "src/server/mcp/integration.test.ts", to: "src/app/api/mcp/integration.test.ts" },
    {
      from: "src/server/mcp/token-routes.test.ts",
      to: "src/app/api/account/tokens/token-routes.test.ts",
    },
    { from: "src/server/sync/limits.test.tsx", to: "src/components/sync-limits.test.tsx" },
    { from: "src/server", to: "packages/server/src" },
  ],
  ui: [
    { from: "src/components", to: "packages/ui/src/components" },
    // The bodies of the route files; the app keeps thin files that re-export them.
    { from: "src/app/page.tsx", to: "packages/ui/src/pages/home.tsx" },
    { from: "src/app/page.test.tsx", to: "packages/ui/src/pages/home.test.tsx" },
    { from: "src/app/layout.tsx", to: "packages/ui/src/pages/root-layout.tsx" },
    { from: "src/app/layout.test.tsx", to: "packages/ui/src/pages/root-layout.test.tsx" },
    { from: "src/app/error.tsx", to: "packages/ui/src/pages/error.tsx" },
    { from: "src/app/error.test.tsx", to: "packages/ui/src/pages/error.test.tsx" },
    { from: "src/app/global-error.tsx", to: "packages/ui/src/pages/global-error.tsx" },
    { from: "src/app/global-error.test.tsx", to: "packages/ui/src/pages/global-error.test.tsx" },
    { from: "src/app/login/page.tsx", to: "packages/ui/src/pages/login.tsx" },
    { from: "src/app/search/page.tsx", to: "packages/ui/src/pages/search.tsx" },
    { from: "src/app/search/page.test.tsx", to: "packages/ui/src/pages/search.test.tsx" },
    { from: "src/app/search/loading.tsx", to: "packages/ui/src/pages/search-loading.tsx" },
    { from: "src/app/status/page.tsx", to: "packages/ui/src/pages/status.tsx" },
    { from: "src/app/status/page.test.tsx", to: "packages/ui/src/pages/status.test.tsx" },
    { from: "src/app/ask/page.tsx", to: "packages/ui/src/pages/ask.tsx" },
    { from: "src/app/ask/page.test.tsx", to: "packages/ui/src/pages/ask.test.tsx" },
    { from: "src/app/account/agent-access/page.tsx", to: "packages/ui/src/pages/agent-access.tsx" },
    {
      from: "src/app/account/agent-access/page.test.tsx",
      to: "packages/ui/src/pages/agent-access.test.tsx",
    },
    { from: "src/app/admin/layout.tsx", to: "packages/ui/src/pages/admin-layout.tsx" },
    { from: "src/app/admin/layout.test.tsx", to: "packages/ui/src/pages/admin-layout.test.tsx" },
    { from: "src/app/admin/page.tsx", to: "packages/ui/src/pages/admin-home.tsx" },
    { from: "src/app/admin/page.test.tsx", to: "packages/ui/src/pages/admin-home.test.tsx" },
    { from: "src/app/admin/ask/page.tsx", to: "packages/ui/src/pages/admin-ask-redirect.tsx" },
    {
      from: "src/app/admin/ask/page.test.tsx",
      to: "packages/ui/src/pages/admin-ask-redirect.test.tsx",
    },
    { from: "src/app/admin/branding/page.tsx", to: "packages/ui/src/pages/admin-branding.tsx" },
    { from: "src/app/admin/comments/page.tsx", to: "packages/ui/src/pages/admin-comments.tsx" },
    {
      from: "src/app/admin/comments/page.test.tsx",
      to: "packages/ui/src/pages/admin-comments.test.tsx",
    },
    {
      from: "src/app/admin/github/page.tsx",
      to: "packages/ui/src/pages/admin-github-redirect.tsx",
    },
    { from: "src/app/admin/repos/page.tsx", to: "packages/ui/src/pages/admin-repos-redirect.tsx" },
    { from: "src/app/admin/tokens/page.tsx", to: "packages/ui/src/pages/admin-tokens.tsx" },
    {
      from: "src/app/admin/tokens/page.test.tsx",
      to: "packages/ui/src/pages/admin-tokens.test.tsx",
    },
    { from: "src/app/admin/users/page.tsx", to: "packages/ui/src/pages/admin-users.tsx" },
    { from: "src/app/admin/workspace/page.tsx", to: "packages/ui/src/pages/admin-workspace.tsx" },
    {
      from: "src/app/admin/workspace/page.test.tsx",
      to: "packages/ui/src/pages/admin-workspace.test.tsx",
    },
    { from: "src/app/[owner]/[repo]/page.tsx", to: "packages/ui/src/pages/repo.tsx" },
    { from: "src/app/[owner]/[repo]/page.test.tsx", to: "packages/ui/src/pages/repo.test.tsx" },
    {
      from: "src/app/[owner]/[repo]/not-found.tsx",
      to: "packages/ui/src/pages/repo-not-found.tsx",
    },
    {
      from: "src/app/[owner]/[repo]/docs/page.tsx",
      to: "packages/ui/src/pages/repo-docs-redirect.tsx",
    },
    {
      from: "src/app/[owner]/[repo]/docs/page.test.tsx",
      to: "packages/ui/src/pages/repo-docs-redirect.test.tsx",
    },
    { from: "src/app/[owner]/[repo]/docs/[...path]/page.tsx", to: "packages/ui/src/pages/doc.tsx" },
    {
      from: "src/app/[owner]/[repo]/docs/[...path]/page.test.tsx",
      to: "packages/ui/src/pages/doc.test.tsx",
    },
    {
      from: "src/app/[owner]/[repo]/docs/[...path]/not-found.tsx",
      to: "packages/ui/src/pages/doc-not-found.tsx",
    },
    {
      from: "src/app/[owner]/[repo]/api-reference/[...path]/page.tsx",
      to: "packages/ui/src/pages/api-reference.tsx",
    },
    {
      from: "src/app/[owner]/[repo]/api-reference/[...path]/page.test.tsx",
      to: "packages/ui/src/pages/api-reference.test.tsx",
    },
    { from: "src/app/e2e/mermaid/page.tsx", to: "packages/ui/src/pages/e2e-mermaid.tsx" },
    { from: "src/app/e2e/mermaid/page.test.tsx", to: "packages/ui/src/pages/e2e-mermaid.test.tsx" },
    { from: "src/app/e2e/theme/page.tsx", to: "packages/ui/src/pages/e2e-theme.tsx" },
    { from: "src/app/globals.css", to: "packages/ui/src/styles.css" },
  ],
};

/** Textual path mentions to rewrite per step, most specific first. */
const MENTIONS: Readonly<Record<string, readonly [string, string][]>> = {
  core: [
    ["src/server/config/schema", "packages/core/src/config/schema"],
    ["@/server/config/schema", "@docmyrepos/core/internal/config/schema"],
    ["src/lib/", "packages/core/src/"],
    ["@/lib/", "@docmyrepos/core/internal/"],
  ],
  server: [
    ["src/server/", "packages/server/src/"],
    ["`src/server`", "`packages/server/src`"],
    ["@/server/", "@docmyrepos/server/internal/"],
    // Path patterns inside regular expressions of the repository guards.
    ["^src\\/server\\/", "^packages\\/server\\/src\\/"],
  ],
  ui: [
    ["src/components/", "packages/ui/src/components/"],
    ["`src/components`", "`packages/ui/src/components`"],
    ["^src\\/components\\/", "^packages\\/ui\\/src\\/components\\/"],
  ],
};

const ROOT = process.cwd();
const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".cjs"]);
const TEXT_EXT = new Set([...SOURCE_EXT, ".md", ".yml", ".yaml", ".json", ".css"]);
/** Text files never rewritten: history, generated files and other tools' folders. */
const SKIP_PREFIXES = [
  "openspec/",
  ".claude/",
  ".cursor/",
  ".opencode/",
  ".grok/",
  ".agents/",
  ".codex/",
  ".dsh/",
  ".impeccable/",
  ".serena/",
  "pnpm-lock.yaml",
  "drizzle/",
  "scripts/codemod-packages.ts",
];

const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|unmock|importActual)(?:<[^>]*>)?\(\s*|\brequire\(\s*)(["'])([^"'\n]+)\2/g;

function posix(path: string): string {
  return path.split(sep).join("/");
}

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => existsSync(join(ROOT, f)));
}

function newPathOf(moves: readonly Move[], path: string): string {
  for (const m of moves) {
    if (path === m.from) return m.to;
    if (path.startsWith(`${m.from}/`)) return m.to + path.slice(m.from.length);
  }
  return path;
}

function zoneOf(path: string): string {
  const pkg = /^packages\/(core|server|ui)\/src\//.exec(path);
  if (pkg) return `pkg:${pkg[1]}`;
  if (path.startsWith("src/")) return "app";
  return "tool";
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** The file a specifier names in the current layout, or null for a package import. */
function resolveTarget(importer: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(join(ROOT, importer)), spec);
  else return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  const hit = candidates.find(isFile);
  return hit ? posix(relative(ROOT, hit)) : null;
}

function withoutExt(path: string): string {
  const ext = extname(path);
  return ext === ".ts" || ext === ".tsx" ? path.slice(0, -ext.length) : path;
}

function relativeSpec(fromFile: string, toFile: string, pointedAtDir: boolean): string {
  let target = withoutExt(toFile);
  if (pointedAtDir && /\/index$/.test(target)) target = target.slice(0, -"/index".length);
  let rel = posix(relative(dirname(fromFile), target));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function main(): void {
  const [step, ...flags] = process.argv.slice(2);
  const moves = step ? STEPS[step] : undefined;
  if (!moves) throw new Error(`usage: codemod-packages.ts <${Object.keys(STEPS).join("|")}>`);
  const dryRun = flags.includes("--dry-run");

  const files = trackedFiles();
  const errors: string[] = [];
  const rewritten = new Map<string, string>();

  for (const file of files) {
    if (!SOURCE_EXT.has(extname(file)) || SKIP_PREFIXES.some((p) => file.startsWith(p))) continue;
    const source = readFileSync(join(ROOT, file), "utf8");
    const importerNew = newPathOf(moves, file);
    let changed = false;
    const next = source.replace(SPECIFIER, (whole, lead: string, quote: string, spec: string) => {
      const target = resolveTarget(file, spec);
      if (target === null) return whole;
      const targetNew = newPathOf(moves, target);
      if (targetNew === target && importerNew === file) return whole;
      const from = zoneOf(importerNew);
      const to = zoneOf(targetNew);
      const pointedAtDir = !/\/index(\.tsx?)?$/.test(spec) && /\/index\.tsx?$/.test(target);
      let out: string;
      if (from === to && from !== "app") {
        out = relativeSpec(importerNew, targetNew, pointedAtDir);
      } else if (from === "app" && to === "app") {
        out = `@/${withoutExt(targetNew.slice("src/".length))}`;
        if (pointedAtDir) out = out.replace(/\/index$/, "");
      } else if (to.startsWith("pkg:") && from !== "tool") {
        const pkg = to.slice(4);
        const inSrc = targetNew.slice(`packages/${pkg}/src/`.length);
        if (extname(inSrc) === ".tsx") {
          errors.push(`${file}: imports ${spec}, a .tsx module of another package`);
          return whole;
        }
        out = `@docmyrepos/${pkg}/internal/${withoutExt(inSrc)}`;
      } else if (from === "tool" || to === "tool") {
        // Repository tooling (tests/support, scripts) is reached by relative paths both ways.
        out = relativeSpec(importerNew, targetNew, pointedAtDir);
      } else {
        errors.push(`${file}: a package file would import the app module ${target}`);
        return whole;
      }
      if (out === spec) return whole;
      changed = true;
      return `${lead}${quote}${out}${quote}`;
    });
    if (changed) rewritten.set(file, next);
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exitCode = 1;
    return;
  }

  const toMove = files.filter((f) => newPathOf(moves, f) !== f);
  console.log(`${toMove.length} files to move, ${rewritten.size} files with rewritten imports`);
  if (dryRun) {
    for (const [file, text] of rewritten) {
      const before = readFileSync(join(ROOT, file), "utf8").split("\n");
      const after = text.split("\n");
      after.forEach((line, i) => {
        if (line !== before[i]) console.log(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    return;
  }

  for (const file of toMove) {
    const to = newPathOf(moves, file);
    execFileSync("mkdir", ["-p", dirname(to)]);
    const tracked =
      execFileSync("git", ["ls-files", "--", file], { encoding: "utf8" }).trim() !== "";
    if (tracked) execFileSync("git", ["mv", file, to]);
    else execFileSync("mv", [file, to]);
  }
  for (const [file, text] of rewritten) writeFileSync(join(ROOT, newPathOf(moves, file)), text);

  // Path mentions in comments, docs and configuration.
  const mentions = MENTIONS[step as string] ?? [];
  let mentionFiles = 0;
  for (const file of trackedFiles()) {
    if (!TEXT_EXT.has(extname(file)) && !/(^|\/)(Dockerfile|CLAUDE\.md)$/.test(file)) continue;
    if (SKIP_PREFIXES.some((p) => file.startsWith(p))) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    let next = text;
    for (const [a, b] of mentions) next = next.split(a).join(b);
    if (next !== text) {
      writeFileSync(join(ROOT, file), next);
      mentionFiles++;
    }
  }
  console.log(`moved ${toMove.length} files; rewrote path mentions in ${mentionFiles} files`);
}

main();
