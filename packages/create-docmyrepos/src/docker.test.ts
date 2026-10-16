import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import {
  checkCompose,
  checkDaemon,
  checkDocker,
  checkPortFree,
  composeLogTail,
  composePull,
  composeUp,
  parseVersion,
  pollHealth,
  preflight,
  spawnRunner,
  type RunResult,
  type Runner,
} from "./docker.js";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const bad = (stderr = "", code = 1): RunResult => ({ code, stdout: "", stderr, timedOut: false });
const missing: RunResult = {
  code: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  spawnError: "ENOENT",
};

interface Call {
  command: string;
  args: readonly string[];
  cwd?: string;
}

function fakeRunner(handler: (args: readonly string[]) => RunResult): {
  run: Runner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: Runner = async (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options?.cwd });
    return handler(args);
  };
  return { run, calls };
}

const healthy = (args: readonly string[]): RunResult =>
  args[0] === "--version"
    ? ok("Docker version 27.0.0")
    : args[1] === "version"
      ? ok("2.29.1\n")
      : ok("27.0.0");

describe("version parsing", () => {
  it("reads the numbers out of decorated versions", () => {
    expect(parseVersion("v2.29.1-desktop.1")).toEqual([2, 29, 1]);
    expect(parseVersion("nothing")).toBeNull();
  });
});

describe("checks", () => {
  it("reports Docker missing, with the install link", async () => {
    const { run } = fakeRunner(() => missing);
    const result = await checkDocker(run);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.check).toBe("docker");
      expect(result.problem.fix).toContain("docs.docker.com");
    }
  });

  it("reports Compose missing and too old, and accepts v2 with --wait support flags", async () => {
    const none = await checkCompose(fakeRunner(() => bad("unknown command")).run);
    expect(none.ok).toBe(false);
    const v1 = await checkCompose(fakeRunner(() => ok("1.29.2")).run);
    expect(v1.ok).toBe(false);
    if (!v1.ok) expect(v1.problem.message).toContain("1.29.2");
    const mid = await checkCompose(fakeRunner(() => ok("2.10.0")).run);
    expect(mid).toEqual({ ok: true, value: { version: "2.10.0", waitSupported: false } });
    const modern = await checkCompose(fakeRunner(() => ok("v2.29.1")).run);
    expect(modern).toEqual({ ok: true, value: { version: "2.29.1", waitSupported: true } });
  });

  it("reports an unreachable daemon and a daemon timeout", async () => {
    const down = await checkDaemon(
      fakeRunner(() => bad("Cannot connect to the Docker daemon")).run,
    );
    expect(down.ok).toBe(false);
    if (!down.ok) {
      expect(down.problem.message).toContain("daemon");
      expect(down.problem.fix).toContain("Start Docker");
    }
    const slow = await checkDaemon(
      fakeRunner(() => ({ code: null, stdout: "", stderr: "", timedOut: true })).run,
    );
    expect(slow.ok).toBe(false);
    expect(await checkDaemon(fakeRunner(() => ok("27.0.0")).run)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("finds a taken loopback port and a free one", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const taken = await checkPortFree(port);
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.problem.message).toContain(String(port));
    await new Promise<void>((r) => server.close(() => r()));
    expect((await checkPortFree(port)).ok).toBe(true);
  });

  it("preflight reports every problem and skips Docker-dependent checks when Docker is missing", async () => {
    const portBusy = async () => ({
      ok: false as const,
      problem: { check: "port" as const, message: "busy", fix: "x" },
    });
    const none = fakeRunner(() => missing);
    const a = await preflight(none.run, 3000, portBusy);
    expect(a.problems.map((p) => p.check)).toEqual(["docker", "port"]);
    expect(none.calls).toHaveLength(1);

    const down = fakeRunner((args) => (args[0] === "info" ? bad() : healthy(args)));
    const b = await preflight(down.run, 3000, portBusy);
    expect(b.problems.map((p) => p.check)).toEqual(["daemon", "port"]);

    const fine = fakeRunner(healthy);
    const c = await preflight(fine.run, 3000, async () => ({ ok: true, value: undefined }));
    expect(c.problems).toEqual([]);
    expect(c.compose?.waitSupported).toBe(true);
  });
});

describe("compose steps", () => {
  const dir = "/tmp/install";

  it("pulls, and explains a failed pull", async () => {
    const good = fakeRunner(() => ok());
    expect((await composePull(good.run, dir)).ok).toBe(true);
    expect(good.calls[0]).toEqual({ command: "docker", args: ["compose", "pull"], cwd: dir });
    const failed = await composePull(fakeRunner(() => bad("denied")).run, dir);
    expect(failed.ok).toBe(false);
    expect(failed.step).toBe("pull");
  });

  it("starts with --wait and a bounded wait", async () => {
    const { run, calls } = fakeRunner(() => ok());
    const outcome = await composeUp(run, dir, { port: 3000, waitSupported: true });
    expect(outcome.ok).toBe(true);
    expect(calls[0]?.args).toEqual(["compose", "up", "-d", "--wait", "--wait-timeout", "180"]);
  });

  it("shows the log tail when the start fails", async () => {
    const { run, calls } = fakeRunner((args) =>
      args[1] === "up" ? bad("container unhealthy") : ok("line 1\nline 2\n"),
    );
    const outcome = await composeUp(run, dir, { port: 3000, waitSupported: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.logTail).toBe("line 1\nline 2");
    expect(calls[1]?.args).toEqual(["compose", "logs", "--no-color", "--tail", "30", "app"]);
  });

  it("takes the timeout path with a message and the log tail", async () => {
    const { run } = fakeRunner((args) =>
      args[1] === "up" ? { code: null, stdout: "", stderr: "", timedOut: true } : ok("last words"),
    );
    const outcome = await composeUp(run, dir, { port: 3000, waitSupported: true, waitSeconds: 5 });
    expect(outcome).toMatchObject({ ok: false, step: "health check", logTail: "last words" });
    expect(outcome.message).toContain("5 seconds");
  });

  it("falls back to polling when --wait is unavailable", async () => {
    const { run, calls } = fakeRunner(() => ok());
    let seen = 0;
    const outcome = await composeUp(run, dir, {
      port: 4321,
      waitSupported: false,
      poll: {
        fetch: async (url) => {
          expect(url).toBe("http://127.0.0.1:4321/api/health");
          seen += 1;
          return { status: seen < 3 ? 503 : 200 };
        },
        sleep: async () => {},
      },
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toBe(3);
    expect(calls[0]?.args).toEqual(["compose", "up", "-d"]);
  });

  it("falls back to polling when the flag is rejected by the installed Compose", async () => {
    const { run, calls } = fakeRunner((args) =>
      args.includes("--wait") ? bad("unknown flag: --wait") : ok(),
    );
    const outcome = await composeUp(run, dir, {
      port: 3000,
      waitSupported: true,
      poll: { fetch: async () => ({ status: 200 }), sleep: async () => {} },
    });
    expect(outcome.ok).toBe(true);
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "compose up -d --wait --wait-timeout 180",
      "compose up -d",
    ]);
  });

  it("times out polling and reports the log tail", async () => {
    let t = 0;
    const { run } = fakeRunner((args) => (args[1] === "logs" ? ok("boom") : ok()));
    const outcome = await composeUp(run, dir, {
      port: 3000,
      waitSupported: false,
      waitSeconds: 10,
      poll: {
        fetch: async () => {
          throw new Error("refused");
        },
        sleep: async (ms) => {
          t += ms;
        },
        now: () => t,
        intervalMs: 2000,
      },
    });
    expect(outcome).toMatchObject({ ok: false, step: "health check", logTail: "boom" });
    expect(t).toBeLessThanOrEqual(10_000);
  });

  it("keeps only the last lines and hides credential-looking lines in the tail", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    lines[49] = "GITHUB_APP_PRIVATE_KEY=abcdef123456";
    const { run } = fakeRunner(() => ok(lines.join("\n")));
    const tail = await composeLogTail(run, "/x", 30);
    expect(tail.split("\n")).toHaveLength(30);
    expect(tail).not.toContain("abcdef123456");
    expect(tail).toContain("line 48");
  });

  it("pollHealth stops at the deadline", async () => {
    let t = 0;
    const result = await pollHealth(3000, {
      fetch: async () => ({ status: 500 }),
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      timeoutMs: 6000,
      intervalMs: 2000,
    });
    expect(result).toBe(false);
  });
});

describe("argument arrays", () => {
  it("never contain secrets: only fixed words, the port and the folder", async () => {
    const secret = "S3cretValue_that_must_never_be_an_argument_0123456789";
    const { run, calls } = fakeRunner((args) => (args[1] === "version" ? ok("2.29.1") : ok("27")));
    await preflight(run, 3000, async () => ({ ok: true, value: undefined }));
    await composePull(run, "/dir");
    await composeUp(run, "/dir", { port: 3000, waitSupported: true });
    await composeUp(run, "/dir", {
      port: 3000,
      waitSupported: false,
      poll: { fetch: async () => ({ status: 200 }), sleep: async () => {} },
    });
    for (const call of calls) {
      expect(call.command).toBe("docker");
      expect(call.args.join(" ")).not.toContain(secret);
      for (const arg of call.args) expect(arg).toMatch(/^[\w{}.\-]+$/);
    }
  });
});

describe("spawnRunner", () => {
  it("runs without a shell, so metacharacters stay literal", async () => {
    const result = await spawnRunner(process.execPath, [
      "-e",
      "console.log(process.argv[1])",
      "$(echo hacked); ls",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("$(echo hacked); ls");
  });

  it("reports a missing program and a timeout", async () => {
    const none = await spawnRunner("definitely-not-a-program-xyz", []);
    expect(none.spawnError).toBe("ENOENT");
    const slow = await spawnRunner(process.execPath, ["-e", "setTimeout(()=>{},5000)"], {
      timeoutMs: 100,
    });
    expect(slow.timedOut).toBe(true);
  });

  it("passes secrets through the environment only", async () => {
    const result = await spawnRunner(
      process.execPath,
      ["-e", "console.log(process.env.X_TEST_VALUE)"],
      {
        env: { X_TEST_VALUE: "from-env" },
      },
    );
    expect(result.stdout.trim()).toBe("from-env");
  });
});
