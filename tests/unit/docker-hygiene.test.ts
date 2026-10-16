import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * Static checks of the container files (tasks 13.1 and 13.2), with no Docker needed: they catch the
 * mistakes that matter without a build, such as a baked-in secret, a root user, a published
 * database port or the e2e fixture switch. The real build and run are verified by hand (and by CI).
 */

const root = (name: string) => fileURLToPath(new URL(`../../${name}`, import.meta.url));
const read = (name: string) => readFileSync(root(name), "utf8");

const dockerfile = read("Dockerfile");
const entrypoint = read("docker-entrypoint.sh");
const dockerignore = read(".dockerignore");
const composeText = read("docker-compose.yml");
const envExample = read(".env.example");

/** Non-comment lines of a file, with line continuations joined. */
function instructions(text: string): string[] {
  return text
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

interface ComposeService {
  image?: string;
  build?: unknown;
  ports?: string[];
  depends_on?: Record<string, { condition?: string }>;
  environment?: Record<string, string | number | null>;
  env_file?: ({ path: string; required?: boolean } | string)[];
  volumes?: string[];
  init?: boolean;
  read_only?: boolean;
  privileged?: boolean;
  healthcheck?: Record<string, unknown>;
  restart?: string;
  user?: string;
}
const compose = parse(composeText) as { services: Record<string, ComposeService> };
const app = compose.services.app as ComposeService;
const db = compose.services.db as ComposeService;

describe("Dockerfile", () => {
  const lines = instructions(dockerfile);

  it("is multi-stage and installs from the frozen lockfile", () => {
    expect(lines.filter((l) => /^FROM /i.test(l)).length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => /pnpm install .*--frozen-lockfile/.test(l))).toBe(true);
    expect(lines.some((l) => /pnpm build\b/.test(l) && /pnpm build:migrate\b/.test(l))).toBe(true);
  });

  it("runs as a non-root user", () => {
    const users = lines.filter((l) => /^USER /i.test(l));
    expect(users.length).toBeGreaterThan(0);
    const last = users[users.length - 1] ?? "";
    expect(last).toMatch(/^USER (node|[1-9][0-9]*)(:|$)/i);
    expect(last).not.toMatch(/root|\b0\b/);
  });

  it("has a health check on /api/health and exposes port 3000", () => {
    const health = lines.find((l) => /^HEALTHCHECK /i.test(l));
    expect(health).toBeDefined();
    expect(health).toContain("/api/health");
    expect(lines).toContain("EXPOSE 3000");
  });

  it("configures a production server that listens on every interface", () => {
    const env = lines.filter((l) => /^ENV /i.test(l)).join(" ");
    expect(env).toContain("NODE_ENV=production");
    expect(env).toContain("HOSTNAME=0.0.0.0");
    expect(env).toContain("NEXT_TELEMETRY_DISABLED=1");
    expect(env).toContain("MIGRATIONS_DIR=/app/drizzle");
  });

  it("copies the migrations and the migration bundle, and starts through the entrypoint", () => {
    expect(lines.some((l) => /^COPY drizzle /.test(l))).toBe(true);
    expect(lines.some((l) => /db-migrate\.mjs/.test(l) && /^COPY /.test(l))).toBe(true);
    expect(lines.some((l) => /^ENTRYPOINT \["\/app\/docker-entrypoint\.sh"\]/.test(l))).toBe(true);
    expect(lines.some((l) => /^CMD \["node", "server\.js"\]/.test(l))).toBe(true);
  });

  it("carries no secret values", () => {
    for (const l of lines.filter((l) => /^(ENV|ARG) /i.test(l))) {
      expect(l).not.toMatch(
        /(SECRET|PRIVATE_KEY|TOKEN|PASSWORD|DATABASE_URL|APP_ID|INSTALLATION_ID)\w*=\S/,
      );
    }
    expect(dockerfile).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.env/);
  });

  it("labels the image with its source and licence", () => {
    expect(dockerfile).toContain("org.opencontainers.image.source=");
    expect(dockerfile).toContain('org.opencontainers.image.licenses="MIT"');
  });
});

describe("docker-entrypoint.sh", () => {
  it("is a POSIX shell script that fails fast", () => {
    expect(entrypoint.startsWith("#!/bin/sh\n")).toBe(true);
    expect(entrypoint).toMatch(/^set -eu$/m);
  });

  it("migrates, can skip migrating, and hands over to the server with exec", () => {
    expect(entrypoint).toContain("node dist/db-migrate.mjs");
    expect(entrypoint).toContain("SKIP_MIGRATIONS");
    expect(entrypoint).toMatch(/exit 1/);
    const lastCommand = instructions(entrypoint).at(-1);
    expect(lastCommand).toBe('exec "$@"');
  });

  it("exists", () => {
    // The Dockerfile chmods it, so the executable bit in git does not matter for the image.
    expect(existsSync(root("docker-entrypoint.sh"))).toBe(true);
  });
});

describe(".dockerignore", () => {
  const entries = new Set(instructions(dockerignore));

  it.each([".env", ".env.*", "node_modules", ".git", ".next", "*.pem", ".claude", "dist"])(
    "excludes %s",
    (entry) => {
      expect(entries.has(entry)).toBe(true);
    },
  );

  it("does not exclude what the build needs", () => {
    for (const needed of ["src", "drizzle", "package.json", "pnpm-lock.yaml", "e2e", "tests"]) {
      expect(entries.has(needed)).toBe(false);
    }
  });
});

describe("docker-compose.yml", () => {
  it("runs Postgres 17 with a health check and a named volume", () => {
    expect(db.image).toBe("postgres:17");
    expect(db.healthcheck).toBeDefined();
    expect(db.volumes?.some((v) => v.startsWith("db-data:"))).toBe(true);
  });

  it("publishes the database only on loopback", () => {
    for (const port of db.ports ?? []) expect(port).toMatch(/^127\.0\.0\.1:/);
  });

  it("publishes the app on loopback by default", () => {
    expect(app.ports?.length).toBeGreaterThan(0);
    for (const port of app.ports ?? []) {
      expect(port).toMatch(/^(127\.0\.0\.1|\$\{APP_BIND:-127\.0\.0\.1\}):/);
    }
  });

  it("builds the app and waits for a healthy database", () => {
    expect(app.build).toBeDefined();
    expect(app.depends_on?.db?.condition).toBe("service_healthy");
  });

  it("points the app at the db service, not at localhost", () => {
    const url = String(app.environment?.DATABASE_URL ?? "");
    expect(url).toContain("@db:5432/");
    expect(url).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it("reads .env without requiring it", () => {
    expect(app.env_file).toEqual([{ path: ".env", required: false }]);
  });

  it("mounts no config file: settings live in the database", () => {
    expect(app.volumes ?? []).toEqual([]);
    expect(composeText).not.toMatch(/^\s*[^#\n]*docmyrepos\.config/m);
  });

  it("hardens the app container", () => {
    expect(app.init).toBe(true);
    expect(app.read_only).toBe(true);
    expect(app.privileged).toBeUndefined();
    expect(app.restart).toBe("unless-stopped");
    expect(app.user).toBeUndefined(); // the image's non-root user applies
  });

  it("never sets the e2e fixture switch, anywhere (comments may warn against it)", () => {
    for (const [name, text] of Object.entries({
      "docker-compose.yml": composeText,
      Dockerfile: dockerfile,
      "docker-entrypoint.sh": entrypoint,
      ".env.example": envExample,
    })) {
      expect(instructions(text).join("\n"), name).not.toContain("E2E_FIXTURES");
    }
  });

  it("has no secret values: only variable references", () => {
    expect(composeText).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    for (const [key, value] of Object.entries(app.environment ?? {})) {
      if (/SECRET|PRIVATE_KEY|TOKEN/.test(key)) {
        expect(String(value ?? ""), key).toMatch(/^(\$\{[^}]*\})?$/);
      }
    }
  });
});

describe(".env.example", () => {
  it("holds no key material or real-looking secrets", () => {
    const active = instructions(envExample);
    expect(active.join("\n")).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    const get = (name: string) =>
      active.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1);
    expect(get("SETTINGS_ENCRYPTION_KEY")).toBe("");
    expect(get("SYNC_SECRET")).toMatch(/^replace-with-/);
    // GitHub and provider settings are entered in the admin interface, never in the environment.
    for (const retired of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]) {
      expect(get(retired), retired).toBeUndefined();
    }
  });
});
