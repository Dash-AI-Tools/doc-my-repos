/**
 * Safe rendering of a model answer (ask-the-docs design decision 4). `sanitizeAnswer` parses a small
 * Markdown subset with a hand-written tokenizer into a typed tree that a component renders as React
 * elements. There is no HTML anywhere in the pipeline: the tree can only hold text, emphasis, code
 * and citation numbers, so an answer cannot create an image, a link, a script or an event handler.
 *
 *  - Block syntax: paragraphs, ordered and unordered lists (nesting is flattened), fenced code,
 *    headings (flattened to bold paragraphs), block quotes (marker dropped), rules (dropped).
 *  - Inline syntax: `**strong**`, `*em*`, `_em_`, `` `code` ``, backslash escapes.
 *  - Images become their alt text. Every link becomes text: the label, then the URL as plain text.
 *    Raw HTML stays as literal text, which React escapes.
 *  - `[n]` (or `[n, m]`) becomes a citation only when `n` is in `validCitations`; any other number
 *    is removed. Citation links are built by the caller from server data, never from the model.
 *  - Safe for partial streams: an unclosed marker or fence shows literally or as an open code block,
 *    never as something unsafe, and any prefix of a text parses without throwing.
 *  - Bounded: input beyond `MAX_ANSWER_CHARS` is ignored, and every scan has a fixed window, so
 *    hostile input cannot make parsing slow.
 */

export type Inline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "strong"; readonly children: readonly Inline[] }
  | { readonly type: "em"; readonly children: readonly Inline[] }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "cite"; readonly n: number };

export type Block =
  | { readonly type: "paragraph"; readonly children: readonly Inline[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly items: readonly (readonly Inline[])[];
    }
  | { readonly type: "code"; readonly language: string | null; readonly text: string };

export const MAX_ANSWER_CHARS = 64_000;
const EMPHASIS_WINDOW = 1000;
const LABEL_WINDOW = 500;
const URL_WINDOW = 2000;
const CODE_SPAN_WINDOW = 2000;
const MAX_DEPTH = 4;

const ESCAPABLE = "\\`*_{}[]()#+-.!|<>~";
const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,30}$/;

type Citations = ReadonlySet<number>;

// --- inline ------------------------------------------------------------------------------------

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

interface Bracketed {
  readonly label: string;
  readonly url: string;
  readonly end: number;
}

/** `[label](url)` starting at `src[start] === "["`, or null. Bounded scans, no nesting of links. */
function matchBracketParen(src: string, start: number): Bracketed | null {
  let depth = 0;
  let close = -1;
  const labelEnd = Math.min(src.length, start + LABEL_WINDOW);
  for (let i = start; i < labelEnd; i += 1) {
    const c = src[i];
    if (c === "\\") i += 1;
    else if (c === "[") depth += 1;
    else if (c === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || src[close + 1] !== "(") return null;

  let parens = 0;
  const urlStart = close + 2;
  const urlEnd = Math.min(src.length, urlStart + URL_WINDOW);
  for (let i = urlStart; i < urlEnd; i += 1) {
    const c = src[i];
    if (c === "\\") i += 1;
    else if (c === "(") parens += 1;
    else if (c === ")") {
      if (parens === 0) {
        const raw = src.slice(urlStart, i).trim();
        // `<url>` wrappers and a trailing `"title"` are dropped; the first word is the URL.
        const url =
          (raw.startsWith("<") ? raw.slice(1).replace(/>.*$/s, "") : raw.split(/\s/)[0]) ?? "";
        return { label: src.slice(start + 1, close), url, end: i + 1 };
      }
      parens -= 1;
    }
  }
  return null;
}

/** Controls and bidi characters become spaces so a URL shown as text cannot reorder what follows. */
function inertText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ");
}

function parseInline(src: string, valid: Citations, depth: number): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf !== "") {
      const last = out[out.length - 1];
      if (last?.type === "text") out[out.length - 1] = { type: "text", text: last.text + buf };
      else out.push({ type: "text", text: buf });
      buf = "";
    }
  };
  const push = (inline: Inline) => {
    flush();
    out.push(inline);
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;

    if (c === "\\" && i + 1 < src.length && ESCAPABLE.includes(src[i + 1]!)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      let run = 1;
      while (src[i + run] === "`") run += 1;
      let found = -1;
      let from = i + run;
      while (from < src.length && from - i < CODE_SPAN_WINDOW) {
        const p = src.indexOf("`", from);
        if (p === -1) break;
        let q = 1;
        while (src[p + q] === "`") q += 1;
        if (q === run) {
          found = p;
          break;
        }
        from = p + q;
      }
      if (found === -1) {
        buf += "`".repeat(run);
        i += run;
        continue;
      }
      let content = src.slice(i + run, found).replace(/\n/g, " ");
      if (content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
        content = content.slice(1, -1);
      }
      push({ type: "code", text: content });
      i = found + run;
      continue;
    }

    if (c === "!" && src[i + 1] === "[") {
      const image = matchBracketParen(src, i + 1);
      if (image) {
        // The image is dropped; its alt text stays, as text only.
        buf += inertText(image.label.replace(/[[\]\\]/g, ""));
        i = image.end;
        continue;
      }
    }

    if (c === "[") {
      const link = matchBracketParen(src, i);
      if (link) {
        const label = parseInline(link.label, valid, depth + 1);
        for (const part of label) {
          if (part.type === "text") buf += part.text;
          else push(part);
        }
        const shown = inertText(link.url);
        if (shown !== "") buf += link.label.trim() === "" ? shown : ` (${shown})`;
        i = link.end;
        continue;
      }
      const cite = /^\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/.exec(src.slice(i, i + 40));
      if (cite) {
        const numbers = (cite[1] ?? "").split(",").map((n) => Number(n.trim()));
        const kept = numbers.filter((n) => valid.has(n));
        i += cite[0].length;
        if (kept.length > 0) for (const n of kept) push({ type: "cite", n });
        else if (buf.endsWith(" ") && (i >= src.length || /[\s.,;:!?)]/.test(src[i]!))) {
          buf = buf.slice(0, -1);
        }
        continue;
      }
    }

    if (c === "*" || c === "_") {
      let run = 1;
      while (src[i + run] === c) run += 1;
      const d = run >= 2 ? 2 : 1;
      const delimiter = c.repeat(d);
      const opens =
        !isSpace(src[i + d]) && (c === "*" || !isWordChar(src[i - 1])) && depth < MAX_DEPTH;
      if (opens) {
        const limit = Math.min(src.length, i + d + EMPHASIS_WINDOW);
        let from = i + d;
        let found = -1;
        while (from < limit) {
          const p = src.indexOf(delimiter, from);
          if (p === -1 || p >= limit) break;
          const before = src[p - 1];
          const after = src[p + d];
          const closes =
            p > i + d &&
            !isSpace(before) &&
            (c === "*" || !isWordChar(after)) &&
            (d === 2 || (before !== c && after !== c));
          if (closes) {
            found = p;
            break;
          }
          from = p + 1;
        }
        if (found !== -1) {
          const children = parseInline(src.slice(i + d, found), valid, depth + 1);
          push({ type: d === 2 ? "strong" : "em", children });
          i = found + d;
          continue;
        }
      }
      buf += delimiter;
      i += d;
      continue;
    }

    buf += c;
    i += 1;
  }
  flush();
  return out;
}

// --- blocks ------------------------------------------------------------------------------------

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;

/**
 * Parses `text` into safe blocks. `validCitations` are the excerpt numbers an answer may cite.
 * Never throws and never returns anything but the types above.
 */
export function sanitizeAnswer(
  text: string,
  validCitations: Citations | readonly number[],
): Block[] {
  const valid: Citations = validCitations instanceof Set ? validCitations : new Set(validCitations);
  const lines = text.slice(0, MAX_ANSWER_CHARS).replace(/\r\n?/g, "\n").split("\n");

  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: { char: string; length: number; language: string | null; lines: string[] } | null =
    null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" "), valid, 0) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({
        type: "list",
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(item, valid, 0)),
      });
      list = null;
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (fence) {
      const close = FENCE_OPEN.exec(line);
      if (
        close &&
        close[2] === "" &&
        close[1]?.[0] === fence.char &&
        (close[1]?.length ?? 0) >= fence.length
      ) {
        blocks.push({ type: "code", language: fence.language, text: fence.lines.join("\n") });
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    if (open) {
      flushAll();
      const info = (open[2] ?? "").trim().split(/\s+/)[0] ?? "";
      fence = {
        char: open[1]![0]!,
        length: open[1]!.length,
        language: LANGUAGE.test(info) ? info : null,
        lines: [],
      };
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      continue;
    }
    if (RULE.test(line)) {
      flushAll();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      const children = parseInline(heading[1] ?? "", valid, 0);
      blocks.push({ type: "paragraph", children: [{ type: "strong", children }] });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      const ordered = /^\d/.test(item[2] ?? "");
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item[3] ?? "");
      continue;
    }

    if (list && /^\s{2,}\S/.test(line)) {
      // A continuation line of the last list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }

    const quote = QUOTE.exec(line);
    flushList();
    paragraph.push((quote ? (quote[1] ?? "") : line).trim());
  }

  if (fence) {
    // A fence still open (a partial stream): show what has arrived so far as code.
    blocks.push({ type: "code", language: fence.language, text: fence.lines.join("\n") });
  }
  flushAll();
  return blocks;
}
