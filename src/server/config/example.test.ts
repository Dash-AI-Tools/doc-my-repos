import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import type { EnvSource } from "./env";
import { ConfigError, loadConfig, type LoadedConfig } from "./load";
import { DEFAULT_DOCS_PATHS, configSchema } from "./schema";

// Resolved from this file, so the test does not depend on the working directory.
const EXAMPLE_PATH = fileURLToPath(
  new URL("../../../docmyrepos.config.example.yml", import.meta.url),
);
const REPO_ROOT = dirname(EXAMPLE_PATH);
const EXAMPLE_NAME = basename(EXAMPLE_PATH);
const EXAMPLE_TEXT = readFileSync(EXAMPLE_PATH, "utf8");

// Key generated per run so no key material is committed.
const FAKE_PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const ENV: EnvSource = {
  CONFIG_PATH: EXAMPLE_NAME,
  DATABASE_URL: "postgres://docmyrepos:fake-db-password@127.0.0.1:5432/docmyrepos",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: FAKE_PEM,
  GITHUB_APP_INSTALLATION_ID: "67890",
  GITHUB_WEBHOOK_SECRET: "fake-webhook-secret",
  SYNC_SECRET: "fake-sync-secret",
};

/** Loads `text` as the config file, with every other input valid. */
function loadText(text: string): LoadedConfig {
  return loadConfig({ env: ENV, cwd: REPO_ROOT, readFile: () => text });
}

function catchConfigError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected loadConfig to throw ConfigError");
}

const BEGIN_LINE = /^# BEGIN alternative: (\S+)$/;
const END_LINE = /^# END alternative: (\S+)$/;

interface SplitExample {
  /** The file without its alternative blocks: the active config. */
  active: string;
  /** Each alternative block with its comment prefix removed, so it is plain YAML. */
  alternatives: { name: string; uncommented: string }[];
}

/**
 * Convention: an alternative is every line from `# BEGIN alternative: NAME` to
 * `# END alternative: NAME`. Each line in between must be `# ` followed by YAML, or a bare `#`
 * (an empty line). Uncommenting strips exactly that prefix, so the block is the YAML it shows.
 * Any other line inside a block is an error, so a block cannot hide prose or drift silently.
 */
function splitExample(text: string): SplitExample {
  const active: string[] = [];
  const alternatives: SplitExample["alternatives"] = [];
  let open: { name: string; lines: string[] } | null = null;

  for (const [index, line] of text.split("\n").entries()) {
    const where = `${EXAMPLE_NAME} line ${index + 1}`;
    const begin = BEGIN_LINE.exec(line);
    const end = END_LINE.exec(line);

    if (open === null) {
      if (end) throw new Error(`${where}: END without BEGIN`);
      if (begin) open = { name: begin[1] ?? "", lines: [] };
      else active.push(line);
      continue;
    }
    if (begin) throw new Error(`${where}: BEGIN inside alternative "${open.name}"`);
    if (end) {
      if ((end[1] ?? "") !== open.name) {
        throw new Error(`${where}: END does not match alternative "${open.name}"`);
      }
      alternatives.push({ name: open.name, uncommented: `${open.lines.join("\n")}\n` });
      open = null;
      continue;
    }
    if (line.trim() === "" || line === "#") open.lines.push("");
    else if (line.startsWith("# ")) open.lines.push(line.slice(2));
    else {
      throw new Error(
        `${where}: line in alternative "${open.name}" must be a comment starting with "# "`,
      );
    }
  }
  if (open !== null) throw new Error(`alternative "${open.name}" has no END line`);

  return { active: active.join("\n"), alternatives };
}

const SPLIT = splitExample(EXAMPLE_TEXT);

function alternative(name: string): string {
  const found = SPLIT.alternatives.find((a) => a.name === name);
  if (!found) throw new Error(`no alternative named "${name}" in ${EXAMPLE_NAME}`);
  return found.uncommented;
}

/** Every mapping key at any depth. */
function yamlKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => yamlKeys(item));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [key, ...yamlKeys(child)]);
  }
  return [];
}

/** Names that look like credentials. Matched against keys and against ALL_CAPS words. */
const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE|PEM/i;

describe("splitExample", () => {
  it("rejects an alternative line that is not a comment", () => {
    expect(() => splitExample("# BEGIN alternative: x\nfoo: 1\n# END alternative: x\n")).toThrow(
      'must be a comment starting with "# "',
    );
  });

  it("rejects an alternative without an END line", () => {
    expect(() => splitExample("# BEGIN alternative: x\n# foo: 1\n")).toThrow("has no END line");
  });
});

describe("docmyrepos.config.example.yml", () => {
  it("loads from disk as a valid config", () => {
    const loaded = loadConfig({ env: ENV, cwd: REPO_ROOT });

    expect(loaded.configFile).toEqual({ path: EXAMPLE_NAME, found: true });
    expect(loaded.config.repos).toEqual([
      "api-service",
      { name: "web-app", docsPath: "user-guide" },
      "handbook",
    ]);
    expect(loaded.config.exclude).toBeUndefined();
    expect(loaded.config.defaults.docsPaths).toEqual([...DEFAULT_DOCS_PATHS]);
    // The example spells out the defaults.
    expect(loaded.config.limits).toEqual(configSchema.parse({}).limits);
    expect(parse(SPLIT.active)).toMatchObject({
      limits: { maxDocsPerRepo: 2000, maxFileBytes: 262144 },
    });
    expect(loaded.config.sync).toEqual(configSchema.parse({}).sync);
    expect(parse(SPLIT.active)).toMatchObject({
      sync: { intervalMinutes: 60, onStartup: true },
    });
  });

  it("has an active part that validates without any alternative", () => {
    const loaded = loadText(SPLIT.active);
    expect(loaded.config.repos).toHaveLength(3);
  });

  it("validates every commented-out alternative when uncommented", () => {
    // Exactly the options that are not active. A new alternative must be added to this list.
    expect(SPLIT.alternatives.map((a) => a.name)).toEqual(["exclude"]);
    for (const alt of SPLIT.alternatives) {
      // Throws ConfigError, listing the problems, if the block drifts from the schema.
      loadText(alt.uncommented);
    }
  });

  it("the exclude alternative excludes the listed repositories", () => {
    const loaded = loadText(alternative("exclude"));
    expect(loaded.config.exclude).toEqual(["sandbox", "legacy-wiki"]);
    expect(loaded.config.repos).toBeUndefined();
  });

  it("rejects repos and exclude uncommented together", () => {
    const error = catchConfigError(() => loadText(`${SPLIT.active}${alternative("exclude")}`));
    expect(error.problems).toContain(
      `${EXAMPLE_NAME}: exclude: use either 'repos' or 'exclude', not both`,
    );
  });

  it("names no secret-looking keys or environment variables", () => {
    const texts = [SPLIT.active, ...SPLIT.alternatives.map((a) => a.uncommented)];
    const keys = texts.flatMap((text) => yamlKeys(parse(text)));
    expect(keys.filter((key) => SECRET_NAME.test(key))).toEqual([]);

    const capsWords = EXAMPLE_TEXT.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
    expect(capsWords.filter((word) => SECRET_NAME.test(word))).toEqual([]);
  });
});
