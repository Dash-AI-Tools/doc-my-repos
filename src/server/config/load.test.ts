import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { EnvSource, FileReader } from "./env";
import { ConfigError, loadConfig, type LoadedConfig } from "./load";

// Keys are generated per test run so no key material is committed.
const RSA_PAIR = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const RSA_PEM = RSA_PAIR.privateKey.trim();
const RSA_PUBLIC_PEM = RSA_PAIR.publicKey.trim();
const RSA_PKCS8_PEM = (
  createPrivateKey(RSA_PEM).export({ type: "pkcs8", format: "pem" }) as string
).trim();
const ENCRYPTED_PEM = createPrivateKey(RSA_PEM)
  .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "pw" })
  .toString();
/** Legacy OpenSSL encryption: an `RSA PRIVATE KEY` block with `Proc-Type: 4,ENCRYPTED` headers. */
const LEGACY_ENCRYPTED_PEM = createPrivateKey(RSA_PEM)
  .export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: "pw" })
  .toString()
  .trim();
const EC_PEM = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

/** Same key data under a label GitHub never issues. */
const WRONG_LABEL_PEM = RSA_PEM.replaceAll("RSA PRIVATE KEY", "OPENSSH PRIVATE KEY");

const LEAK_WINDOW = 12;

/**
 * Every 12-character window of the PEM text, and of its body with the line breaks removed.
 * Windows that lie inside an armor line (`-----BEGIN ...-----`) are public text and are skipped.
 */
function keyWindows(pem: string): string[] {
  const lines = pem.split(/\r?\n/);
  const armor = lines.filter((line) => line.startsWith("-----"));
  const body = lines.filter((line) => !line.startsWith("-----")).join("");
  const windows = new Set<string>();
  for (const text of [pem, body]) {
    for (let i = 0; i + LEAK_WINDOW <= text.length; i++) {
      const window = text.slice(i, i + LEAK_WINDOW);
      if (!armor.some((line) => line.includes(window))) windows.add(window);
    }
  }
  return [...windows];
}

/** Every way an error can end up in a log or a response. */
function errorRenderings(error: unknown): [string, string][] {
  const out: [string, string][] = [
    ["String(e)", String(error)],
    ["JSON.stringify(e)", JSON.stringify(error) ?? ""],
    ["inspect(e)", inspect(error, { showHidden: true, depth: null })],
  ];
  if (error instanceof Error) {
    out.push(["e.message", error.message], ["e.stack", error.stack ?? ""]);
  }
  if (error instanceof ConfigError) {
    out.push(
      ["e.problems", JSON.stringify(error.problems)],
      ["problems", error.problems.join("\n")],
    );
  }
  return out;
}

/**
 * Asserts that no 12-character window of any of the key texts shows up in any rendering of the
 * error. On failure only the rendering name and the number of hits are printed, never the key.
 */
function expectNoKeyMaterial(error: unknown, keyTexts: readonly string[]) {
  const windows = keyTexts.flatMap(keyWindows);
  expect(windows.length).toBeGreaterThan(0);
  for (const [name, text] of errorRenderings(error)) {
    const hits = windows.filter((w) => text.includes(w)).length;
    expect(hits, `key material found in ${name}`).toBe(0);
  }
}

/** Drops the second half of the body: still well-formed PEM text, but the DER is truncated. */
function truncatedPem(pem: string): string {
  const lines = pem.split("\n");
  const body = lines.slice(1, -1);
  return [lines[0], ...body.slice(0, Math.floor(body.length / 2)), lines.at(-1)].join("\n");
}

const CWD = "/app";
const CONFIG_FILE = "/app/docmyrepos.config.yml";
const KEY_PATH = "/run/secrets/github-app.pem";

const REQUIRED_VARS = [
  "DATABASE_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_WEBHOOK_SECRET",
  "SYNC_SECRET",
] as const;

function validEnv(overrides: Record<string, string | undefined> = {}): EnvSource {
  return {
    DATABASE_URL: "postgres://docmyrepos:db-password@127.0.0.1:5432/docmyrepos",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: RSA_PEM,
    GITHUB_APP_PRIVATE_KEY_PATH: "",
    GITHUB_APP_INSTALLATION_ID: "67890",
    GITHUB_WEBHOOK_SECRET: "webhook-secret-0123",
    SYNC_SECRET: "sync-secret-0123456",
    ...overrides,
  };
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

type FakeFile = string | { code: string; message?: string };

/** In-memory file reader: unknown paths throw ENOENT like `fs.readFileSync`. */
function fakeReader(files: Record<string, FakeFile> = {}): FileReader {
  return (path) => {
    const entry = files[path];
    if (entry === undefined) {
      throw errno("ENOENT", `ENOENT: no such file or directory, open '${path}'`);
    }
    if (typeof entry !== "string") {
      throw errno(entry.code, entry.message ?? `${entry.code}: open '${path}'`);
    }
    return entry;
  };
}

function load(env: EnvSource, files: Record<string, FakeFile> = {}): LoadedConfig {
  return loadConfig({ env, cwd: CWD, readFile: fakeReader(files) });
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

function problems(env: EnvSource, files: Record<string, FakeFile> = {}): string[] {
  return [...catchConfigError(() => load(env, files)).problems];
}

/** `x:` holding `depth` nested flow sequences. */
function nestedFlow(depth: number): string {
  return `x: ${"[".repeat(depth)}${"]".repeat(depth)}\n`;
}

/** A root of `depth` nested block sequences. */
function nestedBlock(depth: number): string {
  return Array.from({ length: depth }, (_, i) => `${"  ".repeat(i)}-`).join("\n") + " leaf\n";
}

describe("loadConfig with a valid setup", () => {
  it("loads the config file and the environment", () => {
    const loaded = load(validEnv(), {
      [CONFIG_FILE]: "repos:\n  - api-service\n  - name: web-app\n    docsPath: handbook\n",
    });
    expect(loaded.configFile).toEqual({ path: "docmyrepos.config.yml", found: true });
    expect(loaded.config.repos).toEqual(["api-service", { name: "web-app", docsPath: "handbook" }]);
    expect(loaded.config.defaults.docsPaths).toEqual(["docs", "doc", "documentation"]);
    expect(loaded.env.githubAppId).toBe(12345);
    expect(loaded.env.githubAppInstallationId).toBe(67890);
    expect(loaded.env.databaseUrl.reveal()).toBe(
      "postgres://docmyrepos:db-password@127.0.0.1:5432/docmyrepos",
    );
    expect(loaded.env.githubAppPrivateKey.reveal()).toBe(RSA_PEM);
    expect(loaded.env.githubWebhookSecret.reveal()).toBe("webhook-secret-0123");
    expect(loaded.env.syncSecret.reveal()).toBe("sync-secret-0123456");
  });

  it("returns a deeply frozen result", () => {
    const loaded = load(validEnv(), { [CONFIG_FILE]: "exclude: [sandbox]\n" });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.env)).toBe(true);
    expect(Object.isFrozen(loaded.config)).toBe(true);
    expect(Object.isFrozen(loaded.config.exclude)).toBe(true);
    expect(Object.isFrozen(loaded.config.defaults.docsPaths)).toBe(true);
  });

  it("trims surrounding whitespace from values", () => {
    const loaded = load(
      validEnv({ GITHUB_APP_ID: " 12345\n", SYNC_SECRET: "  sync-secret-0123456 \n" }),
    );
    expect(loaded.env.githubAppId).toBe(12345);
    expect(loaded.env.syncSecret.reveal()).toBe("sync-secret-0123456");
  });

  it("accepts postgresql:// URLs", () => {
    const loaded = load(validEnv({ DATABASE_URL: "postgresql://u:p@db.internal/docs" }));
    expect(loaded.env.databaseUrl.reveal()).toBe("postgresql://u:p@db.internal/docs");
  });

  it.each([
    ["a Unix socket host parameter", "postgresql:///db?host=/var/run/postgresql"],
    ["credentials and a Cloud SQL socket host", "postgres://u:pw@/db?host=/cloudsql/p:r:i"],
    [
      "credentials, a socket host and more parameters",
      "postgresql://u@/db?sslmode=disable&host=/s",
    ],
  ])("accepts a DATABASE_URL with %s", (_label, url) => {
    expect(load(validEnv({ DATABASE_URL: url })).env.databaseUrl.reveal()).toBe(url);
  });
});

describe("loadConfig config file location", () => {
  it("uses the default config when the file is missing (every accessible repository)", () => {
    const loaded = load(validEnv());
    expect(loaded.configFile).toEqual({ path: "docmyrepos.config.yml", found: false });
    expect(loaded.config.repos).toBeUndefined();
    expect(loaded.config.exclude).toBeUndefined();
    expect(loaded.config.defaults.docsPaths).toEqual(["docs", "doc", "documentation"]);
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "  \n\n"],
    ["comments-only", "# nothing configured yet\n# repos: [a]\n"],
  ])("treats an %s file as the default config", (_label, text) => {
    const loaded = load(validEnv(), { [CONFIG_FILE]: text });
    expect(loaded.configFile.found).toBe(true);
    expect(loaded.config.repos).toBeUndefined();
    expect(loaded.config.exclude).toBeUndefined();
  });

  it("reads the file named by CONFIG_PATH, relative to the working directory", () => {
    const loaded = load(validEnv({ CONFIG_PATH: "config/portal.yml" }), {
      "/app/config/portal.yml": "exclude: [sandbox]\n",
    });
    expect(loaded.configFile).toEqual({ path: "config/portal.yml", found: true });
    expect(loaded.config.exclude).toEqual(["sandbox"]);
  });

  it("reads an absolute CONFIG_PATH", () => {
    const loaded = load(validEnv({ CONFIG_PATH: "/etc/docmyrepos.yml" }), {
      "/etc/docmyrepos.yml": "repos: [a]\n",
    });
    expect(loaded.config.repos).toEqual(["a"]);
  });

  it("ignores an empty CONFIG_PATH", () => {
    expect(load(validEnv({ CONFIG_PATH: "" })).configFile.path).toBe("docmyrepos.config.yml");
  });

  it("fails when an explicit CONFIG_PATH does not exist", () => {
    expect(problems(validEnv({ CONFIG_PATH: "missing.yml" }))).toEqual([
      "CONFIG_PATH: config file missing.yml does not exist (ENOENT)",
    ]);
  });

  it("fails when the config file cannot be read, naming the file and the reason", () => {
    expect(problems(validEnv(), { [CONFIG_FILE]: { code: "EACCES" } })).toEqual([
      "docmyrepos.config.yml: config file cannot be read (EACCES)",
    ]);
  });
});

describe("Scenario: Missing App credential", () => {
  it("names GITHUB_APP_ID when it is not set", () => {
    expect(problems(validEnv({ GITHUB_APP_ID: undefined }))).toEqual(["GITHUB_APP_ID: is not set"]);
  });

  it("names GITHUB_APP_INSTALLATION_ID when it is not set", () => {
    expect(problems(validEnv({ GITHUB_APP_INSTALLATION_ID: undefined }))).toEqual([
      "GITHUB_APP_INSTALLATION_ID: is not set",
    ]);
  });

  it("names both private key variables when neither is set", () => {
    expect(
      problems(validEnv({ GITHUB_APP_PRIVATE_KEY: undefined, GITHUB_APP_PRIVATE_KEY_PATH: "" })),
    ).toEqual([
      "GITHUB_APP_PRIVATE_KEY, GITHUB_APP_PRIVATE_KEY_PATH: neither is set; set one of them to the GitHub App private key",
    ]);
  });

  it("treats empty key variables as unset, as shipped in .env.example", () => {
    expect(
      problems(validEnv({ GITHUB_APP_PRIVATE_KEY: "", GITHUB_APP_PRIVATE_KEY_PATH: "  " })),
    ).toEqual([
      "GITHUB_APP_PRIVATE_KEY, GITHUB_APP_PRIVATE_KEY_PATH: neither is set; set one of them to the GitHub App private key",
    ]);
  });
});

describe("required environment variables", () => {
  for (const name of REQUIRED_VARS) {
    it.each([
      ["missing", undefined],
      ["empty", ""],
      ["blank", "   \n"],
    ])(`names ${name} when it is %s`, (_label, value) => {
      expect(problems(validEnv({ [name]: value }))).toEqual([`${name}: is not set`]);
    });
  }

  it.each([
    "mysql://u:p@localhost/db",
    "http://localhost:5432/db",
    "not a url",
    "postgres://",
    "postgres:///db",
    "postgres:///db?host=",
    "127.0.0.1:5432",
    "postgres://u:p@/db",
    "postgres://u:p@/db?host=",
    "postgres://u:p@/db?sslmode=disable",
    "mysql://u:p@/db?host=/cloudsql/p:r:i",
  ])("rejects DATABASE_URL %j", (url) => {
    expect(problems(validEnv({ DATABASE_URL: url }))).toEqual([
      "DATABASE_URL: must be a postgres:// or postgresql:// URL with a host",
    ]);
  });

  it.each(["abc", "0", "-3", "12.5", "1e5", "0x1F", "12 34", "99999999999999999999"])(
    "rejects GITHUB_APP_INSTALLATION_ID %j",
    (id) => {
      expect(problems(validEnv({ GITHUB_APP_INSTALLATION_ID: id }))).toEqual([
        "GITHUB_APP_INSTALLATION_ID: must be a positive integer",
      ]);
    },
  );

  it("rejects a non-numeric GITHUB_APP_ID", () => {
    expect(problems(validEnv({ GITHUB_APP_ID: "Iv1.abc" }))).toEqual([
      "GITHUB_APP_ID: must be a positive integer",
    ]);
  });
});

describe("GitHub App private key sources", () => {
  it("rejects both GITHUB_APP_PRIVATE_KEY and GITHUB_APP_PRIVATE_KEY_PATH set", () => {
    expect(
      problems(validEnv({ GITHUB_APP_PRIVATE_KEY_PATH: KEY_PATH }), { [KEY_PATH]: RSA_PEM }),
    ).toEqual([
      "GITHUB_APP_PRIVATE_KEY, GITHUB_APP_PRIVATE_KEY_PATH: set only one of them, not both",
    ]);
  });

  it("accepts an inline key written on one line with \\n escapes", () => {
    const escaped = RSA_PEM.replaceAll("\n", "\\n");
    expect(escaped).not.toContain("\n");
    const loaded = load(validEnv({ GITHUB_APP_PRIVATE_KEY: escaped }));
    expect(loaded.env.githubAppPrivateKey.reveal()).toBe(RSA_PEM);
  });

  it("accepts an inline key with a trailing \\n escape and CRLF escapes", () => {
    const escaped = RSA_PEM.replaceAll("\n", "\\r\\n") + "\\n";
    expect(
      load(validEnv({ GITHUB_APP_PRIVATE_KEY: escaped })).env.githubAppPrivateKey.reveal(),
    ).toBe(RSA_PEM);
  });

  it("accepts a PKCS#8 RSA key", () => {
    const loaded = load(validEnv({ GITHUB_APP_PRIVATE_KEY: RSA_PKCS8_PEM }));
    expect(loaded.env.githubAppPrivateKey.reveal()).toBe(RSA_PKCS8_PEM);
  });

  it("reads the key from GITHUB_APP_PRIVATE_KEY_PATH", () => {
    const loaded = load(
      validEnv({ GITHUB_APP_PRIVATE_KEY: "", GITHUB_APP_PRIVATE_KEY_PATH: KEY_PATH }),
      { [KEY_PATH]: `${RSA_PEM}\n` },
    );
    expect(loaded.env.githubAppPrivateKey.reveal()).toBe(RSA_PEM);
  });
});

const NOT_PEM = "is not a PEM private key (expected a -----BEGIN ... PRIVATE KEY----- block)";
const WRONG_LABEL = "is not a PEM private key (expected RSA PRIVATE KEY or PRIVATE KEY)";
const UNPARSABLE = "is not a valid PEM private key (the key data could not be parsed)";
const ENCRYPTED = "is an encrypted private key; provide the unencrypted key GitHub issued";
const NOT_RSA = "is not an RSA private key (GitHub App keys are RSA)";

const KEY_PATH_ENV = validEnv({
  GITHUB_APP_PRIVATE_KEY: undefined,
  GITHUB_APP_PRIVATE_KEY_PATH: KEY_PATH,
});

interface KeyCase {
  name: string;
  run: () => unknown;
  /** The one problem reported, in full. */
  expected: string;
  /** Key texts the case feeds in; none of their windows may appear in the error. */
  keyTexts: string[];
}

const inlineKey = (value: string) => () => load(validEnv({ GITHUB_APP_PRIVATE_KEY: value }));
const keyFile = (content: FakeFile) => () => load(KEY_PATH_ENV, { [KEY_PATH]: content });
const inline = (problem: string) => `GITHUB_APP_PRIVATE_KEY: ${problem}`;
const fromFile = (problem: string) => `GITHUB_APP_PRIVATE_KEY_PATH: ${problem}`;

const KEY_CASES: KeyCase[] = [
  {
    name: "plain text",
    run: inlineKey("not-a-key"),
    expected: inline(NOT_PEM),
    keyTexts: [RSA_PEM],
  },
  {
    name: "key text after a stray line",
    run: inlineKey(`stray line\n${RSA_PEM}`),
    expected: inline(NOT_PEM),
    keyTexts: [RSA_PEM],
  },
  {
    name: "a header without footer",
    run: inlineKey(RSA_PEM.split("\n").slice(0, -1).join("\n")),
    expected: inline(NOT_PEM),
    keyTexts: [RSA_PEM],
  },
  {
    name: "mismatched labels",
    run: inlineKey(RSA_PEM.replace("-----END RSA PRIVATE KEY-----", "-----END PRIVATE KEY-----")),
    expected: inline(NOT_PEM),
    keyTexts: [RSA_PEM],
  },
  {
    name: "a body that is not base64",
    run: inlineKey(RSA_PEM.replace(/\n[A-Za-z0-9+/]{8}/, "\n!!!!****")),
    expected: inline(NOT_PEM),
    keyTexts: [RSA_PEM],
  },
  {
    name: "a wrong label",
    run: inlineKey(WRONG_LABEL_PEM),
    expected: inline(WRONG_LABEL),
    keyTexts: [RSA_PEM, WRONG_LABEL_PEM],
  },
  {
    name: "a wrong label given with \\n escapes",
    run: inlineKey(WRONG_LABEL_PEM.replaceAll("\n", "\\n")),
    expected: inline(WRONG_LABEL),
    keyTexts: [RSA_PEM, WRONG_LABEL_PEM],
  },
  {
    name: "a public key",
    run: inlineKey(RSA_PUBLIC_PEM),
    expected: inline(WRONG_LABEL),
    keyTexts: [RSA_PUBLIC_PEM],
  },
  {
    name: "a truncated key",
    run: inlineKey(truncatedPem(RSA_PEM)),
    expected: inline(UNPARSABLE),
    keyTexts: [RSA_PEM],
  },
  {
    name: "an encrypted PKCS#8 key",
    run: inlineKey(ENCRYPTED_PEM),
    expected: inline(ENCRYPTED),
    keyTexts: [ENCRYPTED_PEM],
  },
  {
    name: "a legacy Proc-Type: 4,ENCRYPTED key",
    run: inlineKey(LEGACY_ENCRYPTED_PEM),
    expected: inline(ENCRYPTED),
    keyTexts: [LEGACY_ENCRYPTED_PEM],
  },
  { name: "a non-RSA key", run: inlineKey(EC_PEM), expected: inline(NOT_RSA), keyTexts: [EC_PEM] },
  {
    name: "both key variables",
    run: () => load(validEnv({ GITHUB_APP_PRIVATE_KEY_PATH: KEY_PATH }), { [KEY_PATH]: RSA_PEM }),
    expected: "GITHUB_APP_PRIVATE_KEY, GITHUB_APP_PRIVATE_KEY_PATH: set only one of them, not both",
    keyTexts: [RSA_PEM],
  },
  {
    name: "key text placed in GITHUB_APP_PRIVATE_KEY_PATH",
    run: () => load(validEnv({ GITHUB_APP_PRIVATE_KEY: "", GITHUB_APP_PRIVATE_KEY_PATH: RSA_PEM })),
    expected: fromFile(
      "must be a file path, but it looks like key content; put the key in GITHUB_APP_PRIVATE_KEY instead",
    ),
    keyTexts: [RSA_PEM],
  },
  {
    name: "a reader error without a code whose text holds the key",
    run: () =>
      loadConfig({
        env: KEY_PATH_ENV,
        cwd: CWD,
        readFile: (path) => {
          if (path === KEY_PATH) throw new Error(`boom ${RSA_PEM}`);
          throw errno("ENOENT", "missing");
        },
      }),
    expected: fromFile("the key file cannot be read (unknown error)"),
    keyTexts: [RSA_PEM],
  },
  {
    name: "an EACCES reader error whose text holds the key",
    run: keyFile({ code: "EACCES", message: `EACCES ${RSA_PEM}` }),
    expected: fromFile("the key file cannot be read (EACCES)"),
    keyTexts: [RSA_PEM],
  },
  {
    name: "a key file that is not PEM",
    run: keyFile(`stray line\n${RSA_PEM}\n`),
    expected: fromFile(NOT_PEM),
    keyTexts: [RSA_PEM],
  },
  {
    name: "a key file with a public key",
    run: keyFile(`${RSA_PUBLIC_PEM}\n`),
    expected: fromFile(WRONG_LABEL),
    keyTexts: [RSA_PUBLIC_PEM],
  },
  {
    name: "a key file holding a truncated key",
    run: keyFile(truncatedPem(RSA_PEM)),
    expected: fromFile(UNPARSABLE),
    keyTexts: [RSA_PEM],
  },
  {
    name: "a key file holding a legacy encrypted key",
    run: keyFile(LEGACY_ENCRYPTED_PEM),
    expected: fromFile(ENCRYPTED),
    keyTexts: [LEGACY_ENCRYPTED_PEM],
  },
];

describe("Scenario: Unreadable private key", () => {
  it.each(["ENOENT", "EACCES", "EISDIR"])(
    "names GITHUB_APP_PRIVATE_KEY_PATH and the reason %s when the file cannot be read",
    (code) => {
      const error = catchConfigError(() => load(KEY_PATH_ENV, { [KEY_PATH]: { code } }));
      expect(error.problems).toEqual([
        `GITHUB_APP_PRIVATE_KEY_PATH: the key file cannot be read (${code})`,
      ]);
      expect(error.message).not.toContain(KEY_PATH);
    },
  );

  it("the legacy key fixture really carries Proc-Type: 4,ENCRYPTED", () => {
    expect(LEGACY_ENCRYPTED_PEM).toMatch(
      /^-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n/,
    );
  });

  it.each(KEY_CASES)(
    "rejects $name with a fixed message and no key material",
    ({ run, expected, keyTexts }) => {
      const error = catchConfigError(run);
      expect(error.problems).toEqual([expected]);
      expectNoKeyMaterial(error, keyTexts);
    },
  );

  it("the key material check catches a 12-character slice, also across a line break", () => {
    const line = RSA_PEM.split("\n")[1] ?? "";
    const acrossBreak = RSA_PEM.replaceAll("\n", "").slice(
      line.length + 31 - 6,
      line.length + 31 + 6,
    );
    for (const leaked of [RSA_PEM.slice(100, 112), RSA_PUBLIC_PEM.slice(100, 130), acrossBreak]) {
      const error = new ConfigError([`GITHUB_APP_PRIVATE_KEY: bad ${leaked}`]);
      expect(() => expectNoKeyMaterial(error, [RSA_PEM, RSA_PUBLIC_PEM])).toThrow(
        /key material found in/,
      );
    }
  });
});

describe("Scenario: Invalid config", () => {
  it("names the field and the file for a wrong type", () => {
    expect(problems(validEnv(), { [CONFIG_FILE]: "repos: api-service\n" })).toEqual([
      expect.stringMatching(/^docmyrepos\.config\.yml: repos: /),
    ]);
  });

  it("names the field and the file for an unknown field", () => {
    expect(problems(validEnv(), { [CONFIG_FILE]: "reposs: [a]\n" })).toEqual([
      "docmyrepos.config.yml: reposs: unknown field",
    ]);
  });

  it("names a nested field path", () => {
    expect(
      problems(validEnv(), { [CONFIG_FILE]: "repos:\n  - name: web-app\n    docsPath: 3\n" }),
    ).toEqual([expect.stringMatching(/^docmyrepos\.config\.yml: repos\.0\.docsPath: /)]);
  });

  it("names the CONFIG_PATH file rather than the default name", () => {
    expect(
      problems(validEnv({ CONFIG_PATH: "conf/dmr.yml" }), { "/app/conf/dmr.yml": "org: acme\n" }),
    ).toEqual(["conf/dmr.yml: org: unknown field"]);
  });

  it("says a key left with no value has no value", () => {
    expect(problems(validEnv(), { [CONFIG_FILE]: "repos:\n" })).toEqual([
      "docmyrepos.config.yml: repos: has no value; give a value or remove the key",
    ]);
    expect(problems(validEnv(), { [CONFIG_FILE]: "exclude:\n" })).toEqual([
      "docmyrepos.config.yml: exclude: has no value; give a value or remove the key",
    ]);
  });

  it("rejects an empty list", () => {
    expect(problems(validEnv(), { [CONFIG_FILE]: "repos: []\n" })).toEqual([
      "docmyrepos.config.yml: repos: repos must list at least one repository",
    ]);
  });

  it("rejects repos and exclude together, naming exclude", () => {
    expect(problems(validEnv(), { [CONFIG_FILE]: "repos: [a]\nexclude: [b]\n" })).toEqual([
      "docmyrepos.config.yml: exclude: use either 'repos' or 'exclude', not both",
    ]);
  });

  it.each([
    ["a list", "- a\n- b\n", "array"],
    ["~ (null)", "~\n", "null"],
    ["an explicit null", "null\n", "null"],
    ["a string", "just some text\n", "string"],
    ["a number", "42\n", "number"],
  ])("rejects a document whose root is %s, naming (root)", (_label, text, received) => {
    expect(problems(validEnv(), { [CONFIG_FILE]: text })).toEqual([
      `docmyrepos.config.yml: (root): Invalid input: expected object, received ${received}`,
    ]);
  });

  it("reports a YAML syntax error with file, line and column but not the file contents", () => {
    const error = catchConfigError(() =>
      load(validEnv(), { [CONFIG_FILE]: "exclude: [sandbox-xyz\n" }),
    );
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toMatch(
      /^docmyrepos\.config\.yml: YAML syntax error at line \d+, column \d+ \([a-z ]+\)$/,
    );
    expect(error.message).not.toContain("sandbox-xyz");
  });

  it("rejects duplicate keys", () => {
    expect(problems(validEnv(), { [CONFIG_FILE]: "repos: [a]\nrepos: [b]\n" })).toEqual([
      "docmyrepos.config.yml: YAML syntax error at line 2, column 1 (duplicate key)",
    ]);
  });

  it("rejects custom tags", () => {
    expect(problems(validEnv(), { [CONFIG_FILE]: "repos: !secret [a]\n" })).toEqual([
      expect.stringMatching(/^docmyrepos\.config\.yml: YAML syntax error at line 1, column \d+/),
    ]);
  });

  it("does not apply merge keys", () => {
    expect(problems(validEnv(), { [CONFIG_FILE]: "<<: {repos: [a]}\n" })).toEqual([
      "docmyrepos.config.yml: <<: unknown field",
    ]);
  });

  it("rejects alias expansion bombs", () => {
    const bomb = [
      "x-a: &a [x, x, x, x, x, x, x, x, x, x]",
      "x-b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "x-c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "",
    ].join("\n");
    expect(problems(validEnv(), { [CONFIG_FILE]: bomb })).toEqual([
      "docmyrepos.config.yml: YAML uses too many aliases (limit 10)",
    ]);
  });

  it.each([
    ["an alias with no anchor", "repos: [*secret-anchor-name]\n"],
    ["an alias used before its anchor", "repos: [*secret-anchor-name]\nx: &secret-anchor-name a\n"],
  ])("reports %s as not convertible, without the alias name", (_label, text) => {
    const error = catchConfigError(() => load(validEnv(), { [CONFIG_FILE]: text }));
    expect(error.problems).toEqual([
      "docmyrepos.config.yml: YAML could not be converted: unknown error",
    ]);
    expect(inspect(error, { showHidden: true, depth: null })).not.toContain("secret-anchor-name");
  });

  it.each([
    ["a direct self-reference", "x: &a [*a]\n"],
    ["a mutual cycle", "a: &a {b: &b {a: *a}}\n"],
    ["a cycle under a valid key", "repos: &r [*r]\n"],
    ["a cycle under a nested valid key", "defaults: &d {docsPaths: [*d]}\n"],
    ["a cycle reached through a shared alias", "a: &a [x]\nb: &b [*a, *b]\n"],
  ])("rejects %s as a circular reference", (_label, text) => {
    expect(problems(validEnv(), { [CONFIG_FILE]: text })).toEqual([
      "docmyrepos.config.yml: YAML contains a circular reference",
    ]);
  });

  it("names the CONFIG_PATH file for a circular reference", () => {
    expect(
      problems(validEnv({ CONFIG_PATH: "conf/dmr.yml" }), { "/app/conf/dmr.yml": "x: &a [*a]\n" }),
    ).toEqual(["conf/dmr.yml: YAML contains a circular reference"]);
  });

  it("accepts an alias used twice without a cycle", () => {
    const loaded = load(validEnv(), {
      [CONFIG_FILE]: "defaults:\n  docsPaths: &p [docs]\nexclude: &e [a]\n",
    });
    expect(loaded.config.defaults.docsPaths).toEqual(["docs"]);
    expect(loaded.config.exclude).toEqual(["a"]);
  });

  it.each([
    ["10,000 nested flow sequences", nestedFlow(10_000)],
    ["100,000 nested flow sequences", nestedFlow(100_000)],
    ["10,000 nested block sequences", nestedBlock(10_000)],
    ["32 nested sequences under a key", nestedFlow(32)],
    ["33 nested sequences at the root", nestedBlock(33)],
  ])("rejects %s as nested too deeply", (_label, text) => {
    expect(problems(validEnv(), { [CONFIG_FILE]: text })).toEqual([
      "docmyrepos.config.yml: YAML is nested too deeply (limit 32 levels)",
    ]);
  });

  it("validates 31 nested sequences under a key normally", () => {
    expect(problems(validEnv(), { [CONFIG_FILE]: nestedFlow(31) })).toEqual([
      "docmyrepos.config.yml: x: unknown field",
    ]);
  });

  it("rejects multiple YAML documents", () => {
    expect(problems(validEnv(), { [CONFIG_FILE]: "repos: [a]\n---\nexclude: [b]\n" })).toEqual([
      expect.stringMatching(/^docmyrepos\.config\.yml: YAML syntax error .*\(multiple docs\)$/),
    ]);
  });
});

describe("YAML problems write nothing to the process", () => {
  let emitWarning: MockInstance;
  let consoleCalls: () => [string, number][];

  beforeEach(() => {
    // Silenced so that a regression shows up as a failed count, not as config text on stderr.
    emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    // `vi.spyOn` returns the existing spy if the method is already spied on (the leakage tests
    // below spy on console for the whole file), so these are compared against a baseline and
    // never restored here.
    const methods = ["warn", "error", "log", "info", "debug", "trace"] as const;
    const spies = methods.map((m) => [m, vi.spyOn(console, m)] as const);
    const baseline = spies.map(([, spy]) => spy.mock.calls.length);
    consoleCalls = () =>
      spies.map(([m, spy], i) => [`console.${m}`, spy.mock.calls.length - (baseline[i] ?? 0)]);
  });

  afterEach(() => {
    const calls = [["process.emitWarning", emitWarning.mock.calls.length], ...consoleCalls()];
    emitWarning.mockRestore();
    // Only the counts are compared: a failure must not print what was emitted.
    expect(calls).toEqual(calls.map(([name]) => [name, 0]));
  });

  it.each([
    [
      "a collection-valued key",
      "? [a, b]\n: 1\n",
      ["docmyrepos.config.yml: [ a, b ]: unknown field"],
    ],
    [
      "a collection-valued key under a valid key",
      "defaults:\n  ? {docsPaths: x}\n  : 1\n",
      ["docmyrepos.config.yml: defaults.{ docsPaths: x }: unknown field"],
    ],
    [
      "an unknown tag",
      "repos: !secret [a]\n",
      ["docmyrepos.config.yml: YAML syntax error at line 1, column 8 (tag resolve failed)"],
    ],
    [
      "a self-reference",
      "x: &a [*a]\n",
      ["docmyrepos.config.yml: YAML contains a circular reference"],
    ],
    [
      "deep nesting",
      nestedFlow(10_000),
      ["docmyrepos.config.yml: YAML is nested too deeply (limit 32 levels)"],
    ],
  ])("emits no warning for %s", (_label, text, expected) => {
    expect(problems(validEnv(), { [CONFIG_FILE]: text })).toEqual(expected);
  });
});

describe("ConfigError", () => {
  it("reports every problem at once, file problems first", () => {
    const error = catchConfigError(() =>
      load(
        validEnv({
          GITHUB_APP_ID: undefined,
          DATABASE_URL: "mysql://x@y/z",
          GITHUB_APP_PRIVATE_KEY_PATH: KEY_PATH,
          SYNC_SECRET: "",
        }),
        { [CONFIG_FILE]: "reposs: [a]\n", [KEY_PATH]: RSA_PEM },
      ),
    );
    expect(error.problems).toEqual([
      "docmyrepos.config.yml: reposs: unknown field",
      "DATABASE_URL: must be a postgres:// or postgresql:// URL with a host",
      "GITHUB_APP_ID: is not set",
      "SYNC_SECRET: is not set",
      "GITHUB_APP_PRIVATE_KEY, GITHUB_APP_PRIVATE_KEY_PATH: set only one of them, not both",
    ]);
    expect(error.name).toBe("ConfigError");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      ["Invalid configuration (5 problems):", ...error.problems.map((p) => `  - ${p}`)].join("\n"),
    );
    expect(error.cause).toBeUndefined();
  });

  it("rejects a SYNC_SECRET shorter than 16 characters without echoing it", () => {
    const short = "SHORTsecret-15ch";
    expect(short.length).toBe(16);
    expect(load(validEnv({ SYNC_SECRET: short })).env.syncSecret.reveal()).toBe(short);
    const tooShort = "SHORTsecret-15c";
    const error = catchConfigError(() => load(validEnv({ SYNC_SECRET: `  ${tooShort}\n` })));
    expect(error.problems).toEqual(["SYNC_SECRET: must be at least 16 characters"]);
    expect(`${error.message}${inspect(error)}`).not.toContain(tooShort);
  });

  it("rejects a GITHUB_WEBHOOK_SECRET shorter than 16 characters without echoing it", () => {
    const short = "SHORTwebhook-16c";
    expect(short.length).toBe(16);
    expect(load(validEnv({ GITHUB_WEBHOOK_SECRET: short })).env.githubWebhookSecret.reveal()).toBe(
      short,
    );
    const tooShort = "SHORTwebhook-15";
    const error = catchConfigError(() =>
      load(validEnv({ GITHUB_WEBHOOK_SECRET: `  ${tooShort}\n` })),
    );
    expect(error.problems).toEqual(["GITHUB_WEBHOOK_SECRET: must be at least 16 characters"]);
    expect(`${error.message}${inspect(error)}`).not.toContain(tooShort);
  });

  it("uses the singular for one problem", () => {
    const error = catchConfigError(() => load(validEnv({ SYNC_SECRET: undefined })));
    expect(error.message).toBe("Invalid configuration (1 problem):\n  - SYNC_SECRET: is not set");
  });
});

describe("no secret leakage", () => {
  const DB_PASSWORD = "SENTINEL-DB-PASSWORD-7731";
  const WEBHOOK = "SENTINEL-WEBHOOK-SECRET-5521";
  const SYNC = "SENTINEL-SYNC-SECRET-9902";
  const KEY_TEXT = "SENTINEL-KEY-TEXT-4410";
  const FILE_TEXT = "SENTINEL-FILE-TEXT-3307";
  const APP_ID = "SENTINEL-APP-ID-1188";

  const sentinels = [DB_PASSWORD, WEBHOOK, SYNC, KEY_TEXT, FILE_TEXT, APP_ID];

  const secretEnv = (overrides: Record<string, string | undefined> = {}) =>
    validEnv({
      DATABASE_URL: `postgres://docmyrepos:${DB_PASSWORD}@db.internal:5432/docmyrepos`,
      GITHUB_WEBHOOK_SECRET: WEBHOOK,
      SYNC_SECRET: SYNC,
      ...overrides,
    });

  function expectClean(value: unknown) {
    for (const [name, text] of errorRenderings(value)) {
      for (const s of sentinels) expect(text, `secret found in ${name}`).not.toContain(s);
    }
    expectNoKeyMaterial(value, [RSA_PEM]);
  }

  const consoleSpies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) =>
    vi.spyOn(console, m),
  );
  afterEach(() => {
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  const failing: [string, () => unknown][] = [
    ["a missing variable next to valid secrets", () => load(secretEnv({ GITHUB_APP_ID: "" }))],
    [
      "a DATABASE_URL with the wrong scheme",
      () => load(secretEnv({ DATABASE_URL: `mysql://u:${DB_PASSWORD}@h/db` })),
    ],
    [
      "a DATABASE_URL that is not a URL",
      () => load(secretEnv({ DATABASE_URL: `${DB_PASSWORD} x` })),
    ],
    ...[
      `postgres://u:${DB_PASSWORD}@/db`,
      `postgres://u:${DB_PASSWORD}@/db?host=`,
      `postgres://u:${DB_PASSWORD}@:5432/db?host=/cloudsql/p:r:i`,
      `postgres://u:${DB_PASSWORD}@@/db`,
      `mysql://u:${DB_PASSWORD}@/db?host=/cloudsql/p:r:i`,
      `postgres://${DB_PASSWORD}@/db`,
    ].map((url): [string, () => unknown] => [
      `a malformed socket DATABASE_URL ${url.replace(DB_PASSWORD, "<password>")}`,
      () => load(secretEnv({ DATABASE_URL: url })),
    ]),
    ["a non-numeric GITHUB_APP_ID", () => load(secretEnv({ GITHUB_APP_ID: APP_ID }))],
    [
      "a corrupted inline key",
      () => load(secretEnv({ GITHUB_APP_PRIVATE_KEY: truncatedPem(RSA_PEM) })),
    ],
    [
      "an inline key that is not PEM",
      () => load(secretEnv({ GITHUB_APP_PRIVATE_KEY: `${KEY_TEXT}\n${RSA_PEM}` })),
    ],
    [
      "a non-RSA inline key padded with the real key text",
      () => load(secretEnv({ GITHUB_APP_PRIVATE_KEY: EC_PEM.replace("\n", `\n${KEY_TEXT}\n`) })),
    ],
    [
      "key content in GITHUB_APP_PRIVATE_KEY_PATH",
      () => load(secretEnv({ GITHUB_APP_PRIVATE_KEY: "", GITHUB_APP_PRIVATE_KEY_PATH: RSA_PEM })),
    ],
    [
      "both key variables",
      () => load(secretEnv({ GITHUB_APP_PRIVATE_KEY_PATH: KEY_PATH }), { [KEY_PATH]: RSA_PEM }),
    ],
    [
      "an unreadable key file whose error text holds the key",
      () =>
        load(secretEnv({ GITHUB_APP_PRIVATE_KEY: "", GITHUB_APP_PRIVATE_KEY_PATH: KEY_PATH }), {
          [KEY_PATH]: { code: "EACCES", message: `EACCES ${RSA_PEM} ${WEBHOOK}` },
        }),
    ],
    [
      "a key file holding a corrupted key",
      () =>
        load(secretEnv({ GITHUB_APP_PRIVATE_KEY: "", GITHUB_APP_PRIVATE_KEY_PATH: KEY_PATH }), {
          [KEY_PATH]: truncatedPem(RSA_PEM),
        }),
    ],
    ["a YAML syntax error", () => load(secretEnv(), { [CONFIG_FILE]: `repos: [${FILE_TEXT}\n` })],
    [
      "a secret-looking value in an unknown config field",
      () => load(secretEnv(), { [CONFIG_FILE]: `token: ${FILE_TEXT}\n` }),
    ],
    [
      "an invalid repository name",
      () => load(secretEnv(), { [CONFIG_FILE]: `repos: ["${FILE_TEXT} x"]\n` }),
    ],
  ];

  it.each(failing)("errors for %s contain no secret", (_label, run) => {
    expectClean(catchConfigError(run));
  });

  it("the loaded config never prints the key, the secrets or the DB password", () => {
    const loaded = load(secretEnv());
    expectClean(loaded);
    expectClean(loaded.env);
    expectClean(Object.values(loaded.env));
    expect(`${loaded.env.databaseUrl}`).toBe("[redacted]");
    expect(JSON.parse(JSON.stringify(loaded.env))).toEqual({
      databaseUrl: "[redacted]",
      githubAppId: 12345,
      githubAppInstallationId: 67890,
      githubAppPrivateKey: "[redacted]",
      githubWebhookSecret: "[redacted]",
      syncSecret: "[redacted]",
    });
  });

  it("an inline key given with \\n escapes is not printed either", () => {
    expectClean(load(secretEnv({ GITHUB_APP_PRIVATE_KEY: RSA_PEM.replaceAll("\n", "\\n") })));
  });
});
