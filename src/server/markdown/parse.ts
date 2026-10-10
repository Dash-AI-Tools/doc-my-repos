import type { Nodes, Parents, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { splitRanges, type ChunkLimits } from "../docs/extract";

/**
 * Parsing that cannot be made to hang by a stored document.
 *
 * remark (micromark) is not linear. Measured on one Apple-silicon laptop, whole-document parsing
 * of 256 KiB takes: 77 s for `> a` plus a blank line repeated (closing quotes re-walks the event
 * list), 4 s for `a` plus `===` repeated, minutes for `*_` soup (inline delimiter matching is
 * quadratic), 2.8 s for 32k task items. Real documents are linear (about 2.5 ms per KiB). Two
 * bounds, both of which leave normal documents untouched:
 *
 *  1. Block level. A document over `WHOLE_PARSE_MAX_CHARS` is cut at the safe points that
 *     `extractMetadata` uses (see `splitRanges`), the pieces are parsed alone, and their trees are
 *     joined under one root, so definitions (links) resolve across pieces and footnote
 *     references get a stub definition so they still resolve. Safe points never fall inside a
 *     fence, raw HTML block, list (list items in column 0 are not safe points) or table. A
 *     stretch that passes the limits without a safe point is parsed whole when it only holds
 *     table rows and list lines ("calm") and is under `CALM_MAX_CHARS`; otherwise it is cut every
 *     `FORCED_LINES` lines (a table or list that long and odd comes out as several) and a line
 *     over `MAX_LINE_CHARS` is cut at whitespace into paragraphs (`guardInline`).
 *  2. Inline level. A run of plain lines (a paragraph), or a single list, table or quote line,
 *     with more than `RUN_DELIMITERS` / `LINE_DELIMITERS` of `* _ [ ] < ~ !` has those characters
 *     backslash-escaped, so it shows as text. 500 delimiters is far above any prose, and costs
 *     about a millisecond to parse even when none of them pair up.
 */

/** Documents up to this size are parsed in one go. Small enough that the worst case is fast. */
export const WHOLE_PARSE_MAX_CHARS = 12 * 1024;

export const RENDER_CHUNK_LIMITS: ChunkLimits = { target: 2048, maxChars: 4096, maxLines: 200 };

/** A stretch of only table rows and list lines is parsed whole up to this size. */
export const CALM_MAX_CHARS = 32 * 1024;
export const FORCED_LINES = 100;
export const MAX_LINE_CHARS = 8 * 1024;
export const RUN_DELIMITERS = 500;
export const LINE_DELIMITERS = 300;
/** Definitions collected from the document, and stubs added to one piece. */
const MAX_STUBS = 256;
/**
 * Syntax tree size. A 256 KiB document of real prose has about 30k nodes; `> a` plus a blank line
 * repeated has 50k blockquotes and renders to 2 MB of HTML. Past this the remaining top-level
 * blocks are left out (with a warning) so rendering stays near a second.
 */
export const MAX_NODES = 60_000;
export const WARNING_TRUNCATED = "the document is too complex and its end was left out";

export const WARNING_DENSE = "some very dense formatting was shown as plain text";
export const WARNING_SPLIT = "some very long blocks were split";

const parser = unified().use(remarkParse).use(remarkGfm);

const DELIMITER = /[*_[\]<~!]/g;
const ESCAPABLE = /[\\*_[\]<~!]/g;
const LIST_START = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
const STRUCTURED_LINE = /^[ \t]*(?:[-*+>|]|\d{1,9}[.)])(?:[ \t]|$)|^[ \t]*\|/;
const CALM_LINE = /^(?:[ \t]*|[ \t]*\|.*|[ \t]{0,8}(?:[-*+]|\d{1,9}[.)])[ \t].*|[ \t]{2,}\S.*)$/;
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^([^\]\s]{1,100})\]:/gm;
const LINK_DEFINITION = /^ {0,3}\[([^\]\n^][^\]\n]{0,199})\]:/gm;
const BRACKETED = /\[([^[\]\n]{1,200})\]/g;
const FOOTNOTE_CALL = /\[\^([^\]\s]{1,100})\]/g;

function delimiterCount(text: string): number {
  return text.match(DELIMITER)?.length ?? 0;
}

function escapeDelimiters(text: string): string {
  return text.replace(ESCAPABLE, "\\$&");
}

/**
 * Applies the inline bound. Lines inside fences are left alone: code spans and fences do not
 * go through delimiter matching. A line over `MAX_LINE_CHARS` outside a fence is cut at
 * whitespace into separate paragraphs (one huge paragraph costs time quadratic in its size).
 */
export function guardInline(text: string, warnings: Set<string>): string {
  if (text.length < 256) return text;
  const out: string[] = [];
  let fence: string | null = null;
  let runStart = -1;
  let runCount = 0;

  const closeRun = () => {
    if (runStart !== -1 && runCount > RUN_DELIMITERS) {
      for (let i = runStart; i < out.length; i++) {
        const line = out[i];
        if (line !== undefined && !STRUCTURED_LINE.test(line)) out[i] = escapeDelimiters(line);
      }
      warnings.add(WARNING_DENSE);
    }
    runStart = -1;
    runCount = 0;
  };

  for (const original of text.split("\n")) {
    const marker = FENCE_LINE.exec(original)?.[1];
    if (fence !== null) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      out.push(original);
      continue;
    }
    if (marker !== undefined) {
      closeRun();
      fence = marker;
      out.push(original);
      continue;
    }
    if (original.trim() === "") {
      closeRun();
      out.push(original);
      continue;
    }
    const parts = original.length > MAX_LINE_CHARS ? splitLongLine(original) : [original];
    if (parts.length > 1) warnings.add(WARNING_SPLIT);
    for (const [index, line] of parts.entries()) {
      if (index > 0) {
        closeRun();
        out.push("");
      }
      const count = delimiterCount(line);
      if (STRUCTURED_LINE.test(line)) {
        out.push(count > LINE_DELIMITERS ? escapeDelimiters(line) : line);
        if (count > LINE_DELIMITERS) warnings.add(WARNING_DENSE);
        continue;
      }
      if (runStart === -1) runStart = out.length;
      runCount += count;
      out.push(line);
    }
  }
  closeRun();
  return out.join("\n");
}

/** Cuts a line over `MAX_LINE_CHARS` into pieces at whitespace (or hard, without any). */
function splitLongLine(line: string): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > MAX_LINE_CHARS) {
    let at = rest.lastIndexOf(" ", MAX_LINE_CHARS);
    if (at < MAX_LINE_CHARS / 2) at = MAX_LINE_CHARS;
    const last = rest.charCodeAt(at - 1);
    if (last >= 0xd800 && last <= 0xdbff) at -= 1;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  parts.push(rest);
  return parts;
}

function isCalm(text: string): boolean {
  if (text.length > CALM_MAX_CHARS) return false;
  let pos = 0;
  while (pos < text.length) {
    const end = text.indexOf("\n", pos);
    const stop = end === -1 ? text.length : end;
    if (stop - pos > MAX_LINE_CHARS || !CALM_LINE.test(text.slice(pos, stop))) return false;
    pos = stop + 1;
  }
  return true;
}

/** Pieces of an overflowing stretch that is not calm. */
function forceSplit(text: string): string[] {
  const pieces: string[] = [];
  let current: string[] = [];
  let chars = 0;
  const flush = () => {
    if (current.length > 0) pieces.push(current.join("\n"));
    current = [];
    chars = 0;
  };
  for (const line of text.split("\n")) {
    current.push(line);
    chars += line.length;
    if (current.length >= FORCED_LINES || chars >= RENDER_CHUNK_LIMITS.maxChars) flush();
  }
  flush();
  return pieces;
}

/** Definitions of the whole document, which a piece cut out of it cannot see. */
interface Definitions {
  /** Footnote labels as written. */
  readonly footnotes: ReadonlySet<string>;
  /** Link reference labels, normalized the way CommonMark matches them. */
  readonly links: ReadonlySet<string>;
}

function linkKey(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

function collectDefinitions(body: string): Definitions {
  const footnotes = new Set<string>();
  const links = new Set<string>();
  for (const match of body.matchAll(FOOTNOTE_DEFINITION)) {
    if (footnotes.size >= MAX_STUBS) break;
    if (match[1] !== undefined) footnotes.add(match[1]);
  }
  for (const match of body.matchAll(LINK_DEFINITION)) {
    if (links.size >= MAX_STUBS) break;
    if (match[1] !== undefined) links.add(linkKey(match[1]));
  }
  return { footnotes, links };
}

/**
 * Parses one piece. A reference (`[text][label]`, `[label]`, `[^note]`) only parses as one when
 * its definition is in the same parse, so stubs for the definitions this piece refers to are
 * appended and their nodes dropped again. The real definition nodes are in the pieces they came
 * from, and the final tree resolves references against those.
 */
function parsePiece(text: string, definitions: Definitions): Nodes[] {
  const stubs = new Map<string, string>();
  if (definitions.footnotes.size > 0 && text.includes("[^")) {
    for (const match of text.matchAll(FOOTNOTE_CALL)) {
      const label = match[1];
      if (label !== undefined && definitions.footnotes.has(label) && stubs.size < MAX_STUBS) {
        stubs.set(`^${label}`, `[^${label}]: x`);
      }
    }
  }
  if (definitions.links.size > 0 && text.includes("[")) {
    for (const match of text.matchAll(BRACKETED)) {
      const label = match[1];
      if (
        label !== undefined &&
        !label.startsWith("^") &&
        definitions.links.has(linkKey(label)) &&
        stubs.size < MAX_STUBS
      ) {
        stubs.set(linkKey(label), `[${label}]: <x>`);
      }
    }
  }
  const source = stubs.size === 0 ? text : `${text}\n\n${[...stubs.values()].join("\n")}`;
  const children = parser.parse(source).children as Nodes[];
  if (source === text) return children;
  return children.filter(
    (node) =>
      node.position === undefined ||
      node.position.start.offset === undefined ||
      node.position.start.offset < text.length,
  );
}

/**
 * Keeps the first `MAX_NODES` nodes in document order and drops the rest. Iterative: nesting
 * depth cannot overflow the stack.
 */
function limitNodes(root: Root, notes: Set<string>): void {
  const path: { parent: Parents; next: number }[] = [{ parent: root, next: 0 }];
  let budget = MAX_NODES;
  for (;;) {
    const top = path.at(-1);
    if (top === undefined) return;
    const child = top.parent.children[top.next++] as Nodes | undefined;
    if (child === undefined) {
      path.pop();
      continue;
    }
    if (budget-- <= 0) {
      top.parent.children.length = top.next - 1;
      for (const { parent, next } of path.slice(0, -1)) parent.children.length = next;
      notes.add(WARNING_TRUNCATED);
      return;
    }
    if ("children" in child) path.push({ parent: child, next: 0 });
  }
}

/** Parses the cleaned body (LF only, no frontmatter). Never hangs; may throw only on a bug. */
export function parseBody(
  body: string,
  warnings: string[],
  wholeParseMax = WHOLE_PARSE_MAX_CHARS,
): Root {
  const notes = new Set<string>();
  let root: Root;
  if (body.length <= wholeParseMax) {
    root = parser.parse(guardInline(body, notes));
  } else {
    const definitions = collectDefinitions(body);
    const children: Nodes[] = [];
    for (const text of pieceTexts(body, notes)) {
      const nodes = parsePiece(guardInline(text, notes), definitions);
      // A list cut between two items is one list again.
      const last = children.at(-1);
      const first = nodes[0];
      if (
        last?.type === "list" &&
        first?.type === "list" &&
        LIST_START.test(text) &&
        last.ordered === first.ordered
      ) {
        last.children.push(...first.children);
        last.spread = (last.spread ?? false) || (first.spread ?? false);
        nodes.shift();
      }
      children.push(...nodes);
    }
    root = { type: "root", children: children as Root["children"] };
  }
  limitNodes(root, notes);
  warnings.push(...notes);
  return root;
}

/**
 * The pieces to parse alone. A stretch without a safe point is first cut again at list items
 * (`parseBody` joins the lists back), then, if what is left is still too big and not calm, at
 * line counts.
 */
function* pieceTexts(body: string, notes: Set<string>): Generator<string> {
  for (const range of splitRanges(body, RENDER_CHUNK_LIMITS, true, false)) {
    const text = body.slice(range.start, range.end);
    if (!range.overflow) {
      yield text;
      continue;
    }
    for (const sub of splitRanges(text, RENDER_CHUNK_LIMITS, true, true)) {
      const part = text.slice(sub.start, sub.end);
      if (!sub.overflow || isCalm(part)) {
        yield part;
      } else {
        notes.add(WARNING_SPLIT);
        yield* forceSplit(part);
      }
    }
  }
}
