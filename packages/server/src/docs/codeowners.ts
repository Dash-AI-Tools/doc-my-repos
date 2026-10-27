import type { CodeOwnerRef } from "../db/schema";
import { stripNul, toWellFormed } from "./frontmatter";

/**
 * One CODEOWNERS rule. The stored `code_owners` row is `pattern`, `owners` and the rule's index
 * in `ParsedCodeowners.rules` as `position`; `line` is for diagnostics and is not persisted.
 */
export interface CodeownersRule {
  /** 1-based line number in the file (after BOM removal; the first line is 1). */
  readonly line: number;
  /**
   * The pattern exactly as written, escape sequences kept (`\#foo`, `my\ file.md`), so a later
   * consumer can tell `\*` from `*`. Never blank, never contains unescaped whitespace.
   */
  readonly pattern: string;
  /**
   * Owners in the order written, handles as written (`@alice`, `@my-org/docs-team`,
   * `dev@example.com`; case kept, so group case-insensitively at read time). Empty for a pattern
   * with no owners, which is valid and means "no owner" for that pattern.
   */
  readonly owners: readonly CodeOwnerRef[];
}

export interface ParsedCodeowners {
  /**
   * Rules in file order. Order is meaningful: GitHub uses the LAST rule whose pattern matches a
   * path, so a later rule overrides an earlier one. No per-file resolution is offered here:
   * design decision 12 shows rules as declared and does not compute per-file ownership.
   */
  readonly rules: readonly CodeownersRule[];
  /** Fixed-text diagnostics with a line number, never quoting the file. For `sync_runs.results`. */
  readonly warnings: readonly string[];
}

/** GitHub ignores a CODEOWNERS file over 3 MB; so do we (UTF-8 bytes, no rules returned). */
export const MAX_CODEOWNERS_BYTES = 3 * 1024 * 1024;

/** A non-comment line longer than this is skipped. Far above any real rule. */
export const MAX_CODEOWNERS_LINE_CHARS = 4096;

/** Rules past this are dropped. */
export const MAX_CODEOWNERS_RULES = 10_000;

/** Owners past this on one line skip the line. */
export const MAX_OWNERS_PER_RULE = 100;

/** Warnings kept; the rest are summarised in one final entry. */
export const MAX_CODEOWNERS_WARNINGS = 20;

// GitHub user names are alphanumerics and hyphens, at most 39 chars. Enterprise Managed User
// names also carry `_`, so that is allowed. Case is kept.
const USER = /^@[A-Za-z0-9_][A-Za-z0-9_-]{0,38}$/;
// `@org/team-slug`: org as a user name, team slugs are alphanumerics, `-`, `_` and `.`.
const TEAM = /^@[A-Za-z0-9_][A-Za-z0-9_-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
// Deliberately loose, as GitHub's own check is: one `@`, a dot in the domain, no whitespace.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LINE_BREAK = /\r\n|\r|\n/;

/** Classifies one owner token, or null when it is not valid owner syntax. */
export function parseOwner(token: string): CodeOwnerRef | null {
  if (token.length > 200) return null;
  if (USER.test(token)) return { handle: token, kind: "user" };
  if (TEAM.test(token)) return { handle: token, kind: "team" };
  if (EMAIL.test(token)) return { handle: token, kind: "email" };
  return null;
}

type Tokens = { ok: true; tokens: string[] } | { ok: false };

function isBlank(ch: string): boolean {
  return ch === " " || ch === "\t";
}

/**
 * Splits a line on unescaped spaces and tabs. In the first token (the pattern) a backslash
 * escapes the next character, so `\ ` keeps a space inside the pattern and `\#` is a literal
 * `#`. A token that starts with an unescaped `#` begins a comment: the rest of the line is
 * dropped. A pattern that ends in a lone backslash is malformed. Linear in the line length.
 */
function tokenize(line: string): Tokens {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (isBlank(line.charAt(i))) {
      i++;
      continue;
    }
    if (line.charAt(i) === "#") break;
    const start = i;
    const first = tokens.length === 0;
    while (i < line.length && !isBlank(line.charAt(i))) {
      if (first && line.charAt(i) === "\\") {
        if (i + 1 >= line.length) return { ok: false };
        i += 2;
      } else {
        i++;
      }
    }
    tokens.push(line.slice(start, i));
  }
  return { ok: true, tokens };
}

/** Constructs GitHub documents as unsupported; the rule is kept as declared, with a warning. */
function hasUnsupportedSyntax(pattern: string): boolean {
  if (pattern.startsWith("!")) return true;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === "\\") i++;
    else if (ch === "[" || ch === "]" || ch === "{" || ch === "}") return true;
  }
  return false;
}

/**
 * Parses a CODEOWNERS file as GitHub does. Pure; never throws; the input is untrusted.
 *
 * Syntax handled:
 * - Blank lines and `#` comments, on their own line or after the owners. `#` starts a comment
 *   only at the start of a token, so `a#b` is part of a pattern; `\#` escapes it.
 * - `pattern owner...`, separated by spaces or tabs; `\ ` keeps a space inside the pattern.
 * - Owners are `@user`, `@org/team` or an email address. A pattern with no owner is a valid rule
 *   with an empty owner list (it unsets ownership for that pattern).
 * - A line with an invalid owner is skipped entirely, as GitHub does, with a warning. Keeping the
 *   valid owners would be wrong: the rule would own paths for a different set of people than the
 *   file says, and an all-invalid line would turn into "no owner".
 * - LF, CRLF and CR line endings, and a leading BOM. NULs are stripped and lone surrogates
 *   replaced, since Postgres text rejects both.
 * - GitLab-style `[Section]` headers are not a GitHub feature. A line such as `[Docs] @a` is an
 *   ordinary pattern (and gets the unsupported-syntax warning), and `[Docs]` alone is a rule
 *   with no owners.
 * - Patterns GitHub does not support (a leading `!`, `[ ]` ranges, `{ }`) are kept as declared
 *   with a warning.
 *
 * Limits: see the `MAX_CODEOWNERS_*` constants. A file over the byte cap yields no rules.
 */
export function parseCodeowners(source: string): ParsedCodeowners {
  const rules: CodeownersRule[] = [];
  const warnings: string[] = [];
  let omitted = 0;
  const warn = (line: number, message: string): void => {
    if (warnings.length < MAX_CODEOWNERS_WARNINGS)
      warnings.push(`CODEOWNERS line ${line}: ${message}`);
    else omitted++;
  };
  const finish = (): ParsedCodeowners => {
    if (omitted > 0) warnings.push(`CODEOWNERS: ${omitted} further warnings omitted`);
    return { rules, warnings };
  };

  if (Buffer.byteLength(source, "utf8") > MAX_CODEOWNERS_BYTES) {
    return {
      rules,
      warnings: [`CODEOWNERS ignored: file is larger than ${MAX_CODEOWNERS_BYTES} bytes`],
    };
  }

  let text = toWellFormed(stripNul(source));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = text.split(LINE_BREAK);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const number = index + 1;

    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    if (line.length > MAX_CODEOWNERS_LINE_CHARS) {
      warn(number, "line is too long, skipped");
      continue;
    }

    const split = tokenize(line);
    if (!split.ok) {
      warn(number, "pattern ends in a lone backslash, line skipped");
      continue;
    }
    const [pattern, ...ownerTokens] = split.tokens;
    if (pattern === undefined) continue; // only a trailing comment, e.g. a tab before `#`

    if (ownerTokens.length > MAX_OWNERS_PER_RULE) {
      warn(number, "too many owners, line skipped");
      continue;
    }
    const owners: CodeOwnerRef[] = [];
    let valid = true;
    for (const token of ownerTokens) {
      const owner = parseOwner(token);
      if (owner === null) {
        valid = false;
        break;
      }
      owners.push(owner);
    }
    if (!valid) {
      warn(number, "invalid owner, line skipped");
      continue;
    }

    if (rules.length >= MAX_CODEOWNERS_RULES) {
      warn(number, `more than ${MAX_CODEOWNERS_RULES} rules, the rest are ignored`);
      break;
    }
    if (hasUnsupportedSyntax(pattern)) warn(number, "pattern uses syntax GitHub does not support");
    rules.push({ line: number, pattern, owners });
  }
  return finish();
}
