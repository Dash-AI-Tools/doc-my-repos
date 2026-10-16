import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { run } from "./run.js";
import {
  BASE_FLAGS,
  createHarness,
  EXISTING_ENV,
  type Harness,
  type RunnerCall,
} from "./test-support-run.js";

const harnesses: Harness[] = [];
async function harness(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
  const h = await createHarness(options);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const joined = (call: RunnerCall): string => call.args.join(" ");
const dockerCommands = (h: Harness): string[] => h.calls.map(joined);
const isWindows = process.platform === "win32";

/** Scripted answers for the interactive create route, defaults accepted wherever possible. */
function scriptCreate(h: Harness, tail: string[] = ["", "n"]): void {
  // org, url, port, email, (password hidden: Enter generates), app (Enter = create)
  h.lines.push("acme", "", "", "admin@acme.io", "");
  h.secrets.push("");
  // repositories: keep all; confirm write; then the tail (cleanup questions)
  h.lines.push("", ...tail);
}

describe("happy path: create the App in the browser", () => {
  it("creates the App, installs, writes, starts, syncs and keeps every secret out of the output", async () => {
    const h = await harness();
    scriptCreate(h);
    const code = await run(h.deps(["--dir", h.target]));
    expect(code).toBe(0);

    for (const name of [
      ".env",
      "docker-compose.yml",
      "docmyrepos.config.yml",
      ".gitignore",
      "github-app.private-key.pem",
    ]) {
      expect(existsSync(join(h.target, name)), name).toBe(true);
    }
    if (!isWindows) {
      expect((await stat(join(h.target, ".env"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(h.target, "github-app.private-key.pem"))).mode & 0o777).toBe(0o600);
    }
    const env = await readFile(join(h.target, ".env"), "utf8");
    expect(env).toContain(`GITHUB_APP_ID=${h.github.state.appId}`);
    expect(env).toContain("GITHUB_APP_INSTALLATION_ID=777");
    expect(await readFile(join(h.target, "docmyrepos.config.yml"), "utf8")).not.toContain("repos:");

    // The manifest conversion is the only request that created anything.
    const posts = h.github.requests.filter((r) => r.method === "POST").map((r) => r.path);
    expect(posts).toContain("/app-manifests/good-code/conversions");
    // The browser was sent to the loopback page, then to the install page.
    expect(h.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/start\?t=/);
    expect(h.opened[1]).toBe("https://github.com/apps/docmyrepos-acme/installations/new");

    // Pull, start with --wait, then the sync from the host with a bearer header.
    expect(dockerCommands(h)).toEqual(
      expect.arrayContaining(["compose pull", "compose up -d --wait --wait-timeout 180"]),
    );
    const syncSecret = await h.readEnvValue("SYNC_SECRET");
    expect(h.syncRequests).toEqual([
      {
        url: "http://127.0.0.1:3000/api/sync",
        authorization: `Bearer ${syncSecret}`,
        method: "POST",
      },
    ]);
    for (const call of h.calls) expect(call.args.join(" ")).not.toContain(syncSecret);

    // 4.2: nothing secret was printed, except the generated admin password, once.
    const printed = h.all();
    const adminPassword = await h.readEnvValue("ADMIN_PASSWORD");
    for (const name of [
      "SESSION_SECRET",
      "SYNC_SECRET",
      "POSTGRES_PASSWORD",
      "GITHUB_WEBHOOK_SECRET",
    ]) {
      expect(printed, name).not.toContain(await h.readEnvValue(name));
    }
    expect(printed).not.toContain("fake-webhook-secret-0123456789");
    expect(printed).not.toContain(h.github.state.installationToken);
    expect(printed).not.toContain("PRIVATE KEY");
    expect(printed).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\./);
    for (const bodyLine of h.pem
      .split("\n")
      .filter((l) => l.length > 20 && !l.startsWith("-----"))) {
      expect(printed).not.toContain(bodyLine);
    }
    expect(printed.split(adminPassword)).toHaveLength(2);
    expect(h.captured.stderr).not.toContain(adminPassword);
    // The admin password was generated, so the wizard told the user where it is shown.
    expect(printed).toContain("Admin password (shown once");
  });

  it("never prints a password the user typed", async () => {
    const h = await harness();
    h.lines.push("acme", "", "", "admin@acme.io");
    h.secrets.push("typed-password-123", "typed-password-123");
    h.lines.push("", "", "", "", "n");
    const code = await run(h.deps(["--dir", h.target]));
    expect(code).toBe(0);
    expect(await readFile(join(h.target, ".env"), "utf8")).toContain(
      "ADMIN_PASSWORD='typed-password-123'",
    );
    expect(h.all()).not.toContain("typed-password-123");
    expect(h.all()).toContain("the one you entered");
  });

  it("offers the picked repositories and writes exactly those", async () => {
    const h = await harness();
    h.lines.push("acme", "", "", "admin@acme.io", "");
    h.secrets.push("");
    h.lines.push("n", "nope", "handbook, api", "", "n");
    const code = await run(h.deps(["--dir", h.target]));
    expect(code).toBe(0);
    const config = await readFile(join(h.target, "docmyrepos.config.yml"), "utf8");
    expect(config).toContain('- "handbook"');
    expect(config).toContain('- "api"');
    expect(config).not.toContain("web");
    expect(h.all()).toContain("The App cannot access: nope");
  });
});

describe("existing App", () => {
  it("validates with GET /app, discovers the installation and installs non-interactively", async () => {
    const h = await harness({ installations: [{ id: 4242, login: "Acme" }] });
    const code = await run(
      h.deps(
        [
          ...BASE_FLAGS(h),
          "--repos",
          "handbook,api",
          "--port",
          "3100",
          "--url",
          "http://localhost:3100",
        ],
        {
          interactive: false,
          env: EXISTING_ENV(h),
        },
      ),
    );
    expect(code).toBe(0);
    const paths = h.github.requests.map((r) => `${r.method} ${r.path.split("?")[0]}`);
    expect(paths).toContain("GET /app");
    expect(paths).toContain("GET /app/installations");
    expect(paths.some((p) => p.startsWith("POST /app-manifests"))).toBe(false);
    expect(h.opened).toEqual([]); // no browser in non-interactive mode with a ready install
    const env = await readFile(join(h.target, ".env"), "utf8");
    expect(env).toContain("GITHUB_APP_INSTALLATION_ID=4242");
    expect(env).toContain("APP_PORT=3100");
    expect(env).toContain("GITHUB_WEBHOOK_SECRET='existing-webhook-secret-0123456789'");
    expect(await readFile(join(h.target, "docmyrepos.config.yml"), "utf8")).toContain(
      '- "handbook"',
    );
    expect(h.syncRequests[0]?.url).toBe("http://127.0.0.1:3100/api/sync");
    // A password supplied through the environment is never printed.
    expect(h.all()).not.toContain("correct-horse-battery");
  });

  it("uses an installation id from the environment without asking GitHub for installations", async () => {
    const h = await harness();
    const code = await run(
      h.deps(BASE_FLAGS(h), {
        interactive: false,
        env: { ...EXISTING_ENV(h), DOCMYREPOS_INSTALLATION_ID: "99" },
      }),
    );
    expect(code).toBe(0);
    expect(h.github.requests.some((r) => r.path.startsWith("/app/installations"))).toBe(false);
    expect(await readFile(join(h.target, ".env"), "utf8")).toContain(
      "GITHUB_APP_INSTALLATION_ID=99",
    );
  });

  it("explains a key that does not match the App without printing the key", async () => {
    const h = await harness({ installations: [{ id: 1, login: "acme" }] });
    h.github.state.failNext = {
      status: 401,
      body: { message: "A JSON web token could not be decoded" },
    };
    const code = await run(h.deps(BASE_FLAGS(h), { interactive: false, env: EXISTING_ENV(h) }));
    expect(code).toBe(1);
    expect(h.captured.stderr).toContain("did not accept the credentials");
    expect(h.all()).not.toContain("PRIVATE KEY");
    expect(existsSync(h.target)).toBe(false);
  });

  it("requires a confirmation for extra permissions, and refuses them without a terminal", async () => {
    const h = await harness({ installations: [{ id: 1, login: "acme" }] });
    h.github.state.permissions = { contents: "write", metadata: "read" };
    const refused = await run(h.deps(BASE_FLAGS(h), { interactive: false, env: EXISTING_ENV(h) }));
    expect(refused).toBe(1);
    expect(h.captured.stderr).toContain("write access to contents");
    expect(existsSync(h.target)).toBe(false);

    // Interactive: declining stops, accepting continues.
    h.captured.stderr = "";
    h.lines.push("", "", "n", "n"); // url, port; "Use this App anyway?" no; "Enter the values again?" no
    const declined = await run(
      h.deps(
        ["--dir", h.target, "--org", "acme", "--admin-email", "admin@acme.io", "--app", "existing"],
        { env: EXISTING_ENV(h) },
      ),
    );
    expect(declined).toBe(1);
    expect(existsSync(h.target)).toBe(false);

    h.lines.push("", "", "y", "", "", "n"); // url, port; anyway; keep all repos; write; signed in
    const accepted = await run(
      h.deps(
        ["--dir", h.target, "--org", "acme", "--admin-email", "admin@acme.io", "--app", "existing"],
        { env: EXISTING_ENV(h) },
      ),
    );
    expect(accepted).toBe(0);
    expect(h.captured.stderr).toContain("write access to contents");
  });
});

describe("a rejected manifest", () => {
  it("falls back to entering the values of an App created by hand", async () => {
    const h = await harness();
    h.github.state.failNext = { status: 422, body: { message: "Invalid GitHub App manifest" } };
    // Manual entry: App id, key file (visible lines), webhook secret (hidden), then the usual.
    h.lines.push("acme", "", "", "admin@acme.io", "");
    h.secrets.push("", "hand-made-webhook-secret-01234");
    h.lines.push(String(h.github.state.appId), h.keyFile, "", "", "n");
    const code = await run(h.deps(["--dir", h.target]));
    expect(code).toBe(0);
    expect(h.captured.stderr).toContain("rejected the App manifest");
    expect(h.all()).toContain("github-app-setup.md");
    expect(await readFile(join(h.target, ".env"), "utf8")).toContain(
      "GITHUB_WEBHOOK_SECRET='hand-made-webhook-secret-01234'",
    );
    expect(h.all()).not.toContain("hand-made-webhook-secret-01234");
  });
});

describe("pasting the code", () => {
  it("--no-browser asks for the code from the address bar instead of launching a browser", async () => {
    const h = await harness({ installations: [{ id: 777, login: "acme" }] });
    scriptCreate(h, ["", "n"]);
    // After the questions (and before the repositories answer) the wizard asks for the code. The
    // loopback start page is never opened, so the paste is where the code comes from; its state
    // is checked, so a pasted address must carry the printed state or none at all.
    h.lines.splice(5, 0, "good-code");
    const code = await run(h.deps(["--dir", h.target, "--no-browser"]));
    expect(code).toBe(0);
    expect(h.opened.some((u) => u.startsWith("http://127.0.0.1"))).toBe(false);
    expect(h.opened.some((u) => u.includes("installations/new"))).toBe(false);
    expect(h.all()).toContain("Open this address in your browser: http://127.0.0.1:");
  });
});

describe("--dry-run", () => {
  it("prints the plan and writes nothing, creates nothing and starts nothing (create route)", async () => {
    const h = await harness();
    h.lines.push("acme", "", "", "admin@acme.io", "");
    h.secrets.push("");
    const code = await run(h.deps(["--dir", h.target, "--dry-run"]));
    expect(code).toBe(0);
    expect(existsSync(h.target)).toBe(false);
    expect(h.github.requests).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(
      dockerCommands(h).filter((c) => c.startsWith("compose pull") || c.includes("up")),
    ).toEqual([]);
    expect(h.all()).toContain("These files will be written to");
    expect(h.all()).toContain("docker compose up -d --wait --wait-timeout 180");
    expect(h.all()).toContain("Dry run finished");
    expect(h.syncRequests).toEqual([]);
  });

  it("only reads from GitHub with an existing App", async () => {
    const h = await harness({ installations: [{ id: 5, login: "acme" }] });
    const code = await run(
      h.deps([...BASE_FLAGS(h), "--dry-run"], { interactive: false, env: EXISTING_ENV(h) }),
    );
    expect(code).toBe(0);
    expect(h.github.requests.every((r) => r.method === "GET")).toBe(true);
    expect(existsSync(h.target)).toBe(false);
    expect(h.syncRequests).toEqual([]);
    expect(dockerCommands(h).some((c) => c.includes("pull"))).toBe(false);
  });
});

describe("--no-start", () => {
  it("writes the files and prints the start command, without pulling, starting or syncing", async () => {
    const h = await harness({ installations: [{ id: 5, login: "acme" }] });
    const code = await run(
      h.deps([...BASE_FLAGS(h), "--no-start"], { interactive: false, env: EXISTING_ENV(h) }),
    );
    expect(code).toBe(0);
    expect(existsSync(join(h.target, ".env"))).toBe(true);
    expect(dockerCommands(h).some((c) => c.includes("pull") || c.includes("up"))).toBe(false);
    expect(h.syncRequests).toEqual([]);
    expect(h.all()).toContain("docker compose up -d --wait");
  });
});

describe("a failed start", () => {
  it("keeps the files, shows the log tail without secrets and exits 1", async () => {
    const h = await harness({ installations: [{ id: 5, login: "acme" }] });
    h.handler.current = (call) => {
      if (call.args[1] === "up") return { code: 1, stderr: "unhealthy" };
      if (call.args[1] === "logs") {
        const text = readFileSync(join(call.cwd ?? "", ".env"), "utf8");
        const secret = /SESSION_SECRET='([^']+)'/.exec(text)?.[1] ?? "";
        return {
          stdout: `app | boot failed\napp | SESSION_SECRET=${secret}\napp | x ${secret} y\n`,
        };
      }
      return undefined;
    };
    const code = await run(h.deps(BASE_FLAGS(h), { interactive: false, env: EXISTING_ENV(h) }));
    expect(code).toBe(1);
    expect(existsSync(join(h.target, ".env"))).toBe(true);
    const printed = h.all();
    expect(printed).toContain('Failed at the step "start"');
    expect(printed).toContain("boot failed");
    expect(printed).toContain("docker compose logs app");
    expect(printed).toContain("The files were kept");
    expect(printed).not.toContain(await h.readEnvValue("SESSION_SECRET"));
    expect(h.syncRequests).toEqual([]);
  });
});

describe("DOCMYREPOS_GITHUB_API_URL", () => {
  it.each(["https://api.github.com.evil.example", "http://192.168.1.5:9999", "http://example.com"])(
    "is refused for the non-loopback host %s",
    async (url) => {
      const h = await harness();
      const code = await run(
        h.deps(BASE_FLAGS(h), {
          interactive: false,
          env: { ...EXISTING_ENV(h), DOCMYREPOS_GITHUB_API_URL: url },
        }),
      );
      expect(code).toBe(2);
      expect(h.captured.stderr).toContain("loopback");
      expect(h.calls).toEqual([]);
      expect(h.github.requests).toEqual([]);
      expect(existsSync(h.target)).toBe(false);
    },
  );
});

describe("non-interactive mode", () => {
  it("lists every missing answer at once and exits 2", async () => {
    const h = await harness();
    const code = await run(h.deps(["--yes", "--dir", h.target], { interactive: false }));
    expect(code).toBe(2);
    for (const key of ["--org", "--admin-email", "--app"]) expect(h.captured.stderr).toContain(key);
    expect(existsSync(h.target)).toBe(false);
  });

  it("lists the missing existing-App values with the app route", async () => {
    const h = await harness();
    const code = await run(h.deps(BASE_FLAGS(h), { interactive: false }));
    expect(code).toBe(2);
    for (const key of [
      "DOCMYREPOS_APP_ID",
      "DOCMYREPOS_APP_KEY_FILE",
      "DOCMYREPOS_WEBHOOK_SECRET",
    ]) {
      expect(h.captured.stderr).toContain(key);
    }
  });

  it("refuses the manifest route", async () => {
    const h = await harness();
    const flags = BASE_FLAGS(h);
    flags[flags.indexOf("existing")] = "create";
    const code = await run(h.deps(flags, { interactive: false }));
    expect(code).toBe(2);
    expect(h.captured.stderr).toContain("needs a browser");
    expect(h.github.requests).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it("requires --yes when input is not a terminal", async () => {
    const h = await harness();
    const code = await run(h.deps(["--dir", h.target], { interactive: false }));
    expect(code).toBe(2);
    expect(h.captured.stderr).toContain("--yes");
  });

  it("reports a bad option with exit 2", async () => {
    const h = await harness();
    expect(await run(h.deps(["--admin-password", "x"]))).toBe(2);
    expect(h.captured.stderr).toContain("Unknown option --admin-password");
    expect(h.captured.stderr).not.toContain(" x");
  });
});

describe("prerequisites and safety", () => {
  it("stops before any question when the Docker daemon is down", async () => {
    const h = await harness();
    h.handler.current = (call) => (call.args[0] === "info" ? { code: 1 } : undefined);
    const code = await run(h.deps(["--dir", h.target]));
    expect(code).toBe(1);
    expect(h.captured.stderr).toContain("daemon");
    expect(h.captured.stdout).not.toContain("GitHub organization");
    expect(existsSync(h.target)).toBe(false);
  });

  it("does not need the daemon with --no-start", async () => {
    const h = await harness({ installations: [{ id: 5, login: "acme" }] });
    h.handler.current = (call) => (call.args[0] === "info" ? { code: 1 } : undefined);
    const code = await run(
      h.deps([...BASE_FLAGS(h), "--no-start"], { interactive: false, env: EXISTING_ENV(h) }),
    );
    expect(code).toBe(0);
  });

  it("asks for another port when the chosen one is taken", async () => {
    const h = await harness();
    let first = true;
    h.lines.push("acme", "", "", "3001", "admin@acme.io");
    h.secrets.push("");
    h.lines.push("existing", String(h.github.state.appId), h.keyFile, "", "", "n");
    h.secrets.push("hand-made-webhook-secret-01234");
    h.github.state.installations.push({ id: 5, login: "acme" });
    const code = await run(
      h.deps(["--dir", h.target], {
        portCheck: async (port) => {
          if (port === 3000 && first) {
            first = false;
            return {
              ok: false,
              problem: {
                check: "port",
                message: "Port 3000 is already in use on this machine.",
                fix: "Choose another port.",
              },
            };
          }
          return { ok: true, value: undefined };
        },
      }),
    );
    expect(code).toBe(0);
    expect(h.captured.stderr).toContain("Port 3000 is already in use");
    expect(await readFile(join(h.target, ".env"), "utf8")).toContain("APP_PORT=3001");
  });

  it("refuses an existing installation, and --force backs it up", async () => {
    const h = await harness({ installations: [{ id: 5, login: "acme" }] });
    await mkdir(h.target, { recursive: true });
    await writeFile(join(h.target, ".env"), "OLD=1\n");
    const refused = await run(h.deps(BASE_FLAGS(h), { interactive: false, env: EXISTING_ENV(h) }));
    expect(refused).toBe(1);
    expect(h.captured.stderr).toContain("already contains an installation");
    expect(await readFile(join(h.target, ".env"), "utf8")).toBe("OLD=1\n");
    expect(h.github.requests).toEqual([]);

    const forced = await run(
      h.deps([...BASE_FLAGS(h), "--force", "--no-start"], {
        interactive: false,
        env: EXISTING_ENV(h),
      }),
    );
    expect(forced).toBe(0);
    const names = await readdir(h.target);
    expect(names.some((n) => n.startsWith(".env.bak-"))).toBe(true);
    expect(await readFile(join(h.target, ".env"), "utf8")).toContain("GITHUB_APP_ID=");
  });

  it("refuses an old Node version without touching anything", async () => {
    const h = await harness();
    const code = await run(h.deps(["--dir", h.target], { nodeVersion: "18.19.0" }));
    expect(code).toBe(1);
    expect(h.captured.stderr).toContain("Node.js 20");
    expect(h.calls).toEqual([]);
    expect(existsSync(h.target)).toBe(false);
  });

  it("prints --version and --help without any other work", async () => {
    const h = await harness();
    expect(await run(h.deps(["--version"]))).toBe(0);
    expect(h.captured.stdout).toBe("0.1.0\n");
    expect(await run(h.deps(["--help"]))).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("interrupts", () => {
  it("during the callback wait: exit 130, the server is closed and no file is left", async () => {
    const h = await harness();
    h.lines.push("acme", "", "", "admin@acme.io", "");
    h.secrets.push("");
    let startUrl = "";
    const code = await run(
      h.deps(["--dir", h.target], {
        openBrowser: async (url) => {
          startUrl = url;
          h.abort.abort(); // Ctrl+C while GitHub is being waited for
          return true;
        },
      }),
    );
    expect(code).toBe(130);
    expect(h.captured.stderr).toContain("Nothing was written");
    expect(existsSync(h.target)).toBe(false);
    expect(await readdir(h.root)).toEqual(["app-key.pem"]);
    expect(h.github.requests).toEqual([]);
    await expect(fetch(startUrl)).rejects.toThrow();
  });

  it("while waiting for the installation: exit 130 and nothing written", async () => {
    const h = await harness();
    scriptCreate(h);
    const code = await run(
      h.deps(["--dir", h.target], {
        sleep: async () => {
          h.abort.abort();
        },
        openBrowser: async (url) => {
          if (url.startsWith("http://127.0.0.1")) {
            const html = await (await fetch(url)).text();
            const state = /state=([A-Za-z0-9_%-]+)/.exec(html)?.[1] ?? "";
            await fetch(`${new URL(url).origin}/callback?code=good-code&state=${state}`);
          }
          return true; // the install page opens but nothing gets installed
        },
      }),
    );
    expect(code).toBe(130);
    expect(existsSync(h.target)).toBe(false);
  });
});

describe("bootstrap credential cleanup", () => {
  it("removes the two lines atomically and restarts the app when accepted", async () => {
    const h = await harness();
    scriptCreate(h, ["", "y", "y"]);
    const code = await run(h.deps(["--dir", h.target]));
    expect(code).toBe(0);
    const env = await readFile(join(h.target, ".env"), "utf8");
    expect(env).not.toMatch(/^ADMIN_(EMAIL|PASSWORD)=/m);
    expect(env).toContain("SYNC_SECRET=");
    if (!isWindows) expect((await stat(join(h.target, ".env"))).mode & 0o777).toBe(0o600);
    expect((await readdir(h.target)).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
    const last = h.calls[h.calls.length - 1];
    expect(last?.args).toEqual(["compose", "up", "-d"]);
    expect(last?.cwd).toBe(h.target);
  });

  it("prints the two lines and the restart command when declined", async () => {
    const h = await harness();
    scriptCreate(h, ["", "n"]);
    const code = await run(h.deps(["--dir", h.target]));
    expect(code).toBe(0);
    expect(await readFile(join(h.target, ".env"), "utf8")).toContain("ADMIN_PASSWORD=");
    expect(h.all()).toContain("ADMIN_EMAIL=...");
    expect(h.all()).toContain("ADMIN_PASSWORD=...");
    expect(h.all()).toContain("docker compose up -d");
  });

  it("is not performed with --yes, which cannot know the user has signed in", async () => {
    const h = await harness({ installations: [{ id: 5, login: "acme" }] });
    const code = await run(h.deps(BASE_FLAGS(h), { interactive: false, env: EXISTING_ENV(h) }));
    expect(code).toBe(0);
    expect(await readFile(join(h.target, ".env"), "utf8")).toContain("ADMIN_PASSWORD=");
    expect(h.all()).toContain("ADMIN_EMAIL=...");
  });
});
