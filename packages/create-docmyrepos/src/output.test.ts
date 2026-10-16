import { describe, expect, it } from "vitest";

import { createOutput, createRedactor, redactingIo, summarizeFiles } from "./output.js";
import type { PromptIo } from "./prompts.js";
import { generateSecret } from "./secrets.js";
import { rsaPem } from "./test-support.js";

describe("redactor", () => {
  it("masks registered secrets wherever they appear", () => {
    const r = createRedactor();
    const secret = generateSecret();
    r.add(secret);
    expect(r.apply(`a ${secret} b ${secret}`)).toBe("a [hidden] b [hidden]");
    expect(r.apply(`url?x=${encodeURIComponent(secret)}`)).not.toContain(secret);
  });

  it("masks a PEM key, its escaped form and its body lines", () => {
    const r = createRedactor();
    const pem = rsaPem();
    r.add(pem);
    const body = pem.split("\n")[2] ?? "";
    expect(r.apply(`key: ${pem}`)).not.toContain(body);
    expect(r.apply(`key: ${pem.trim().replace(/\n/g, "\\n")}`)).not.toContain(body);
    expect(r.apply(`only a line: ${body}`)).not.toContain(body);
  });

  it("masks credential shapes that were never registered", () => {
    const r = createRedactor();
    const text = [
      "token ghs_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0123456789_abcdefghijk",
      "Authorization: Bearer abcdefghijklmnopqrstuvwx",
      `jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2ln`,
      `-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----`,
    ].join("\n");
    const result = r.apply(text);
    expect(result).not.toMatch(/ghs_|github_pat_|abcdefghijklmnopqrstuvwx|eyJ|PRIVATE KEY|MIIB/);
    expect(result).toContain("[hidden]");
  });

  it("leaves ordinary text, addresses and short values alone", () => {
    const r = createRedactor();
    r.add("short");
    const text = "Open http://127.0.0.1:3000/start?t=abc and short words";
    expect(r.apply(text)).toBe(text);
  });
});

describe("output", () => {
  function capture() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const out = createOutput({
      stdout: (t) => void stdout.push(t),
      stderr: (t) => void stderr.push(t),
    });
    return { out, stdout, stderr };
  }

  it("numbers steps and sends warnings and errors to stderr", () => {
    const { out, stdout, stderr } = capture();
    out.step("Checking");
    out.step("Asking");
    out.warn("careful");
    out.error("broken");
    expect(stdout.join("")).toContain("Step 1: Checking");
    expect(stdout.join("")).toContain("Step 2: Asking");
    expect(stderr.join("")).toBe("Warning: careful\nError: broken\n");
  });

  it("redacts every line, on both streams", () => {
    const { out, stdout, stderr } = capture();
    const secret = generateSecret();
    out.redactor.add(secret);
    out.info(`value ${secret}`);
    out.detail(`value ${secret}`);
    out.warn(`value ${secret}`);
    out.error(`value ${secret}`);
    expect(stdout.join("") + stderr.join("")).not.toContain(secret);
  });

  it("reveals a value once, keeps it masked everywhere else, and refuses a second reveal", () => {
    const { out, stdout } = capture();
    const password = generateSecret();
    out.redactor.add(password);
    out.revealOnce("Password", password);
    out.info(`again ${password}`);
    expect(stdout.join("").split(password)).toHaveLength(2);
    expect(() => out.revealOnce("Password", password)).toThrow();
  });
});

describe("redactingIo", () => {
  it("masks prompts and messages before they reach the terminal", async () => {
    const written: string[] = [];
    const io: PromptIo = {
      interactive: true,
      write: (t) => void written.push(t),
      readLine: async (p) => (written.push(p), null),
      readSecret: async (p) => (written.push(p), null),
    };
    const r = createRedactor();
    const secret = generateSecret();
    r.add(secret);
    const wrapped = redactingIo(io, r);
    wrapped.write(secret);
    await wrapped.readLine(secret);
    await wrapped.readSecret(secret);
    expect(written.join("")).not.toContain(secret);
  });
});

describe("file summary", () => {
  it("lists path, mode and purpose and never any content", () => {
    const lines = summarizeFiles("/x/y", [
      { path: ".env", mode: 0o600, secret: true },
      { path: "docker-compose.yml", mode: 0o644, secret: false },
    ]);
    expect(lines[0]).toBe("These files will be written to /x/y:");
    expect(lines[1]).toContain("mode 0600");
    expect(lines[1]).toContain("(secret)");
    expect(lines[2]).toContain("docker-compose.yml");
  });
});
