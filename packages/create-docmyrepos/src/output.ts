import type { PlannedFile } from "./plan.js";
import type { PromptIo } from "./prompts.js";

/** Exit code scheme. */
export const EXIT = { OK: 0, FAILURE: 1, USAGE: 2, INTERRUPT: 130 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const HIDDEN = "[hidden]";

/** Shapes of credentials that are masked even when the value was never registered. */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

/** Smallest value worth registering; shorter strings would mangle ordinary words. */
const MIN_REGISTERED = 8;

export interface Redactor {
  /** Registers a secret (and the forms it can be printed in). Ignores empty and very short values. */
  add(secret: string | undefined): void;
  /** The text with every registered secret and every credential-shaped span replaced. */
  apply(text: string): string;
}

export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  let ordered: string[] = [];

  const register = (value: string): void => {
    if (value.length >= MIN_REGISTERED && !secrets.has(value)) {
      secrets.add(value);
      ordered = [...secrets].sort((a, b) => b.length - a.length);
    }
  };

  return {
    add(secret) {
      if (secret === undefined) return;
      const trimmed = secret.trim();
      register(secret);
      register(trimmed);
      // A multi-line value (a PEM key): its escaped form and each long line are secret too.
      if (trimmed.includes("\n")) {
        register(trimmed.replace(/\r?\n/g, "\\n"));
        for (const line of trimmed.split(/\r?\n/)) {
          if (line.length >= 16 && !line.startsWith("-----")) register(line.trim());
        }
      }
      // Forms a secret takes when quoted in JSON or a URL.
      register(encodeURIComponent(trimmed));
    },
    apply(text) {
      let result = text;
      for (const secret of ordered) result = result.split(secret).join(HIDDEN);
      for (const shape of CREDENTIAL_SHAPES) {
        result = result.replace(shape, (_all, scheme: unknown) =>
          typeof scheme === "string" ? `${scheme} ${HIDDEN}` : HIDDEN,
        );
      }
      return result;
    },
  };
}

/** The terminal I/O with every prompt and message passed through the redactor. */
export function redactingIo(io: PromptIo, redactor: Redactor): PromptIo {
  return {
    interactive: io.interactive,
    write: (text) => io.write(redactor.apply(text)),
    readLine: (prompt) => io.readLine(redactor.apply(prompt)),
    readSecret: (prompt) => io.readSecret(redactor.apply(prompt)),
  };
}

export interface Output {
  readonly redactor: Redactor;
  /** A numbered progress line, "Step 3: ...". */
  step(text: string): void;
  info(text: string): void;
  /** Indented detail under the previous line. */
  detail(text: string): void;
  blank(): void;
  warn(text: string): void;
  error(text: string): void;
  /**
   * Prints a value exactly once, unredacted: the generated admin password. The value stays
   * registered, so any other line that contains it is still masked.
   */
  revealOnce(label: string, value: string): void;
}

export interface OutputSinks {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export function createOutput(sinks: OutputSinks, redactor: Redactor = createRedactor()): Output {
  let steps = 0;
  let revealed = false;
  const out = (text: string): void => sinks.stdout(`${redactor.apply(text)}\n`);
  const err = (text: string): void => sinks.stderr(`${redactor.apply(text)}\n`);
  return {
    redactor,
    step(text) {
      steps += 1;
      out(`\nStep ${steps}: ${text}`);
    },
    info: out,
    detail: (text) => out(`  ${text}`),
    blank: () => sinks.stdout("\n"),
    warn: (text) => err(`Warning: ${text}`),
    error: (text) => err(`Error: ${text}`),
    revealOnce(label, value) {
      if (revealed) throw new Error("A value was already revealed in this run.");
      revealed = true;
      // The one deliberate bypass of the redaction pass.
      sinks.stdout(`  ${label}: ${value}\n`);
    },
  };
}

const FILE_PURPOSE: Readonly<Record<string, string>> = {
  "docker-compose.yml": "runs the app and Postgres (hardened, image pinned to a version)",
  ".env": "settings and generated secrets",
  "docmyrepos.config.yml": "which repositories to sync",
  ".gitignore": "keeps .env and key files out of git",
  "github-app.private-key.pem": "the GitHub App private key (mounted as a compose secret)",
};

export type FileSummaryItem = Pick<PlannedFile, "path" | "mode" | "secret">;

const modeText = (mode: number): string => mode.toString(8).padStart(4, "0");

/** The fixed summary of what will be written. It never includes file contents. */
export function summarizeFiles(
  dir: string,
  files: readonly FileSummaryItem[],
  keyLayoutNote?: string,
): string[] {
  const lines = [`These files will be written to ${dir}:`];
  for (const file of files) {
    const purpose = FILE_PURPOSE[file.path] ?? "";
    lines.push(
      `  ${file.path.padEnd(28)} mode ${modeText(file.mode)}${file.secret ? "  (secret)" : "          "}  ${purpose}`.trimEnd(),
    );
  }
  if (keyLayoutNote !== undefined) lines.push(keyLayoutNote);
  return lines;
}
