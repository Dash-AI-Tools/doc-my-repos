// The public API of each package, as JSON: every export of every public entrypoint with its kind
// and type, read with the TypeScript compiler API. `pnpm api:report` writes
// `packages/<name>/api-report.json`; `pnpm api:check` fails, naming each difference, when the code's
// public API no longer matches the checked-in report, so a change to it is always a reviewed diff
// (and a changeset). `./internal/*` entrypoints are not reported: they are not public.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES = ["core", "server", "ui"] as const;

/** The public entrypoints of a package: its `exports` minus `./internal/*` and non-code files. */
function entrypoints(name: string): Record<string, string> {
  const dir = join(ROOT, "packages", name);
  const exports = (
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      exports: Record<string, string>;
    }
  ).exports;
  const out: Record<string, string> = {};
  for (const [key, target] of Object.entries(exports)) {
    if (key.startsWith("./internal/") || !/\.tsx?$/.test(target)) continue;
    if (!key.includes("*")) {
      out[key] = join(dir, target);
      continue;
    }
    // `./pages/*`: every module of that folder.
    const [prefix, suffix] = target.split("*") as [string, string];
    const folder = join(dir, prefix);
    for (const file of readdirSync(folder).sort()) {
      if (!file.endsWith(suffix) || /\.test\.tsx?$/.test(file) || file.startsWith("test-"))
        continue;
      out[key.replaceAll("*", file.slice(0, -suffix.length))] = join(folder, file);
    }
  }
  return out;
}

const FLAGS = ts.TypeFormatFlags.NoTruncation;

/** Type text without `import("/abs/path").` qualifiers, so the report is the same on any machine. */
const portable = (text: string) =>
  text.replace(/import\("[^"]+"\)\./g, "").replace(/import\("[^"]+"\)/g, "module");

function kindOf(symbol: ts.Symbol): string {
  const f = symbol.flags;
  if (f & ts.SymbolFlags.Class) return "class";
  if (f & ts.SymbolFlags.Function) return "function";
  if (f & ts.SymbolFlags.Variable) return "const";
  if (f & ts.SymbolFlags.Interface) return "interface";
  if (f & ts.SymbolFlags.TypeAlias) return "type";
  if (f & ts.SymbolFlags.Enum) return "enum";
  return "other";
}

/** A stable description of one export: values by their type, types by their members. */
function describe(checker: ts.TypeChecker, symbol: ts.Symbol, at: ts.Node): string {
  const kind = kindOf(symbol);
  if (kind === "interface" || kind === "type") {
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const members = checker
      .getPropertiesOfType(type)
      .map(
        (p) =>
          `${p.name}${p.flags & ts.SymbolFlags.Optional ? "?" : ""}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(p, at), undefined, FLAGS)}`,
      );
    const text = checker.typeToString(type, undefined, FLAGS | ts.TypeFormatFlags.InTypeAlias);
    return kind === "interface" || members.length > 0 ? `{ ${members.join("; ")} }` : text;
  }
  return checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, at), undefined, FLAGS);
}

function report(): Record<string, Record<string, Record<string, string>>> {
  const all = Object.fromEntries(PACKAGES.map((name) => [name, entrypoints(name)]));
  const config = ts.getParsedCommandLineOfConfigFile(
    join(ROOT, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => undefined,
    },
  );
  const program = ts.createProgram(
    Object.values(all).flatMap((files) => Object.values(files)),
    { ...config!.options, noEmit: true },
  );
  const checker = program.getTypeChecker();
  const out: Record<string, Record<string, Record<string, string>>> = {};
  for (const name of PACKAGES) {
    out[name] = {};
    for (const [entry, file] of Object.entries(all[name]!)) {
      const source = program.getSourceFile(file)!;
      const moduleSymbol = checker.getSymbolAtLocation(source)!;
      const exports: Record<string, string> = {};
      for (const symbol of checker
        .getExportsOfModule(moduleSymbol)
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        exports[symbol.name] = portable(`${kindOf(target)} ${describe(checker, target, source)}`);
      }
      out[name][entry] = exports;
    }
  }
  return out;
}

const reportPath = (name: string) => join(ROOT, "packages", name, "api-report.json");
const current = report();

if (process.argv.includes("--write")) {
  for (const name of PACKAGES) {
    writeFileSync(reportPath(name), `${JSON.stringify(current[name], null, 2)}\n`);
  }
  console.log("api-report: wrote packages/*/api-report.json");
} else {
  const problems: string[] = [];
  for (const name of PACKAGES) {
    let saved: Record<string, Record<string, string>> = {};
    try {
      saved = JSON.parse(readFileSync(reportPath(name), "utf8"));
    } catch {
      problems.push(`@docmyrepos/${name}: no api-report.json`);
    }
    const now = current[name]!;
    for (const entry of new Set([...Object.keys(saved), ...Object.keys(now)])) {
      const a = saved[entry] ?? {};
      const b = now[entry] ?? {};
      for (const exported of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const where = `@docmyrepos/${name}${entry === "." ? "" : entry.slice(1)} ${exported}`;
        if (!(exported in a)) problems.push(`${where}: added`);
        else if (!(exported in b)) problems.push(`${where}: removed`);
        else if (a[exported] !== b[exported]) problems.push(`${where}: changed`);
      }
    }
  }
  if (problems.length > 0) {
    console.error(
      `api-report: the public API differs from the checked-in report:\n${problems.map((p) => `  - ${p}`).join("\n")}\nRun \`pnpm api:report\` and commit the report with a changeset.`,
    );
    process.exit(1);
  }
  console.log("api-report: the public API matches the checked-in report");
}
