import GithubSlugger from "github-slugger";
import type { Nodes, Parents, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { Heading } from "../db/schema";
import { stripNul, toWellFormed, type FrontmatterData } from "./frontmatter";

export interface ExtractedMetadata {
  /** Never blank. */
  readonly title: string;
  /** `null` when frontmatter has no usable `description`. */
  readonly description: string | null;
  /** Every ATX or setext heading in document order, slugs unique within the document. */
  readonly headings: readonly Heading[];
}

export const MAX_TITLE_CHARS = 300;
export const MAX_DESCRIPTION_CHARS = 1000;
export const MAX_HEADING_CHARS = 300;
export const MAX_SLUG_CHARS = 300;
export const MAX_HEADINGS = 1000;
/**
 * Text past this is not scanned for headings, so an H1 that late is not found and the title
 * falls through to the file name. See `splitChunks` for why this is not larger.
 */
export const MAX_BODY_CHARS = 128 * 1024;
/** `splitChunks` starts a new chunk at the first safe point after this many chars. */
export const CHUNK_TARGET_CHARS = 1024;
/** No chunk is parsed past this size; the rest of an over-long block is skipped. */
export const CHUNK_MAX_CHARS = 2 * 1024;
/** Same, in lines: the parser's worst case grows with the square of the line count. */
export const CHUNK_MAX_LINES = 150;
/** Inline source of one heading that is parsed for its plain text; the rest is dropped. */
export const MAX_HEADING_SOURCE_CHARS = 600;
/**
 * Total heading source parsed with inline parsing per document. Inline parsing is quadratic on
 * delimiter soup (`*_*_...`, `[*[*`): about 2.4 ms for one 600-char heading of it, so without a
 * total a document of 1000 such headings would cost seconds. Real headings average well under
 * 100 chars, so 1000 of them fit. Past the budget a heading keeps its unparsed source as text.
 */
export const INLINE_BUDGET_CHARS = 32 * 1024;

const WHITESPACE = /\s+/g;
const RESERVED_NAME = /^(?:index|readme)$/i;

/**
 * Inline constructs, by micromark construct name (commonmark core and the remark-gfm
 * extensions). The document-wide pass needs block structure only, and inline parsing is
 * quadratic on delimiter soup (`*_*_...`, `[*[*`, `*<`): 3 s for 32 KiB of `*_`, 16 s for 64 KiB,
 * minutes at 256 KiB. With these off, every paragraph is one plain text run (0.05 s for the same
 * 128 KiB of soup). `definition` stays on: it is a block-level construct that decides where a
 * setext heading starts, and its labels are needed to resolve reference links in headings.
 */
const INLINE_CONSTRUCTS = [
  "attention",
  "autolink",
  "characterEscape",
  "characterReference",
  "codeText",
  "hardBreakEscape",
  "htmlText",
  "labelEnd",
  "labelStartImage",
  "labelStartLink",
  "wwwAutolink",
  "protocolAutolink",
  "emailAutolink",
  "strikethrough",
  "gfmFootnoteCall",
  "gfmPotentialFootnoteCall",
  "tasklistCheck",
];

/** Block structure only: no inline constructs. See `INLINE_CONSTRUCTS`. */
const blockProcessor = unified()
  .data("micromarkExtensions", [{ disable: { null: INLINE_CONSTRUCTS } }])
  .use(remarkParse)
  .use(remarkGfm);

/** Full inline parsing; only ever fed one heading's capped source. */
const inlineProcessor = unified().use(remarkParse).use(remarkGfm);

function clean(value: string): string {
  return toWellFormed(stripNul(value));
}

/**
 * Deeply nested containers (`- - - ...`, `> > > ...`) are quadratic in the nesting depth, and one
 * short line can ask for hundreds of levels (also deep enough to overflow the stack in the
 * tree transforms). A line that opens more list or quote markers than this is blanked. No real
 * document nests that deep. A blanked line is the only edit made to the source.
 */
export const MAX_LINE_CONTAINERS = 16;

const CONTAINER_MARKER = /[ \t]*(?:>|[-*+]|\d{1,9}[.)])(?=[ \t]|$)/y;

function tooNested(line: string): boolean {
  CONTAINER_MARKER.lastIndex = 0;
  for (let count = 0; CONTAINER_MARKER.test(line); count++) {
    if (count >= MAX_LINE_CONTAINERS) return true;
  }
  return false;
}

function limitNesting(text: string): string {
  return text
    .split("\n")
    .map((line) => (tooNested(line) ? "" : line))
    .join("\n");
}

/** Prefix of at most `max` UTF-16 units, never ending inside a surrogate pair. */
function cut(text: string, max: number): string {
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Trims, collapses runs of whitespace to one space and caps at `max` UTF-16 units. */
function tidy(value: string, max: number): string {
  let text = value.replace(WHITESPACE, " ").trim();
  if (text.length > max) {
    text = cut(text, max).trimEnd();
  }
  return text;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A line that can only be paragraph text: no marker of any block starts it. */
const PLAIN_TEXT_START = /^[^\s#>\-+*=_|<~`[\d]/;
const ATX_HEADING_COL0 = /^#{1,6}(?:[ \t]|$)/;
const FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/;
const RAW_HTML_OPEN =
  /^ {0,3}<(?:(!--)|(\?)|(!\[CDATA\[)|(![A-Za-z])|(script|pre|style|textarea)(?=[\s>]|$))/i;
const RAW_HTML_ENDS = [/-->/, /\?>/, /\]\]>/, />/, /<\/(?:script|pre|style|textarea)>/i] as const;
/** HTML blocks that end at a blank line and may interrupt a paragraph (CommonMark type 6). */
const HTML_BLOCK_TAG =
  /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|\/?>|$)/i;
/** A whole line that is one open or closing tag (CommonMark type 7: cannot interrupt a paragraph). */
const HTML_LONE_TAG =
  /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/;

/**
 * The end marker of the raw HTML block that `line` opens, or `null` if it does not open one or
 * closes it on the same line.
 */
function openRawHtml(line: string): RegExp | null {
  const open = RAW_HTML_OPEN.exec(line);
  if (open === null) return null;
  const kind = [1, 2, 3, 4, 5].find((i) => open[i] !== undefined);
  const ends = kind === undefined ? undefined : RAW_HTML_ENDS[kind - 1];
  if (ends === undefined || ends.test(line.slice(open[0].length))) return null;
  return ends;
}

/**
 * HTML that ends at a blank line. After a blank line, or a closed block, a lone tag (`<br>`)
 * starts an HTML block (`Block`). Directly after a line of plain text it is only part of the
 * paragraph. After anything else it could be either (`Maybe`).
 */
const enum HtmlRun {
  None,
  Block,
  Maybe,
}

/**
 * Splits the body into pieces that can each be parsed alone, with the same result as parsing
 * the whole.
 *
 * Why. The block parser (micromark) is not linear: it re-walks its event list for every setext
 * underline, every blockquote that closes and every lazy continuation line, so a hostile
 * document costs time quadratic in its size however simple each line is. Measured on one
 * Apple-silicon laptop, parsing 32 KiB at once took 1.1 s for `> a` plus a blank line repeated,
 * 4.4 s for `> a` followed by 16k one-letter lines and 1.0 s for `a` plus `===` repeated; each
 * doubling of the size costs four times as much. Real documents are linear (about 2.5 ms per
 * KiB). Chunks of at most `CHUNK_MAX_CHARS` and `CHUNK_MAX_LINES` keep every parse small, so the
 * total is about (`MAX_BODY_CHARS` / `CHUNK_MAX_CHARS`) parses of the worst small chunk. Measured
 * at the cap, the worst inputs found take 0.3 to 0.4 s (`test: worst-case time`).
 *
 * Where to cut. A safe point is a line in column 0 that starts a block no matter what came
 * before: any non-space line after a blank line, an ATX heading, or a fence opener. No open list
 * item, quote, paragraph (so no setext underline), table or reference definition continues
 * across it, since those need an indent, a `>` or a non-blank line before. Three things do
 * survive and are tracked by hand: fenced code (closed like CommonMark does), the HTML blocks
 * that end on a marker (`<!--`, `<script`, `<pre`, `<style`, `<textarea`, `<?`, `<![CDATA[`,
 * `<!X`) and the HTML blocks that end at a blank line (`<div>`, a lone `<br>`), whose lines
 * (headings, fences) are not markdown. The line after a closed fence or marker block is also a
 * safe point.
 *
 * What it cannot know it does not guess. If a fence or raw HTML block was opened with an indent
 * (it may be in a list item, which a later line in column 0 ends, or top level, where that line
 * is content), or a lone tag after non-text may or may not start an HTML block and a fence
 * follows, the readings disagree, and the tracker gives up for the rest of the document
 * (`lost`): no more safe points, so the rest is not scanned. Real documents close their fences
 * before the next column-0 line. A test checks this against whole-document parsing: identical on
 * well-formed documents, never an invented heading on arbitrary ones.
 *
 * A block longer than the chunk limits (a huge code sample or table, a run of unbroken lines)
 * is parsed up to the limit, then skipped to the next safe point. Headings do not occur inside
 * such blocks except in deeply nested containers.
 */
export function splitChunks(body: string): string[] {
  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkLines = 0;
  let skipping = false;
  let afterBlank = true;
  let afterBlockEnd = false;
  let afterText = false;
  let lost = false;
  let html = HtmlRun.None;
  let fence: { char: string; length: number } | null = null;
  let rawEnd: RegExp | null = null;
  // The open fence or raw HTML block was indented, so it may sit in a list item that a later
  // line in column 0 ends, or be top-level, where such a line is content. Unresolvable.
  let indentedBlock = false;

  const emit = (until: number) => {
    chunks.push(cut(body.slice(chunkStart, until), CHUNK_MAX_CHARS));
  };

  let pos = 0;
  while (pos < body.length) {
    const lineEnd = body.indexOf("\n", pos);
    const end = lineEnd === -1 ? body.length : lineEnd;
    const line = body.slice(pos, end);
    const blank = line.trim() === "";
    const inBlock = fence !== null || rawEnd !== null || html !== HtmlRun.None;

    let opensFence: { char: string; length: number } | null = null;
    if (!blank && fence === null && rawEnd === null && html !== HtmlRun.Block) {
      const open = FENCE_OPEN.exec(line);
      const marker = open?.[1];
      if (marker !== undefined && !(marker.startsWith("`") && open?.[2]?.includes("`"))) {
        opensFence = { char: marker.charAt(0), length: marker.length };
      }
    }
    const first = line.charCodeAt(0);
    const safe =
      !lost &&
      !inBlock &&
      (((afterBlank || afterBlockEnd) && first > 32) ||
        (opensFence !== null && first > 32) ||
        ATX_HEADING_COL0.test(line));

    if (!skipping && (pos - chunkStart >= CHUNK_MAX_CHARS || chunkLines >= CHUNK_MAX_LINES)) {
      emit(pos);
      if (safe) {
        chunkStart = pos;
        chunkLines = 0;
      } else {
        skipping = true;
      }
    } else if (safe) {
      if (skipping) {
        chunkStart = pos;
        chunkLines = 0;
        skipping = false;
      } else if (pos - chunkStart >= CHUNK_TARGET_CHARS) {
        emit(pos);
        chunkStart = pos;
        chunkLines = 0;
      }
    }
    chunkLines++;

    const prevBlockEnd = afterBlockEnd;
    afterBlockEnd = false;
    if (fence !== null || rawEnd !== null) {
      if (indentedBlock && first > 32) lost = true;
      if (fence !== null) {
        const marker = FENCE_CLOSE.exec(line)?.[1];
        if (marker?.[0] === fence.char && marker.length >= fence.length) {
          fence = null;
          afterBlockEnd = true;
        }
      } else if (rawEnd?.test(line)) {
        rawEnd = null;
        afterBlockEnd = true;
      }
    } else if (html !== HtmlRun.None) {
      if (blank) {
        html = HtmlRun.None;
      } else if (html === HtmlRun.Maybe && (opensFence !== null || openRawHtml(line) !== null)) {
        lost = true;
      }
    } else if (!blank) {
      indentedBlock = first === 32;
      if (opensFence !== null) {
        fence = opensFence;
      } else {
        rawEnd = openRawHtml(line);
        if (rawEnd === null && HTML_BLOCK_TAG.test(line)) {
          html = HtmlRun.Block;
        } else if (rawEnd === null && HTML_LONE_TAG.test(line)) {
          // Directly after a line of plain text it only continues that paragraph.
          html =
            afterBlank || prevBlockEnd ? HtmlRun.Block : afterText ? HtmlRun.None : HtmlRun.Maybe;
        }
      }
    }
    afterBlank = blank;
    afterText = !blank && PLAIN_TEXT_START.test(line);
    pos = end + 1;
  }
  if (!skipping && chunkStart < body.length) emit(body.length);
  return chunks;
}

/** Plain text of the inline content: links, emphasis and code reduced to their text. */
function inlineText(heading: Parents): string {
  let out = "";
  const stack: Nodes[] = [...heading.children].reverse();
  while (stack.length > 0 && out.length < MAX_HEADING_SOURCE_CHARS) {
    const node = stack.pop();
    if (node === undefined) break;
    switch (node.type) {
      case "text":
      case "inlineCode":
        out += node.value;
        break;
      case "image":
      case "imageReference":
        out += node.alt ?? "";
        break;
      case "break":
        out += " ";
        break;
      case "html":
      case "footnoteReference":
        break;
      default:
        if ("children" in node) {
          for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push(node.children[i] as Nodes);
          }
        }
    }
  }
  return out;
}

/** Nodes that hold only inline content or no headings: not worth walking. */
const LEAF_BLOCKS = new Set(["paragraph", "table", "code", "html"]);

/** A heading as the block pass saw it; its text is worked out once every chunk is scanned. */
interface RawHeading {
  readonly depth: number;
  /** Inline source with container prefixes removed. */
  readonly raw: string;
}

interface Scan {
  readonly headings: RawHeading[];
  /** Non-empty entries in `headings`. */
  nonEmpty: number;
  /**
   * Link and footnote definitions of the whole document, as source lines, keyed by what a
   * heading writes between brackets (`label` in lowercase, `^label` for footnotes). They can
   * sit in another chunk or after the heading, and a reference to one only means something
   * with the definition at hand.
   */
  readonly definitions: Map<string, string>;
}

/**
 * Put before a heading's source when it is parsed again. It is whitespace for emphasis, like the
 * start of a line, but not a block marker, so source that looks like one (`===`, `2. x`, `> y`)
 * stays text.
 */
const LEAD = "\u00a0";
const MAX_DEFINITIONS = 4096;
/** At most this many definitions are added to one heading's source. */
const MAX_DEFINITIONS_PER_HEADING = 16;
const BRACKETED = /\[([^[\]]{1,200})\]/g;

function definitionKey(label: string): string {
  return label.replace(WHITESPACE, " ").trim().toLowerCase();
}

/**
 * Plain text of one heading. `raw` is the heading's inline source as the block pass saw it
 * (container prefixes already removed). It is re-parsed with full inline parsing, but only the
 * first `MAX_HEADING_SOURCE_CHARS`, so this costs the same for every heading no matter how big the
 * document is. It is parsed as the text of a setext heading behind `LEAD`, so it cannot turn into some other
 * block. Definitions that the source refers to are appended so
 * `[text][ref]` and `[^1]` resolve as they do in the rendered page.
 */
function headingText(
  { raw }: RawHeading,
  definitions: ReadonlyMap<string, string>,
  budget: { left: number },
): string {
  const source = raw.length > MAX_HEADING_SOURCE_CHARS ? cut(raw, MAX_HEADING_SOURCE_CHARS) : raw;
  if (source.length > budget.left) return source;
  budget.left -= source.length;

  const used = new Set<string>();
  for (const match of source.matchAll(BRACKETED)) {
    const line = definitions.get(definitionKey(match[1] ?? ""));
    if (line !== undefined) used.add(line);
    if (used.size >= MAX_DEFINITIONS_PER_HEADING) break;
  }
  const tail = used.size === 0 ? "" : `\n\n${[...used].join("\n")}`;
  try {
    const head = `${LEAD}${source}\n===`;
    const first = inlineProcessor.parse(head + tail).children[0];
    if (first?.type === "heading") return inlineText(first);
  } catch {
    // Fall through to the unparsed source.
  }
  return source;
}

/**
 * Adds the headings and definitions of one parsed chunk to `scan`, in document order. Iterative:
 * nesting depth in the source cannot overflow the stack.
 */
function scanChunk(tree: Root, scan: Scan): void {
  const stack: Nodes[] = [...tree.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.type === "heading") {
      if (scan.nonEmpty >= 2 * MAX_HEADINGS) continue;
      const raw = inlineText(node);
      const empty = raw.trim() === "";
      if (!empty) scan.nonEmpty++;
      scan.headings.push({
        depth: node.depth,
        raw: empty ? "" : raw,
      });
      continue;
    }
    if (scan.definitions.size < MAX_DEFINITIONS) {
      if (node.type === "definition") {
        const key = definitionKey(node.label ?? node.identifier);
        scan.definitions.set(key, `[${node.label ?? node.identifier}]: <x>`);
      } else if (node.type === "footnoteDefinition") {
        const label = node.label ?? node.identifier;
        scan.definitions.set(`^${definitionKey(label)}`, `[^${label}]: x`);
      }
    }
    if ("children" in node && !LEAF_BLOCKS.has(node.type)) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i] as Nodes);
      }
    }
  }
}

/**
 * Turns the scanned headings into stored ones, at most `MAX_HEADINGS`.
 *
 * Slugs: every heading goes through the slugger, including ones with empty text that are not
 * returned, so the duplicate counters match a renderer that slugs every heading. The renderer
 * (tasks 5.x and 7.x) must still take slugs from the stored `headings.slug`, or run this exact
 * slugger over the same text. Do not slug the rendered text independently: a heading longer than
 * `MAX_HEADING_SOURCE_CHARS` would get a different slug.
 */
function finishHeadings(scan: Scan): Heading[] {
  const slugger = new GithubSlugger();
  const budget = { left: INLINE_BUDGET_CHARS };
  const headings: Heading[] = [];
  for (const heading of scan.headings) {
    if (headings.length >= MAX_HEADINGS) break;
    const text =
      heading.raw === ""
        ? ""
        : headingText(heading, scan.definitions, budget).replace(WHITESPACE, " ").trim();
    const slug = slugger.slug(text).slice(0, MAX_SLUG_CHARS);
    if (text !== "") {
      headings.push({ depth: heading.depth, text: tidy(text, MAX_HEADING_CHARS), slug });
    }
  }
  return headings;
}

/** `Getting-started` style names become words; only the first letter is capitalized. */
function humanize(name: string): string {
  const words = name.replace(/[-_]+/g, " ").replace(WHITESPACE, " ").trim();
  return words === "" ? "" : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Title from the file name: the base name without its final extension, humanized. For
 * `index` and `README` (any case) the enclosing folder names the page, since the file name says
 * nothing; at the docs root there is no folder, so the file name is used.
 */
export function titleFromPath(path: string): string {
  const parts = clean(path)
    .split("/")
    .filter((part) => part !== "");
  const file = parts.at(-1) ?? "";
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  if (RESERVED_NAME.test(stem)) {
    const folder = humanize(parts.at(-2) ?? "");
    if (folder !== "") return folder;
  }
  return humanize(stem) || "Untitled";
}

function stringField(data: FrontmatterData, key: string, max: number): string | null {
  const value = data[key];
  if (typeof value !== "string") return null;
  const text = tidy(clean(value), max);
  return text === "" ? null : text;
}

/**
 * Derives title, description and headings. Title: frontmatter `title` (string only), else the
 * first level-1 heading, else the file name. Description: frontmatter `description` (string
 * only), else null: the spec defines no fallback. `body` is the Markdown after frontmatter
 * (as returned by `parseFrontmatter`). Headings in fenced code, indented code and HTML blocks
 * are not headings; setext headings are.
 *
 * Only the first `MAX_BODY_CHARS` of the body are scanned, so an H1 past that point is not found
 * and the title falls through to the file name. The same goes for headings after a block the
 * scanner skips (see `splitChunks`). Never throws; on an internal failure it returns what it
 * found so far.
 */
export function extractMetadata(input: {
  body: string;
  frontmatter: FrontmatterData;
  path: string;
}): ExtractedMetadata {
  let headings: Heading[] = [];
  try {
    const body = limitNesting(
      clean(
        input.body.length > MAX_BODY_CHARS ? cut(input.body, MAX_BODY_CHARS) : input.body,
      ).replace(/\r\n?/g, "\n"),
    );
    const scan: Scan = { headings: [], nonEmpty: 0, definitions: new Map() };
    for (const chunk of splitChunks(body)) {
      try {
        scanChunk(blockProcessor.parse(chunk), scan);
      } catch {
        // One chunk the parser rejects loses only its own headings.
      }
    }
    headings = finishHeadings(scan);
  } catch {
    headings = [];
  }

  const title =
    stringField(input.frontmatter, "title", MAX_TITLE_CHARS) ??
    headings.find((h) => h.depth === 1)?.text.slice(0, MAX_TITLE_CHARS) ??
    tidy(titleFromPath(input.path), MAX_TITLE_CHARS);

  return {
    title,
    description: stringField(input.frontmatter, "description", MAX_DESCRIPTION_CHARS),
    headings,
  };
}
