import { describe, expect, it } from "vitest";

import { ENV_VARS, EXIT_CODES, FLAGS, helpText, parseCommandLine, UsageError } from "./args.js";

describe("help text", () => {
  const help = helpText("1.2.3");

  it("lists every flag of the parser's table, with its short form and value", () => {
    for (const flag of FLAGS) {
      expect(help, flag.name).toContain(`--${flag.name}`);
      if (flag.short !== undefined) expect(help).toContain(`-${flag.short},`);
      if (flag.value !== undefined) expect(help).toContain(`--${flag.name} ${flag.value}`);
    }
  });

  it("lists every environment variable and exit code", () => {
    for (const env of ENV_VARS) expect(help).toContain(env.name);
    for (const exit of EXIT_CODES) expect(help).toContain(`${exit.code} `);
  });

  it("states the version and that nothing is sent anywhere but GitHub", () => {
    expect(help).toContain("create-docmyrepos 1.2.3");
    expect(help).toContain("no telemetry");
  });

  it("has no flag that could take a secret", () => {
    for (const flag of FLAGS) expect(flag.name).not.toMatch(/password|secret|key|token/);
    expect(ENV_VARS.map((e) => e.name)).toContain("DOCMYREPOS_ADMIN_PASSWORD");
  });

  it("covers the flags the design names", () => {
    const names = FLAGS.map((f) => f.name);
    for (const name of [
      "dry-run",
      "no-start",
      "force",
      "yes",
      "dir",
      "image-tag",
      "org",
      "url",
      "port",
      "admin-email",
      "repos",
      "app",
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe("parseCommandLine", () => {
  it("reads flags, short flags and the positional folder", () => {
    const o = parseCommandLine(["site", "-y", "--org", "acme", "--dry-run", "--port=3100"]);
    expect(o).toMatchObject({ dir: "site", yes: true, org: "acme", dryRun: true, port: "3100" });
    expect(parseCommandLine(["-h"]).help).toBe(true);
    expect(parseCommandLine(["-v"]).version).toBe(true);
  });

  it("accepts the folder as --dir", () => {
    expect(parseCommandLine(["--dir", "x"]).dir).toBe("x");
    expect(parseCommandLine(["x", "--dir", "x"]).dir).toBe("x");
  });

  it.each([[["--nope"]], [["--org"]], [["a", "b"]], [["a", "--dir", "b"]], [["--yes=1"]]])(
    "rejects %j as a usage error",
    (argv) => {
      expect(() => parseCommandLine(argv)).toThrow(UsageError);
    },
  );

  it("does not repeat an unknown option's value in the error", () => {
    try {
      parseCommandLine(["--admin-password=hunter2hunter2"]);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2");
    }
  });
});
