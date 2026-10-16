import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import { generateSecret } from "./secrets.js";
import { validatePassword, type Check } from "./validate.js";

/** The only code that touches the terminal. Tests pass a scripted implementation. */
export interface PromptIo {
  /** False when stdin or stdout is not a terminal: the prompter then never asks anything. */
  readonly interactive: boolean;
  write(text: string): void;
  /** One line typed by the user, or `null` at end of input. */
  readLine(prompt: string): Promise<string | null>;
  /** Like `readLine`, but nothing typed is echoed. */
  readSecret(prompt: string): Promise<string | null>;
}

export interface Question<T> {
  /** Name shown when the answer is missing in non-interactive mode, for example `--org`. */
  readonly key: string;
  readonly label: string;
  /** Used when the user just presses Enter, and in non-interactive mode when nothing is given. */
  readonly default?: string;
  /** An answer already supplied by a flag or an environment variable. */
  readonly preset?: string;
  readonly validate: (input: string) => Check<T>;
}

export interface MissingAnswer {
  readonly key: string;
  readonly label: string;
  /** Set when a value was supplied but is not valid. */
  readonly reason?: string;
}

export class MissingAnswersError extends Error {
  readonly missing: readonly MissingAnswer[];
  constructor(missing: readonly MissingAnswer[]) {
    super(
      [
        "Cannot continue without prompting. These answers are missing or invalid:",
        ...missing.map(
          (m) => `  ${m.key}: ${m.label}${m.reason === undefined ? "" : ` (${m.reason})`}`,
        ),
      ].join("\n"),
    );
    this.name = "MissingAnswersError";
    this.missing = missing;
  }
}

export class InputClosedError extends Error {
  constructor() {
    super("Input ended before all questions were answered.");
    this.name = "InputClosedError";
  }
}

export interface PrompterOptions {
  /** `--yes`: never prompt, accept confirmations. */
  readonly assumeYes?: boolean;
}

export interface PasswordQuestion {
  readonly key: string;
  readonly label: string;
  readonly preset?: string;
  /** Lets the user press Enter to get a generated password. */
  readonly offerGenerate?: boolean;
}

export interface PasswordAnswer {
  readonly value: string;
  readonly generated: boolean;
}

export interface Prompter {
  /** True when this prompter may ask. False in non-interactive mode. */
  readonly prompting: boolean;
  /**
   * Resolves to the validated answer. Returns `undefined` only in non-interactive mode, when the
   * answer is missing or invalid: it is then recorded, so one `assertComplete()` lists all of them.
   */
  ask<T>(question: Question<T>): Promise<T | undefined>;
  askPassword(question: PasswordQuestion): Promise<PasswordAnswer | undefined>;
  /** Yes/no. Non-interactive: `true` with `--yes`, otherwise the default. */
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  missing(): readonly MissingAnswer[];
  /** Throws `MissingAnswersError` listing every recorded missing answer at once. */
  assertComplete(): void;
}

export function createPrompter(io: PromptIo, options: PrompterOptions = {}): Prompter {
  const prompting = io.interactive && options.assumeYes !== true;
  const missing: MissingAnswer[] = [];

  async function line(prompt: string): Promise<string> {
    const answer = await io.readLine(prompt);
    if (answer === null) throw new InputClosedError();
    return answer;
  }

  async function secret(prompt: string): Promise<string> {
    const answer = await io.readSecret(prompt);
    if (answer === null) throw new InputClosedError();
    return answer;
  }

  return {
    prompting,

    async ask<T>(q: Question<T>): Promise<T | undefined> {
      if (q.preset !== undefined) {
        const checked = q.validate(q.preset);
        if (checked.ok) return checked.value;
        if (!prompting) {
          missing.push({ key: q.key, label: q.label, reason: checked.reason });
          return undefined;
        }
        io.write(`${q.key}: ${checked.reason}\n`);
      }
      if (!prompting) {
        if (q.default !== undefined) {
          const checked = q.validate(q.default);
          if (checked.ok) return checked.value;
        }
        missing.push({ key: q.key, label: q.label });
        return undefined;
      }
      const suffix = q.default === undefined ? "" : ` [${q.default}]`;
      for (;;) {
        const raw = (await line(`${q.label}${suffix}: `)).trim();
        const input = raw === "" && q.default !== undefined ? q.default : raw;
        const checked = q.validate(input);
        if (checked.ok) return checked.value;
        io.write(`${checked.reason}\n`);
      }
    },

    async askPassword(q: PasswordQuestion): Promise<PasswordAnswer | undefined> {
      if (q.preset !== undefined) {
        const checked = validatePassword(q.preset);
        if (checked.ok) return { value: checked.value, generated: false };
        if (!prompting) {
          missing.push({ key: q.key, label: q.label, reason: checked.reason });
          return undefined;
        }
        io.write(`${q.key}: ${checked.reason}\n`);
      }
      if (!prompting) {
        if (q.offerGenerate === true) return { value: generateSecret(), generated: true };
        missing.push({ key: q.key, label: q.label });
        return undefined;
      }
      const hint = q.offerGenerate === true ? " (press Enter to generate a strong one)" : "";
      for (;;) {
        const first = await secret(`${q.label}${hint}: `);
        if (first === "" && q.offerGenerate === true) {
          return { value: generateSecret(), generated: true };
        }
        const checked = validatePassword(first);
        if (!checked.ok) {
          io.write(`${checked.reason}\n`);
          continue;
        }
        const second = await secret(`${q.label} (repeat): `);
        if (second !== first) {
          io.write("The two passwords do not match. Try again.\n");
          continue;
        }
        return { value: checked.value, generated: false };
      }
    },

    async confirm(question: string, defaultValue = false): Promise<boolean> {
      if (options.assumeYes === true) return true;
      if (!prompting) return defaultValue;
      const hint = defaultValue ? "[Y/n]" : "[y/N]";
      for (;;) {
        const answer = (await line(`${question} ${hint} `)).trim().toLowerCase();
        if (answer === "") return defaultValue;
        if (answer === "y" || answer === "yes") return true;
        if (answer === "n" || answer === "no") return false;
        io.write("Please answer y or n.\n");
      }
    },

    missing: () => [...missing],

    assertComplete(): void {
      if (missing.length > 0) throw new MissingAnswersError(missing);
    },
  };
}

export interface TerminalIo extends PromptIo {
  close(): void;
}

/**
 * The real terminal. Outside a terminal it does not create a readline interface at all, so
 * nothing can read from a pipe by accident. Hidden entry swallows the echo of typed characters.
 */
export function createTerminalIo(
  input: Readable & { isTTY?: boolean } = process.stdin,
  output: Writable & { isTTY?: boolean } = process.stdout,
): TerminalIo {
  const interactive = input.isTTY === true && output.isTTY === true;
  let muted = false;
  const gate = {
    write(chunk: string | Uint8Array, ...rest: unknown[]): boolean {
      if (muted) return true;
      return (output.write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    },
  };
  const rl = interactive
    ? createInterface({ input, output: gate as unknown as Writable, terminal: true })
    : null;

  async function read(prompt: string, hide: boolean): Promise<string | null> {
    if (rl === null) return null;
    output.write(prompt);
    muted = hide;
    try {
      const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
      return await Promise.race([rl.question(""), closed]);
    } catch {
      return null;
    } finally {
      muted = false;
      if (hide) output.write("\n");
    }
  }

  return {
    interactive,
    write: (text) => void output.write(text),
    readLine: (prompt) => read(prompt, false),
    readSecret: (prompt) => read(prompt, true),
    close: () => rl?.close(),
  };
}
