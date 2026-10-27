import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { parseEnv } from "../../src/server/config/env";
import { parseEncryptionKey } from "../../src/server/settings/crypto";

/**
 * Tests of install.sh without Docker: the script runs under `sh` with a PATH that holds recording
 * stubs for docker, curl and lsof. The terminal is replaced by an answers file through
 * DOCMYREPOS_TTY, so a developer's own terminal is never read.
 */

const SCRIPT = fileURLToPath(new URL("../../install.sh", import.meta.url));
const COMPOSE = fileURLToPath(new URL("../../docker-compose.yml", import.meta.url));
const NO_TTY = "/nonexistent/tty";

const DOCKER_STUB = `#!/bin/sh
echo "docker $* (in $PWD) image=\${DOCMYREPOS_IMAGE:-}" >> "$STUB_LOG"
case "$1 $2" in
  "compose version")
    [ -z "\${STUB_NO_COMPOSE:-}" ] || exit 1
    case "$*" in *--short*) echo "2.29.1" ;; *) echo "Docker Compose version v2.29.1" ;; esac ;;
  "info "*|"info ") [ -z "\${STUB_INFO_FAIL:-}" ] || exit 1 ;;
  "image inspect") [ -n "\${STUB_IMAGE_LOCAL:-}" ] || exit 1 ;;
  "compose pull") [ -z "\${STUB_PULL_FAIL:-}" ] || { echo "pull failed" >&2; exit 1; } ;;
  "compose up") [ -z "\${STUB_UP_FAIL:-}" ] || { echo "up failed" >&2; exit 1; } ;;
  "compose logs") echo "app log line from the stub" ;;
  "compose exec")
    [ -z "\${STUB_DUMP_FAIL:-}" ] || { echo "dump failed" >&2; exit 1; }
    [ -n "\${STUB_DUMP_EMPTY:-}" ] || { echo "-- stub dump"; echo "CREATE TABLE users ();"; } ;;
  "compose ps") [ -n "\${STUB_DB_DOWN:-}" ] || echo "stub-db-container" ;;
esac
exit 0
`;
const CURL_STUB = `#!/bin/sh
echo "curl $*" >> "$STUB_LOG"
[ -z "\${STUB_CURL_FAIL:-}" ] || exit 22
exit 0
`;
const LSOF_STUB = `#!/bin/sh
case "$*" in *":\${STUB_BUSY_PORT:-none} "*) exit 0 ;; esac
exit 1
`;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  work: string;
  log: string;
  calls: string[];
}

interface Options {
  env?: Record<string, string>;
  /** Stubs to leave out of PATH (e.g. "docker"). */
  without?: string[];
  /** Extra stubs: name -> script body. */
  stubs?: Record<string, string>;
  /** Lines the "terminal" answers, in order. Omit for no terminal. */
  answers?: string[];
  script?: string;
  work?: string;
  /** PATH holds only the stubs and the tools the script uses, so `openssl` is absent. */
  minimalPath?: boolean;
  /** The shell to run the script with, default /bin/sh. */
  shell?: string;
}

const SCRIPT_TOOLS = [
  "uname",
  "tr",
  "grep",
  "od",
  "head",
  "base64",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "cat",
  "stty",
  "tail",
];

function linkTools(bin: string): void {
  for (const tool of SCRIPT_TOOLS) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found) symlinkSync(found, join(bin, tool));
  }
}

function run(args: string[], options: Options = {}): Result {
  const root = mkdtempSync(join(tmpdir(), "dmr-install-"));
  roots.push(root);
  const bin = join(root, "bin");
  const work = options.work ?? join(root, "work");
  mkdirSync(bin);
  mkdirSync(work, { recursive: true });
  const log = join(root, "stub.log");
  writeFileSync(log, "");
  const stubs: Record<string, string> = {
    docker: DOCKER_STUB,
    curl: CURL_STUB,
    lsof: LSOF_STUB,
    ...options.stubs,
  };
  for (const name of options.without ?? []) delete stubs[name];
  if (options.minimalPath) linkTools(bin);
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  let tty = NO_TTY;
  if (options.answers) {
    tty = join(root, "tty");
    writeFileSync(tty, options.answers.map((a) => `${a}\n`).join(""));
  }
  const result = spawnSync(options.shell ?? "/bin/sh", [options.script ?? SCRIPT, ...args], {
    cwd: work,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: options.minimalPath ? bin : `${bin}:/usr/bin:/bin`,
      HOME: root,
      NODE_ENV: "test",
      STUB_LOG: log,
      DOCMYREPOS_TTY: tty,
      ...options.env,
    },
  });
  const text = readFileSync(log, "utf8");
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    work,
    log: text,
    calls: text.split("\n").filter(Boolean),
  };
}

const GOOD = ["--yes", "--admin-email", "admin@example.com", "--dir", "site", "--port", "3456"];
const PASSWORD = { DOCMYREPOS_ADMIN_PASSWORD: "correct horse battery" };
const started = (r: Result) => r.calls.some((c) => c.startsWith("docker compose up"));
const pulled = (r: Result) => r.calls.some((c) => c.startsWith("docker compose pull"));
const emptyWork = (r: Result) => readdirSync(r.work).length === 0;

function envFile(r: Result, dir = "site"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(r.work, dir, ".env"), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^'(.*)'$/, "$1");
  }
  return out;
}

describe("install.sh usage", () => {
  it("prints help and exits 0 without checking Docker", () => {
    const r = run(["--help"], { without: ["docker"] });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--admin-email");
    expect(r.stdout).toContain("--dry-run");
  });

  it("rejects an unknown option with status 2", () => {
    const r = run(["--nope"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown option");
  });
});

describe("install.sh prerequisites", () => {
  it("stops when Docker is missing, writing nothing", () => {
    // minimalPath: a docker installed in /usr/bin (CI runners have one) must not be found.
    const r = run(GOOD, { without: ["docker"], env: PASSWORD, minimalPath: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Docker is not installed");
    expect(emptyWork(r)).toBe(true);
  });

  it("stops when only the old docker-compose exists", () => {
    const r = run(GOOD, {
      env: { ...PASSWORD, STUB_NO_COMPOSE: "1" },
      stubs: { "docker-compose": "#!/bin/sh\nexit 0\n" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("v1");
    expect(emptyWork(r)).toBe(true);
  });

  it("stops when Compose v2 is missing", () => {
    const r = run(GOOD, { env: { ...PASSWORD, STUB_NO_COMPOSE: "1" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Compose v2");
    expect(emptyWork(r)).toBe(true);
  });

  it("stops when the Docker daemon is not running", () => {
    const r = run(GOOD, { env: { ...PASSWORD, STUB_INFO_FAIL: "1" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("daemon is not reachable");
    expect(emptyWork(r)).toBe(true);
  });

  it("stops on an unsupported operating system", () => {
    const r = run(GOOD, { env: PASSWORD, stubs: { uname: "#!/bin/sh\necho FreeBSD\n" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unsupported system");
    expect(emptyWork(r)).toBe(true);
  });

  it("stops when the given port is busy", () => {
    const r = run(GOOD, { env: { ...PASSWORD, STUB_BUSY_PORT: "3456" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("port 3456 is already in use");
    expect(emptyWork(r)).toBe(true);
  });

  it("refuses an existing installation and leaves its files untouched", () => {
    const work = mkdtempSync(join(tmpdir(), "dmr-existing-"));
    roots.push(work);
    mkdirSync(join(work, "site"));
    writeFileSync(join(work, "site", "docker-compose.yml"), "mine: true\n");
    const r = run(GOOD, { env: PASSWORD, work });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already contains an installation");
    expect(readFileSync(join(work, "site", "docker-compose.yml"), "utf8")).toBe("mine: true\n");
    expect(existsSync(join(work, "site", ".env"))).toBe(false);
    expect(started(r)).toBe(false);
  });
});

describe("install.sh answers", () => {
  it("lists the missing answer and writes nothing when there is no terminal", () => {
    const r = run(["--dir", "site"], { env: PASSWORD });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--admin-email");
    expect(emptyWork(r)).toBe(true);
    expect(started(r)).toBe(false);
  });

  it.each([
    ["a port that is not a number", ["--port", "30;ls"]],
    ["port 0", ["--port", "0"]],
    ["port 65536", ["--port", "65536"]],
    ["an email with a command", ["--admin-email", "a@b.co;touch pwned"]],
    ["an email with a newline", ["--admin-email", "a@b.co\nx@y.co"]],
    ["an email without a domain", ["--admin-email", "admin"]],
    ["an image with shell characters", ["--image", "x$(touch pwned)"]],
    ["a folder with a newline", ["--dir", "a\nb"]],
  ])("rejects %s", (_name, extra) => {
    const r = run([...GOOD, ...extra], { env: PASSWORD });
    expect(r.status).toBe(1);
    expect(started(r)).toBe(false);
    expect(existsSync(join(r.work, "pwned"))).toBe(false);
    expect(readdirSync(r.work)).toEqual([]);
  });

  it.each([
    ["too short", "short"],
    ["with a quote", "long enough but it's quoted"],
    ["with a backslash", "long enough but \\ slashed"],
  ])("rejects a password %s", (_name, password) => {
    const r = run(GOOD, { env: { DOCMYREPOS_ADMIN_PASSWORD: password } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/password/i);
    expect(emptyWork(r)).toBe(true);
    expect(r.stderr + r.stdout).not.toContain(password);
  });

  it("uses a folder name with shell syntax literally and runs nothing in it", () => {
    const name = "$(touch canary) `touch canary2`; touch canary3";
    const r = run(
      ["--yes", "--admin-email", "admin@example.com", "--port", "3456", "--dir", name],
      {
        env: PASSWORD,
      },
    );
    expect(r.status).toBe(0);
    expect(readdirSync(r.work)).toEqual([name]);
    expect(existsSync(join(r.work, name, ".env"))).toBe(true);
  });
});

describe("install.sh dry run", () => {
  it("prints the plan and writes and starts nothing", () => {
    const r = run([...GOOD, "--dry-run"], { env: PASSWORD });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Dry run");
    expect(r.stdout).toContain("docker-compose.yml");
    expect(r.stdout).toContain("http://127.0.0.1:3456");
    expect(emptyWork(r)).toBe(true);
    expect(pulled(r)).toBe(false);
    expect(started(r)).toBe(false);
  });
});

describe("install.sh installation", () => {
  it("writes owner-only files, starts the stack and verifies health", () => {
    const r = run(GOOD, { env: PASSWORD });
    expect(r.status).toBe(0);

    const dir = join(r.work, "site");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, "docker-compose.yml"))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([".env", "docker-compose.yml"]);

    const pull = r.calls.findIndex((c) => c.startsWith("docker compose pull"));
    const up = r.calls.findIndex((c) =>
      c.startsWith("docker compose up -d --wait --wait-timeout 180"),
    );
    expect(pull).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(pull);
    expect(r.calls[up]).toContain("/site)");
    expect(r.log).toContain("curl -fsS -o /dev/null http://127.0.0.1:3456/api/health");

    expect(r.stdout).toContain("http://127.0.0.1:3456");
    expect(r.stdout).toContain("admin@example.com");
    expect(r.stdout).toContain("Run first sync");
  });

  it("writes exactly the variables the app and compose need, in the formats the app accepts", () => {
    const r = run(GOOD, { env: PASSWORD });
    const env = envFile(r);
    expect(Object.keys(env).sort()).toEqual(
      [
        "ADMIN_EMAIL",
        "ADMIN_PASSWORD",
        "APP_BIND",
        "APP_PORT",
        "COMPOSE_PROJECT_NAME",
        "DOCMYREPOS_IMAGE",
        "POSTGRES_PASSWORD",
        "SESSION_SECRET",
        "SETTINGS_ENCRYPTION_KEY",
        "SYNC_SECRET",
      ].sort(),
    );
    expect(env.APP_PORT).toBe("3456");
    expect(env.APP_BIND).toBe("127.0.0.1");
    expect(env.DOCMYREPOS_IMAGE).toMatch(/^ghcr\.io\/dash-ai-tools\/doc-my-repos:\d+\.\d+\.\d+$/);
    expect(env.COMPOSE_PROJECT_NAME).toMatch(/^docmyrepos-[0-9a-f]{6}$/);
    expect(env.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/);

    // The app's own validation accepts the generated values.
    const parsed = parseEnv({
      DATABASE_URL: `postgres://docmyrepos:${env.POSTGRES_PASSWORD}@db:5432/docmyrepos`,
      SYNC_SECRET: env.SYNC_SECRET,
      SESSION_SECRET: env.SESSION_SECRET,
      ADMIN_EMAIL: env.ADMIN_EMAIL,
      ADMIN_PASSWORD: env.ADMIN_PASSWORD,
    });
    expect(parsed.problems).toEqual([]);
    expect(parseEncryptionKey(env.SETTINGS_ENCRYPTION_KEY).problem).toBeNull();
    for (const key of ["SYNC_SECRET", "SESSION_SECRET"]) {
      expect(env[key]).toMatch(/^[0-9a-f]{64}$/);
      expect(env[key]).not.toMatch(/^replace-with-/i);
    }
  });

  it("never prints a secret, and prints a generated admin password exactly once", () => {
    const given = run(GOOD, { env: PASSWORD });
    const givenEnv = envFile(given);
    const out = given.stdout + given.stderr + given.log;
    for (const key of [
      "POSTGRES_PASSWORD",
      "SETTINGS_ENCRYPTION_KEY",
      "SESSION_SECRET",
      "SYNC_SECRET",
    ]) {
      expect(out).not.toContain(givenEnv[key]!);
    }
    expect(out).not.toContain(PASSWORD.DOCMYREPOS_ADMIN_PASSWORD);

    const generated = run(GOOD);
    expect(generated.status).toBe(0);
    const env = envFile(generated);
    expect(env.ADMIN_PASSWORD!.length).toBeGreaterThanOrEqual(12);
    expect(generated.stdout.split(env.ADMIN_PASSWORD!).length - 1).toBe(1);
    for (const key of [
      "POSTGRES_PASSWORD",
      "SETTINGS_ENCRYPTION_KEY",
      "SESSION_SECRET",
      "SYNC_SECRET",
    ]) {
      expect(generated.stdout + generated.stderr + generated.log).not.toContain(env[key]!);
    }
  });

  it("generates different secrets on every run", () => {
    const a = envFile(run(GOOD, { env: PASSWORD }));
    const b = envFile(run(GOOD, { env: PASSWORD }));
    for (const key of [
      "POSTGRES_PASSWORD",
      "SETTINGS_ENCRYPTION_KEY",
      "SESSION_SECRET",
      "SYNC_SECRET",
      "COMPOSE_PROJECT_NAME",
    ]) {
      expect(a[key], key).not.toBe(b[key]);
    }
  });

  it("generates the same kinds of secrets from the kernel when openssl is not installed", () => {
    const r = run(GOOD, { minimalPath: true });
    expect(r.status).toBe(0);
    const env = envFile(r);
    expect(parseEncryptionKey(env.SETTINGS_ENCRYPTION_KEY).problem).toBeNull();
    expect(env.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.SYNC_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(env.ADMIN_PASSWORD!.length).toBeGreaterThanOrEqual(12);
  });

  it("removes what it wrote when a later write fails", () => {
    const r = run(GOOD, {
      env: PASSWORD,
      stubs: {
        mv: '#!/bin/sh\ncase "$3" in */.env) exit 1 ;; esac\nexec /bin/mv "$@"\n',
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("were removed");
    expect(existsSync(join(r.work, "site"))).toBe(false);
    expect(started(r)).toBe(false);
  });
});

describe("install.sh image", () => {
  it("uses an image that is already on the machine without pulling it", () => {
    const r = run(GOOD, { env: { ...PASSWORD, STUB_IMAGE_LOCAL: "1" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already on this machine");
    expect(pulled(r)).toBe(false);
    expect(started(r)).toBe(true);
  });

  it("starts the image named by --image", () => {
    const r = run([...GOOD, "--image", "registry.example.com/mirror/docmyrepos:9.9.9"], {
      env: PASSWORD,
    });
    expect(r.status).toBe(0);
    expect(envFile(r).DOCMYREPOS_IMAGE).toBe("registry.example.com/mirror/docmyrepos:9.9.9");
    expect(r.log).toContain("docker image inspect registry.example.com/mirror/docmyrepos:9.9.9");
  });
});

describe("install.sh start-up failures", () => {
  it("names the pull step and keeps the files", () => {
    const r = run(GOOD, { env: { ...PASSWORD, STUB_PULL_FAIL: "1" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pull the image");
    expect(r.stderr).toContain("pass --image");
    expect(existsSync(join(r.work, "site", ".env"))).toBe(true);
    expect(started(r)).toBe(false);
  });

  it("prints the end of the app log when the containers do not become healthy", () => {
    const r = run(GOOD, { env: { ...PASSWORD, STUB_UP_FAIL: "1" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("healthy state");
    expect(r.stderr).toContain("app log line from the stub");
    expect(r.log).toContain("compose logs --tail 30 app");
    expect(existsSync(join(r.work, "site", ".env"))).toBe(true);
  });

  it("fails when the health endpoint does not answer", () => {
    const r = run(GOOD, { env: { ...PASSWORD, STUB_CURL_FAIL: "1" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("/api/health");
    expect(existsSync(join(r.work, "site", ".env"))).toBe(true);
  });
});

describe("install.sh prompts", () => {
  it("accepts the defaults and generates the password", () => {
    // folder, port, email, password (Enter = generate), confirmation
    const r = run([], { answers: ["", "", "admin@example.com", "", ""] });
    expect(r.status).toBe(0);
    expect(existsSync(join(r.work, "docmyrepos", ".env"))).toBe(true);
    expect(envFile(r, "docmyrepos").APP_PORT).toBe("3000");
    expect(r.stderr).toContain("Install folder [./docmyrepos]");
    expect(r.stdout).toContain("Password");
  });

  it("asks again after a weak password, an invalid email, and a busy port", () => {
    const r = run([], {
      env: { STUB_BUSY_PORT: "3000" },
      answers: [
        "site",
        "3000",
        "3001",
        "not-an-email",
        "admin@example.com",
        "short",
        "a perfectly long password",
        "y",
      ],
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("Port 3000 is already in use");
    expect(r.stderr).toContain("does not look like an email");
    expect(r.stderr).toContain("at least 12 characters");
    const env = envFile(r);
    expect(env.APP_PORT).toBe("3001");
    expect(env.ADMIN_PASSWORD).toBe("a perfectly long password");
    expect(r.stdout + r.stderr).not.toContain("a perfectly long password");
  });

  it("writes nothing when the confirmation is declined", () => {
    const r = run([], { answers: ["", "", "admin@example.com", "", "n"] });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Nothing was written");
    expect(emptyWork(r)).toBe(true);
    expect(started(r)).toBe(false);
  });

  it("stops cleanly when the input ends early", () => {
    const r = run([], { answers: [""] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("input closed");
    expect(emptyWork(r)).toBe(true);
  });
});

// macOS /bin/sh is bash in POSIX mode; dash is the strict shell of Debian and Ubuntu (and CI).
describe.skipIf(!existsSync("/bin/dash"))("install.sh under dash", () => {
  it("installs non-interactively and through the prompts", () => {
    const flags = run(GOOD, { env: PASSWORD, shell: "/bin/dash" });
    expect(flags.status).toBe(0);
    expect(statSync(join(flags.work, "site", ".env")).mode & 0o777).toBe(0o600);
    const prompts = run([], {
      shell: "/bin/dash",
      answers: ["", "", "admin@example.com", "a perfectly long password", "y"],
    });
    expect(prompts.status).toBe(0);
    expect(envFile(prompts, "docmyrepos").ADMIN_PASSWORD).toBe("a perfectly long password");
  });

  it("upgrades an installation, with a backup", () => {
    const work = mkdtempSync(join(tmpdir(), "dmr-dash-upgrade-"));
    roots.push(work);
    const image = "registry.example.com/dmr";
    expect(
      run([...GOOD, "--image", `${image}:0.1.0`], { env: PASSWORD, work, shell: "/bin/dash" })
        .status,
    ).toBe(0);
    const r = run(["--upgrade", "--yes", "--dir", "site", "--image", `${image}:0.2.0`], {
      work,
      shell: "/bin/dash",
    });
    expect(r.status).toBe(0);
    expect(readFileSync(join(work, "site", ".env"), "utf8")).toContain(
      `DOCMYREPOS_IMAGE=${image}:0.2.0`,
    );
    expect(readdirSync(join(work, "site")).some((f) => f.startsWith("backup-"))).toBe(true);
  });
});

describe("install.sh upgrade", () => {
  const OLD = "registry.example.com/dmr:0.1.0";
  const NEW = "registry.example.com/dmr:0.2.0";
  const UPGRADE = ["--upgrade", "--yes", "--dir", "site"];

  /** A finished installation of `image` in a fresh work folder. */
  function installed(image = OLD): string {
    const work = mkdtempSync(join(tmpdir(), "dmr-upgrade-"));
    roots.push(work);
    const r = run([...GOOD, "--image", image], {
      env: { DOCMYREPOS_ADMIN_PASSWORD: "pa$$ word with spaces" },
      work,
    });
    expect(r.status).toBe(0);
    return work;
  }
  const readEnv = (work: string) => readFileSync(join(work, "site", ".env"), "utf8");
  const readCompose = (work: string) =>
    readFileSync(join(work, "site", "docker-compose.yml"), "utf8");
  const backups = (work: string) =>
    readdirSync(join(work, "site")).filter((f) => f.startsWith("backup-"));
  const dumped = (r: Result) => r.calls.some((c) => c.includes("pg_dump"));
  const upgrade = (work: string, args: string[] = [], env: Record<string, string> = {}) =>
    run([...UPGRADE, "--image", NEW, ...args], { work, env });

  it("switches only the image line, keeps every other line, and keeps the compose file", () => {
    const work = installed();
    const before = readEnv(work);
    const compose = readCompose(work);
    const r = upgrade(work);
    expect(r.status).toBe(0);

    const after = readEnv(work);
    const others = (text: string) =>
      text.split("\n").filter((l) => !l.startsWith("DOCMYREPOS_IMAGE="));
    expect(others(after)).toEqual(others(before));
    expect(after).toContain(`DOCMYREPOS_IMAGE=${NEW}`);
    expect(after).not.toContain(OLD);
    expect(after).toContain("ADMIN_PASSWORD='pa$$ word with spaces'");
    expect(readCompose(work)).toBe(compose);
    expect(statSync(join(work, "site", ".env")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(work, "site")).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(r.stdout).toContain(OLD);
    expect(r.stdout).toContain(NEW);
  });

  it("pulls the new image, then backs up the database, then restarts", () => {
    const work = installed();
    const r = upgrade(work);
    const pull = r.calls.findIndex((c) => c.startsWith("docker compose pull"));
    const dump = r.calls.findIndex((c) => c.includes("pg_dump"));
    const up = r.calls.findIndex((c) => c.startsWith("docker compose up -d --wait"));
    expect(pull).toBeGreaterThan(-1);
    expect(r.calls[pull]).toContain(`image=${NEW}`);
    expect(dump).toBeGreaterThan(pull);
    expect(up).toBeGreaterThan(dump);
    expect(r.calls[dump]).toContain("--clean --if-exists -U docmyrepos docmyrepos");
    expect(r.log).toContain("curl -fsS -o /dev/null http://127.0.0.1:3456/api/health");
  });

  it("leaves an owner-only, non-empty backup in the install folder", () => {
    const work = installed();
    upgrade(work);
    const files = backups(work);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^backup-\d{8}T\d{6}Z\.sql$/);
    const path = join(work, "site", files[0]!);
    // One descriptor for both checks, so the file cannot change between them.
    const fd = openSync(path, "r");
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(readFileSync(fd, "utf8")).toContain("CREATE TABLE");
    } finally {
      closeSync(fd);
    }
  });

  it("upgrades to the version of the script when no image is given", () => {
    const work = installed("registry.example.com/dmr:0.0.1");
    const r = run(UPGRADE, { work });
    expect(r.status).toBe(0);
    expect(readEnv(work)).toMatch(
      /^DOCMYREPOS_IMAGE=ghcr\.io\/dash-ai-tools\/doc-my-repos:\d+\.\d+\.\d+$/m,
    );
  });

  it("proceeds without a terminal and without --yes, and uses a local image without pulling", () => {
    const work = installed();
    const r = run(["--upgrade", "--dir", "site", "--image", NEW], {
      work,
      env: { STUB_IMAGE_LOCAL: "1" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already on this machine");
    expect(pulled(r)).toBe(false);
    expect(readEnv(work)).toContain(NEW);
  });

  describe("when there is nothing to do or it would be unsafe", () => {
    it("reports an installation that is already on the target as up to date", () => {
      const work = installed();
      const before = readEnv(work);
      const r = run([...UPGRADE, "--image", OLD], { work });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Already up to date");
      expect(readEnv(work)).toBe(before);
      expect(backups(work)).toEqual([]);
      expect(pulled(r) || dumped(r) || started(r)).toBe(false);
    });

    it("refuses an older version of the same image because migrations only go forward", () => {
      const work = installed(NEW);
      const before = readEnv(work);
      const r = run([...UPGRADE, "--image", OLD], { work });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("older");
      expect(r.stderr).toContain("only go forward");
      expect(readEnv(work)).toBe(before);
      expect(backups(work)).toEqual([]);
      expect(pulled(r) || dumped(r) || started(r)).toBe(false);
    });

    it("compares numbers, not text: 0.10.0 is newer than 0.9.0", () => {
      const work = installed("registry.example.com/dmr:0.9.0");
      expect(run([...UPGRADE, "--image", "registry.example.com/dmr:0.10.0"], { work }).status).toBe(
        0,
      );
      expect(run([...UPGRADE, "--image", "registry.example.com/dmr:0.9.5"], { work }).status).toBe(
        1,
      );
    });

    it("does not guess the order of tags that are not versions or of a different image", () => {
      const local = installed("docmyrepos:ci");
      expect(run([...UPGRADE, "--image", "docmyrepos:ci-next"], { work: local }).status).toBe(0);
      const other = installed("registry.example.com/dmr:0.2.0");
      expect(
        run([...UPGRADE, "--image", "mirror.example.org/dmr:0.1.0"], { work: other }).status,
      ).toBe(0);
    });

    it("stops when the folder holds no installation, creating nothing", () => {
      const work = mkdtempSync(join(tmpdir(), "dmr-upgrade-empty-"));
      roots.push(work);
      const r = run(UPGRADE, { work });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("does not hold an installation");
      expect(readdirSync(work)).toEqual([]);
      expect(pulled(r) || dumped(r) || started(r)).toBe(false);
    });

    it("stops when .env has no image line", () => {
      const work = mkdtempSync(join(tmpdir(), "dmr-upgrade-noimage-"));
      roots.push(work);
      mkdirSync(join(work, "site"));
      writeFileSync(join(work, "site", ".env"), "APP_PORT=3456\n");
      writeFileSync(join(work, "site", "docker-compose.yml"), "services: {}\n");
      const r = run(UPGRADE, { work });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no DOCMYREPOS_IMAGE");
      expect(readFileSync(join(work, "site", ".env"), "utf8")).toBe("APP_PORT=3456\n");
    });
  });

  describe("preview and confirmation", () => {
    it("prints the plan and changes nothing with --dry-run", () => {
      const work = installed();
      const before = readEnv(work);
      const r = upgrade(work, ["--dry-run"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Upgrade plan");
      expect(r.stdout).toContain(OLD);
      expect(r.stdout).toContain(NEW);
      expect(r.stdout).toContain("Dry run");
      expect(readEnv(work)).toBe(before);
      expect(backups(work)).toEqual([]);
      expect(pulled(r) || dumped(r) || started(r)).toBe(false);
    });

    it("changes nothing when the confirmation is declined", () => {
      const work = installed();
      const before = readEnv(work);
      const r = run(["--upgrade", "--dir", "site", "--image", NEW], { work, answers: ["n"] });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Nothing was changed");
      expect(readEnv(work)).toBe(before);
      expect(pulled(r) || dumped(r) || started(r)).toBe(false);
    });

    it("upgrades when the confirmation is accepted", () => {
      const work = installed();
      const r = run(["--upgrade", "--dir", "site", "--image", NEW], { work, answers: ["y"] });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("Upgrade now?");
      expect(readEnv(work)).toContain(NEW);
    });
  });

  describe("failures", () => {
    it("changes nothing when the new image cannot be pulled", () => {
      const work = installed();
      const before = readEnv(work);
      const r = upgrade(work, [], { STUB_PULL_FAIL: "1" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("could not pull the image");
      expect(r.stderr).toContain("Nothing was changed");
      expect(readEnv(work)).toBe(before);
      expect(backups(work)).toEqual([]);
      expect(started(r)).toBe(false);
    });

    it("changes nothing and leaves no partial file when the backup fails", () => {
      const work = installed();
      const before = readEnv(work);
      const r = upgrade(work, [], { STUB_DUMP_FAIL: "1" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("backup failed");
      expect(readEnv(work)).toBe(before);
      expect(backups(work)).toEqual([]);
      expect(started(r)).toBe(false);
    });

    it("treats an empty backup as a failure", () => {
      const work = installed();
      const before = readEnv(work);
      const r = upgrade(work, [], { STUB_DUMP_EMPTY: "1" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("backup is empty");
      expect(readEnv(work)).toBe(before);
      expect(backups(work)).toEqual([]);
      expect(started(r)).toBe(false);
    });

    it("stops before pulling when the database is not running", () => {
      const work = installed();
      const before = readEnv(work);
      const r = upgrade(work, [], { STUB_DB_DOWN: "1" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("database is not running");
      expect(readEnv(work)).toBe(before);
      expect(pulled(r) || dumped(r) || started(r)).toBe(false);
    });

    it("keeps the new image and prints how to go back when the new version does not start", () => {
      const work = installed();
      const r = upgrade(work, [], { STUB_UP_FAIL: "1" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("healthy state");
      expect(r.stderr).toContain("app log line from the stub");
      const backup = backups(work)[0]!;
      expect(r.stderr).toContain(backup);
      expect(r.stderr).toContain(`psql -U docmyrepos -d docmyrepos < "${backup}"`);
      expect(r.stderr).toContain(`DOCMYREPOS_IMAGE=${OLD}`);
      expect(readEnv(work)).toContain(`DOCMYREPOS_IMAGE=${NEW}`);
    });

    it("prints the same recovery when the health endpoint does not answer", () => {
      const work = installed();
      const r = upgrade(work, [], { STUB_CURL_FAIL: "1" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("/api/health");
      expect(r.stderr).toContain("psql");
    });

    it("never prints a secret", () => {
      const work = installed();
      const env = envFileText(work);
      const r = upgrade(work, [], { STUB_UP_FAIL: "1" });
      for (const key of [
        "POSTGRES_PASSWORD",
        "SETTINGS_ENCRYPTION_KEY",
        "SESSION_SECRET",
        "SYNC_SECRET",
      ]) {
        expect(r.stdout + r.stderr + r.log).not.toContain(env[key]!);
      }
    });
  });

  function envFileText(work: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of readEnv(work).split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (m) out[m[1]!] = m[2]!;
    }
    return out;
  }
});

describe("install.sh piped or cut short", () => {
  it("does nothing when the download stops part-way", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const dir = mkdtempSync(join(tmpdir(), "dmr-cut-"));
    roots.push(dir);
    const cuts = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.97, 0.995];
    for (const fraction of cuts) {
      const path = join(dir, `cut-${fraction}.sh`);
      writeFileSync(path, source.slice(0, Math.floor(source.length * fraction)));
      const r = run(GOOD, { env: PASSWORD, script: path });
      expect(emptyWork(r), `cut at ${fraction}`).toBe(true);
      expect(pulled(r), `cut at ${fraction}`).toBe(false);
      expect(started(r), `cut at ${fraction}`).toBe(false);
    }
  });

  it("runs from a pipe and still reads its answers from the terminal", () => {
    const root = mkdtempSync(join(tmpdir(), "dmr-pipe-"));
    roots.push(root);
    const tty = join(root, "tty");
    writeFileSync(tty, "site\n3456\nadmin@example.com\n\ny\n");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "stub.log");
    writeFileSync(log, "");
    for (const [name, body] of Object.entries({
      docker: DOCKER_STUB,
      curl: CURL_STUB,
      lsof: LSOF_STUB,
    })) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
    const work = join(root, "work");
    mkdirSync(work);
    const result = spawnSync("/bin/sh", [], {
      cwd: work,
      input: readFileSync(SCRIPT),
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        NODE_ENV: "test",
        STUB_LOG: log,
        DOCMYREPOS_TTY: tty,
      },
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(work, "site", ".env"))).toBe(true);
  });
});

describe("install.sh network and code safety", () => {
  const source = readFileSync(SCRIPT, "utf8");

  it("fetches nothing over plain HTTP except the loopback health check", () => {
    const http = [...source.matchAll(/http:\/\/[^\s"')]+/g)].map((m) => m[0]);
    for (const url of http) expect(url, url).toMatch(/^http:\/\/127\.0\.0\.1(?![0-9])/);
  });

  it("names only the registry, the raw script URL and printed documentation links", () => {
    const hosts = new Set(
      [...source.matchAll(/https:\/\/([a-z0-9.-]+)(\/[^\s"')]*)?/gi)].map(
        (m) =>
          `${m[1]}${m[1] === "github.com" ? (m[2] ?? "").split("/").slice(0, 3).join("/") : ""}`,
      ),
    );
    const allowed = new Set([
      "raw.githubusercontent.com",
      "github.com/Dash-AI-Tools/doc-my-repos",
      "docs.docker.com",
    ]);
    for (const host of hosts) expect(allowed.has(host), host).toBe(true);
    expect(source).toContain("ghcr.io/dash-ai-tools/doc-my-repos");
  });

  it("never evaluates text as code", () => {
    expect(source).not.toMatch(/\beval\b/);
    expect(source).not.toMatch(/\bsh -c\b|\bbash -c\b/);
  });

  it("is one function call away from running, and defines everything inside main", () => {
    expect(source.trimEnd().split("\n").at(-1)).toBe('main "$@"');
  });
});

describe("install.sh compose file", () => {
  interface ComposeFile {
    services: Record<string, Record<string, unknown>>;
  }

  it("keeps the hardening of the repository's compose file and never publishes the database", () => {
    const r = run(GOOD, { env: PASSWORD });
    const written = parse(
      readFileSync(join(r.work, "site", "docker-compose.yml"), "utf8"),
    ) as ComposeFile;
    const repo = parse(readFileSync(COMPOSE, "utf8")) as ComposeFile;

    for (const key of [
      "read_only",
      "tmpfs",
      "cap_drop",
      "security_opt",
      "pids_limit",
      "logging",
      "init",
      "stop_grace_period",
      "restart",
      "depends_on",
      "ports",
    ]) {
      expect(repo.services.app![key], `repository app.${key}`).toBeDefined();
      expect(written.services.app![key], `installed app.${key}`).toEqual(repo.services.app![key]);
    }
    expect(written.services.app!.healthcheck).toEqual({ interval: "10s" });
    expect((repo.services.app!.healthcheck as { interval: string }).interval).toBe("10s");
    for (const key of ["restart", "healthcheck", "image", "volumes"]) {
      expect(written.services.db![key], `db.${key}`).toEqual(repo.services.db![key]);
    }
    expect(written.services.db!.ports).toBeUndefined();
    expect(repo.services.db!.ports).toBeDefined();
    expect(written.services.app!.build).toBeUndefined();
  });
});
