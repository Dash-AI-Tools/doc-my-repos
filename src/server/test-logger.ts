import { inspect } from "node:util";

import { createLogger, type Logger, type LogLevel } from "./log";

/** A log record as written: the parsed JSON line. */
export type LogRecord = Record<string, unknown> & { level: LogLevel; event: string };

export interface RecordingLogger {
  /** A real logger (same formatting and redaction) whose lines are kept in memory. */
  readonly log: Logger;
  /** Every line written, parsed (a fresh array on each read). */
  readonly records: LogRecord[];
  /** Every line written, raw (with the trailing newline). */
  readonly lines: string[];
  /** The event names in order. */
  events(): string[];
  /** Records of one event. */
  find(event: string): LogRecord[];
}

/** A record without its time, level and service: what a test compares. */
export function recordFields(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy.ts;
  delete copy.level;
  delete copy.service;
  return copy;
}

/** A record as `event key=value ...` (no time, level or service), for readable assertions. */
export function renderRecord(record: Record<string, unknown>): string {
  const { event, ...fields } = recordFields(record);
  return [String(event), ...Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`)].join(" ");
}

/** For tests: a logger at `debug` that records instead of writing to the process streams. */
export function recordingLogger(): RecordingLogger {
  const lines: string[] = [];
  const log = createLogger({ level: "debug", write: (line) => lines.push(line) });
  // Parsed on read, so a test that spies on `JSON.parse` sees no calls from logging.
  const parse = () => lines.map((line) => JSON.parse(line) as LogRecord);
  return {
    log,
    get records() {
      return parse();
    },
    lines,
    events: () => parse().map((r) => r.event),
    find: (event) => parse().filter((r) => r.event === event),
  };
}

export interface CapturedOutput {
  /** Everything written to stdout, stderr and the console since `captureOutput()`, as one text. */
  text(): string;
  /** The JSON log lines written to stdout and stderr, parsed (other output is skipped). */
  records(): LogRecord[];
  restore(): void;
}

type Write = typeof process.stdout.write;

/**
 * For tests: captures (and silences) every write to `process.stdout`, `process.stderr` and every
 * `console` method, so a test can assert what the default logger, or anything else, printed.
 * Sets `LOG_LEVEL` to `level` (default `debug`, the most output) until `restore()`; the test
 * configuration runs with `LOG_LEVEL=silent` otherwise.
 */
export function captureOutput(level = "debug"): CapturedOutput {
  const chunks: string[] = [];
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const toText = (chunk: unknown): string =>
    typeof chunk === "string"
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk).toString("utf8")
        : String(chunk);
  const originals = { out: process.stdout.write, err: process.stderr.write };
  const fake = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(toText(chunk));
    const callback = rest.find((r) => typeof r === "function") as (() => void) | undefined;
    callback?.();
    return true;
  }) as Write;
  process.stdout.write = fake;
  process.stderr.write = fake;
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const consoleOriginals = methods.map((m) => [m, console[m]] as const);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      // `inspect` shows what the real console would print, including error messages.
      chunks.push(`${args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ")}\n`);
    };
  }
  return {
    text: () => chunks.join(""),
    records: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as LogRecord];
          } catch {
            return [];
          }
        }),
    restore: () => {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
      process.stdout.write = originals.out;
      process.stderr.write = originals.err;
      for (const [m, fn] of consoleOriginals) console[m] = fn;
    },
  };
}
