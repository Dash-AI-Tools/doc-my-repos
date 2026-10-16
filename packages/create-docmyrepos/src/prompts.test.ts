import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createPrompter,
  createTerminalIo,
  InputClosedError,
  MissingAnswersError,
  type PromptIo,
} from "./prompts.js";
import { validateEmail, validateOrganization, validatePort } from "./validate.js";

interface Scripted extends PromptIo {
  readonly output: string[];
  readonly prompts: string[];
  readonly secretPrompts: string[];
  lineCalls: number;
}

function scripted(lines: string[], secrets: string[] = [], interactive = true): Scripted {
  const output: string[] = [];
  const prompts: string[] = [];
  const secretPrompts: string[] = [];
  const io: Scripted = {
    interactive,
    output,
    prompts,
    secretPrompts,
    lineCalls: 0,
    write: (text) => void output.push(text),
    readLine: async (prompt) => {
      io.lineCalls += 1;
      prompts.push(prompt);
      return lines.shift() ?? null;
    },
    readSecret: async (prompt) => {
      secretPrompts.push(prompt);
      return secrets.shift() ?? null;
    },
  };
  return io;
}

const org = { key: "--org", label: "GitHub organization", validate: validateOrganization };

describe("ask", () => {
  it("shows the default and accepts it on Enter", async () => {
    const io = scripted([""]);
    const port = await createPrompter(io).ask({
      key: "--port",
      label: "Port",
      default: "3000",
      validate: validatePort,
    });
    expect(port).toBe(3000);
    expect(io.prompts).toEqual(["Port [3000]: "]);
  });

  it("explains a rejection and asks again until the answer is valid", async () => {
    const io = scripted(["admin@", "  ", "admin@example.com"]);
    const email = await createPrompter(io).ask({
      key: "--admin-email",
      label: "Admin email",
      validate: validateEmail,
    });
    expect(email).toBe("admin@example.com");
    expect(io.lineCalls).toBe(3);
    expect(io.output.join("")).toContain("not a valid email");
  });

  it("uses a valid preset without asking, and asks when the preset is invalid", async () => {
    const io = scripted(["acme"]);
    const prompter = createPrompter(io);
    expect(await prompter.ask({ ...org, preset: "ok-org" })).toBe("ok-org");
    expect(io.lineCalls).toBe(0);
    expect(await prompter.ask({ ...org, preset: "-bad" })).toBe("acme");
    expect(io.output.join("")).toContain("--org:");
  });

  it("throws when the input ends", async () => {
    await expect(createPrompter(scripted([])).ask(org)).rejects.toBeInstanceOf(InputClosedError);
  });
});

describe("askPassword", () => {
  it("asks twice, with hidden entry, and never echoes it", async () => {
    const io = scripted([], ["correct horse battery", "correct horse battery"]);
    const answer = await createPrompter(io).askPassword({ key: "p", label: "Admin password" });
    expect(answer).toEqual({ value: "correct horse battery", generated: false });
    expect(io.secretPrompts).toHaveLength(2);
    expect(io.lineCalls).toBe(0);
    expect(io.output.join("")).not.toContain("correct horse");
    expect([...io.prompts, ...io.secretPrompts].join("")).not.toContain("correct horse");
  });

  it("restarts after a mismatch and after a short password", async () => {
    const io = scripted(
      [],
      ["short", "first-password-1", "other-password-2", "good-password-123", "good-password-123"],
    );
    const answer = await createPrompter(io).askPassword({ key: "p", label: "Admin password" });
    expect(answer?.value).toBe("good-password-123");
    const text = io.output.join("");
    expect(text).toContain("at least 12 characters");
    expect(text).toContain("do not match");
    expect(text).not.toContain("first-password-1");
  });

  it("generates a strong password on Enter when offered", async () => {
    const io = scripted([], [""]);
    const answer = await createPrompter(io).askPassword({
      key: "p",
      label: "Admin password",
      offerGenerate: true,
    });
    expect(answer?.generated).toBe(true);
    expect(answer?.value.length).toBeGreaterThanOrEqual(12);
    expect(io.output.join("")).not.toContain(answer?.value ?? "unreachable");
  });

  it("rejects an invalid preset in non-interactive mode", async () => {
    const prompter = createPrompter(scripted([], [], false));
    expect(
      await prompter.askPassword({ key: "DOCMYREPOS_ADMIN_PASSWORD", label: "p", preset: "short" }),
    ).toBeUndefined();
    expect(prompter.missing()[0]?.reason).toContain("12 characters");
  });
});

describe("confirm", () => {
  it("honors y, yes, n, no, defaults and re-asks on nonsense", async () => {
    const io = scripted(["maybe", "Y", "", "no", "", ""]);
    const prompter = createPrompter(io);
    expect(await prompter.confirm("Go?")).toBe(true);
    expect(io.output.join("")).toContain("answer y or n");
    expect(await prompter.confirm("Go?")).toBe(false);
    expect(await prompter.confirm("Go?")).toBe(false);
    expect(await prompter.confirm("Go?", true)).toBe(true);
    expect(io.prompts[0]).toBe("Go? [y/N] ");
  });

  it("does not prompt without a terminal: default, or yes with --yes", async () => {
    const io = scripted([], [], false);
    expect(await createPrompter(io).confirm("Go?")).toBe(false);
    expect(await createPrompter(io, { assumeYes: true }).confirm("Go?")).toBe(true);
    expect(io.lineCalls).toBe(0);
  });
});

describe("non-interactive mode", () => {
  it("never prompts and lists every missing answer at once", async () => {
    const io = scripted(["should-not-be-read"], ["nor-this"], false);
    const prompter = createPrompter(io);
    expect(await prompter.ask(org)).toBeUndefined();
    expect(
      await prompter.ask({ key: "--admin-email", label: "Admin email", validate: validateEmail }),
    ).toBeUndefined();
    expect(
      await prompter.ask({ key: "--port", label: "Port", default: "3000", validate: validatePort }),
    ).toBe(3000);
    expect(
      await prompter.askPassword({ key: "DOCMYREPOS_ADMIN_PASSWORD", label: "Admin password" }),
    ).toBeUndefined();
    expect(io.lineCalls).toBe(0);
    expect(io.secretPrompts).toHaveLength(0);
    expect(prompter.missing().map((m) => m.key)).toEqual([
      "--org",
      "--admin-email",
      "DOCMYREPOS_ADMIN_PASSWORD",
    ]);
    try {
      prompter.assertComplete();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MissingAnswersError);
      const message = (error as Error).message;
      expect(message).toContain("--org");
      expect(message).toContain("--admin-email");
      expect(message).toContain("DOCMYREPOS_ADMIN_PASSWORD");
    }
  });

  it("treats --yes on a terminal as non-interactive", async () => {
    const io = scripted(["x"], [], true);
    const prompter = createPrompter(io, { assumeYes: true });
    expect(prompter.prompting).toBe(false);
    expect(await prompter.ask(org)).toBeUndefined();
    expect(io.lineCalls).toBe(0);
  });

  it("can generate the admin password when allowed", async () => {
    const prompter = createPrompter(scripted([], [], false));
    const answer = await prompter.askPassword({ key: "p", label: "p", offerGenerate: true });
    expect(answer?.generated).toBe(true);
    prompter.assertComplete();
  });
});

describe("createTerminalIo", () => {
  it("does not read from a pipe", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = createTerminalIo(input, output);
    expect(io.interactive).toBe(false);
    input.write("secret\n");
    expect(await io.readLine("q: ")).toBeNull();
    expect(await io.readSecret("q: ")).toBeNull();
    io.close();
  });
});
