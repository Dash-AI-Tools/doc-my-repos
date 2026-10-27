/**
 * Snippet cleaning (task 10.2, search spec "Snippet highlighting"). Pure: no database, no React.
 *
 * `ts_headline` cuts its fragments from the raw Markdown body of a third-party document, so a
 * fragment can hold any Markdown or HTML syntax, cut anywhere (`[link](ht`, `<div cl`, `&am`),
 * with the highlight markers inside that syntax. `cleanSnippet` turns such a fragment into plain
 * text. Its output holds nothing but text and the two markers `HIGHLIGHT_START` and
 * `HIGHLIGHT_END`, balanced, so the UI renders it as React text plus `<mark>` (`splitHighlights`
 * in `./search`) and never as HTML. It never throws and runs in time linear in the input.
 *
 * How it works. The markers are first removed from the text and turned into a per-character
 * "highlighted" flag. Every later stage copies characters together with their flag, so a marker
 * stays attached to the text it surrounded even when the syntax around that text is removed, and
 * a marker inside removed syntax (a link URL, a tag, an attribute) disappears with it. At the end
 * each run of highlighted characters that contains a letter or digit gets one START/END pair.
 *
 * Stages, in order (each is one linear scan; the heuristics are the contract, see the tests):
 * 1. Load: bound the input, turn `HEADLINE_ANGLE` back into `<`, normalize line ends, spaces to " ", drop controls, zero-width, bidi,
 *    private-use (all but our markers), noncharacters and lone surrogates.
 * 2. HTML: remove comments, declarations, tags (complete or cut at either end of the fragment) and
 *    the content of script/style/template/noscript/iframe/object (and friends). A tag is removed
 *    only when it is clearly one: a known HTML element, a JSX-like name (`<Callout>`,
 *    `<my-widget>`), or any tag with `name="value"` attributes or self-closing. Generics in
 *    prose (`Promise<void>`, `<T>`, `a < b`) stay. Autolinks `<https://x>` keep their text. A
 *    `<name` cut by the end of the text or of a fragment (`<di`, `<div cl`) is removed whatever the
 *    name, unless it hangs on an identifier (`List<In`).
 * 3. Blocks, line by line: fences (info string dropped, code text kept), horizontal rules, setext
 *    underlines, `+++`/`---` frontmatter delimiters, table separator rows, reference definitions,
 *    MDX `import`/`export` lines, heading hashes, blockquote markers, list bullets and numbers,
 *    task checkboxes, GitHub alert markers, footnote definition labels, table pipes (cells are
 *    joined with " · ").
 * 4. Inline, per line: backslash escapes, code spans (text kept, unterminated backticks dropped),
 *    links and images (text or alt kept; URL and title dropped, also when cut), reference links,
 *    footnote references, paired emphasis (`*x*`, `_x_`), strong and strikethrough runs,
 *    decorative runs, emoji shortcodes, JS member/call/arrow `{expressions}`, and bare URLs
 *    (scheme, `www.`, query and fragment dropped; at most 40 characters).
 * 5. Entities: a small named set and numeric references are decoded once; references to
 *    controls, bidi controls, zero-width, private-use, surrogates or out-of-range values are
 *    dropped, never decoded; a cut entity at either end of the text is dropped.
 * 6. Whitespace is collapsed and trimmed, the length is capped at a word boundary with "…", and
 *    the markers are written back.
 *
 * Known false positives (text that looks like markup and is removed or changed): `<b ...>` style
 * prose where `<`+known element name is followed by a `>` (`a<b and c>d`); a `<word` at the very end
 * of a fragment (`if x <y`); a bare `<Word>` that is
 * not attached to an identifier (`a list of <Integer> values`); HTML inside code spans and fences
 * (stage 2 does not know about Markdown); `**` and `__` inside words (`2**3`, `__init__`) except
 * `**` next to `/` (globs); leading `-`, `*`, `+`, `1.` and `>` at the start of a line; `#` + space
 * at the start of a line; lines made only of `---`, `***`, `___`, `===`; `[ref]: dest` lines whose
 * destination looks like a path or URL; `:word:` emoji lookalikes; `{user.id}` style
 * expressions; a line with two or more single `|` is read as a table row. Constructs that cannot
 * be told apart from text stay: a bare `[text]`, a single unpaired `*` or `_`, `{id}`
 * placeholders, `a*b*c`, `snake_case_name`, `C++`, `2 < 3 and 5 > 4`, `<T>` after an identifier.
 * A fragment that starts inside a fence reads the closing fence as an opening one, so the prose
 * after it is not stripped of Markdown.
 */

/**
 * Snippet highlight markers. `ts_headline` wraps every matched term in these two private-use
 * code points instead of HTML, so document text can never inject markup: the UI renders the
 * snippet as text and turns each START...END span into a `<mark>` (see `splitHighlights`).
 * Both are removed from the source before `ts_headline` runs and from the query text.
 */
export const HIGHLIGHT_START = "";
export const HIGHLIGHT_END = "";

/**
 * Stands for `<` in the text given to `ts_headline`. Its parser reads `<...>` as a tag and drops
 * it from the fragment, which would also drop the `<script>` that tells `cleanSnippet` to ignore
 * the script's content. The query layer therefore swaps `<` for this code point before
 * `ts_headline` (SQL `translate`) and `cleanSnippet` swaps it back first thing. It is never in
 * the output.
 */
export const HEADLINE_ANGLE = "\uE002";

/** Longest snippet, in code points, not counting the markers (the "…" of a cut counts). */
export const SNIPPET_MAX_CHARS = 400;
/** Most characters of a fragment read; the rest is ignored. Bounds the work on any input. */
export const SNIPPET_MAX_INPUT_CHARS = 20_000;

export interface CleanSnippetOptions {
  /** Output cap in code points (default `SNIPPET_MAX_CHARS`). */
  readonly maxChars?: number;
  /** Input cap in code points (default `SNIPPET_MAX_INPUT_CHARS`). */
  readonly maxInputChars?: number;
}

/**
 * Turns a raw `ts_headline` fragment into display text: plain text, whitespace collapsed, at most
 * `maxChars` code points, with only balanced `HIGHLIGHT_START`/`HIGHLIGHT_END` pairs as markup.
 * Pure and total: any input gives a string, and nothing in it can be read as HTML.
 */
export function cleanSnippet(raw: string, options: CleanSnippetOptions = {}): string {
  if (typeof raw !== "string") return "";
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? SNIPPET_MAX_CHARS));
  const maxInput = Math.max(1, Math.floor(options.maxInputChars ?? SNIPPET_MAX_INPUT_CHARS));
  try {
    const loaded = load(raw, maxInput);
    const html = stripHtml(loaded);
    const markdown = stripMarkdown(html);
    const decoded = decodeEntities(markdown);
    const collapsed = collapseWhitespace(decoded);
    return serialize(capLength(collapsed, maxChars));
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------------------------
// Text buffers: parallel arrays of code points and "highlighted" flags.
// ---------------------------------------------------------------------------------------------

class Out {
  readonly c: string[] = [];
  readonly h: boolean[] = [];
  push(ch: string, hl: boolean): void {
    this.c.push(ch);
    this.h.push(hl);
  }
  truncate(length: number): void {
    if (length < this.c.length) {
      this.c.length = length;
      this.h.length = length;
    }
  }
  get length(): number {
    return this.c.length;
  }
}

const WORDISH = /[\p{L}\p{N}]/u;

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && WORDISH.test(ch);
}

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"));
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function isIdent(ch: string | undefined): boolean {
  return isLetter(ch) || isDigit(ch) || ch === "_" || ch === "$";
}

/** Space, tab or newline (the only whitespace left after `load`). */
function isWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\n" || ch === "\t";
}

/** Whitespace, or the edge of the text: what flanking rules see outside a line. */
function wsOrEdge(ch: string | undefined): boolean {
  return ch === undefined || isWs(ch);
}

/** The fragment delimiter `ts_headline` puts between fragments (see `HEADLINE_OPTIONS`). */
function delimAt(c: readonly string[], i: number): boolean {
  return c[i] === " " && c[i + 1] === "…" && c[i + 2] === " ";
}

function isUnicodeSpace(cp: number): boolean {
  return (
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** Code points that never reach the output: controls, invisible/format, private-use, specials. */
function isDroppedCodePoint(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xad ||
    cp === 0x61c ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    (cp >= 0xd800 && cp <= 0xdfff) ||
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xfdd0 && cp <= 0xfdef) ||
    cp === 0xfeff ||
    (cp >= 0xfff0 && cp <= 0xffff) ||
    (cp & 0xfffe) === 0xfffe ||
    cp >= 0xe0000
  );
}

// ---------------------------------------------------------------------------------------------
// Stage 1: load
// ---------------------------------------------------------------------------------------------

function load(raw: string, maxInput: number): Out {
  const out = new Out();
  let on = false;
  let prevCR = false;
  let seen = 0;
  for (const ch of raw) {
    if (++seen > maxInput * 2 || out.length >= maxInput) break;
    if (ch === HIGHLIGHT_START) {
      on = true;
      continue;
    }
    if (ch === HIGHLIGHT_END) {
      on = false;
      continue;
    }
    if (ch === HEADLINE_ANGLE) {
      out.push("<", on);
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\r") {
      out.push("\n", on);
      prevCR = true;
      continue;
    }
    const afterCR = prevCR;
    prevCR = false;
    if (ch === "\n") {
      if (!afterCR) out.push("\n", on);
      continue;
    }
    if (cp === 0x2028 || cp === 0x2029) {
      out.push("\n", on);
      continue;
    }
    if (ch === "\t" || ch === " " || isUnicodeSpace(cp)) {
      out.push(" ", on);
      continue;
    }
    if (isDroppedCodePoint(cp)) continue;
    out.push(ch, on);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stage 2: HTML
// ---------------------------------------------------------------------------------------------

const HTML_ELEMENTS = new Set(
  (
    "a abbr acronym address area article aside audio b base bdi bdo big blockquote body br button " +
    "canvas caption center cite code col colgroup data datalist dd del details dfn dialog dir div " +
    "dl dt em embed fieldset figcaption figure font footer form frame frameset h1 h2 h3 h4 h5 h6 " +
    "head header hgroup hr html i iframe img input ins kbd label legend li link main map mark " +
    "menu meta meter nav noframes noscript object ol optgroup option output p param picture pre " +
    "progress q rp rt ruby s samp script search section select slot small source span strike " +
    "strong style sub summary sup svg table tbody td template textarea tfoot th thead time title " +
    "tr track tt u ul var video wbr xmp math noembed mi mo mn ms mtext mrow msup msub mfrac msqrt " +
    "mtable mtr mtd mstyle semantics annotation rect circle ellipse polyline polygon tspan " +
    "lineargradient radialgradient clippath foreignobject"
  ).split(" "),
);

/** Elements that separate words: removing the tag leaves a space. */
const BLOCK_ELEMENTS = new Set(
  (
    "address article aside blockquote br caption dd details dialog div dl dt fieldset " +
    "figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol option p " +
    "pre section summary table tbody td tfoot th thead tr ul"
  ).split(" "),
);

/** Elements whose content is not text: dropped together with the tags. */
const RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "object",
  "noembed",
  "noframes",
  "xmp",
]);

/** Longest tag (name and attributes) read; a longer one is not treated as a tag. */
const MAX_TAG_CHARS = 1024;

type Markup =
  | { readonly kind: "drop"; readonly end: number; readonly space: boolean }
  | {
      readonly kind: "keep";
      readonly end: number;
      readonly from: number;
      readonly to: number;
    }
  | { readonly kind: "raw-open"; readonly end: number; readonly name: string }
  | { readonly kind: "stray-close"; readonly end: number };

interface AttrScan {
  readonly kind: "closed" | "partial" | "bad";
  readonly end: number;
  readonly sawEq: boolean;
  readonly selfClose: boolean;
}

function isNameChar(ch: string | undefined): boolean {
  return isLetter(ch) || isDigit(ch) || ch === "-" || ch === "_" || ch === ":" || ch === ".";
}

/**
 * The closing quote `q` from `from`: its index; -1 when there is none before `limit`; or
 * `-2 - k` when the fragment delimiter starts at `k` first.
 */
function findQuote(c: readonly string[], q: string, from: number, limit: number): number {
  for (let k = from; k < limit; k++) {
    if (c[k] === q) return k;
    if (delimAt(c, k)) return -2 - k;
  }
  return -1;
}

function indexOfChar(c: readonly string[], ch: string, from: number, limit: number): number {
  for (let k = from; k < limit; k++) if (c[k] === ch) return k;
  return -1;
}

/**
 * Scans attributes from `start` to the closing `>`. `partial` means the text ended (or the
 * fragment delimiter or a new `<tag` came) first; `bad` means the tag is too long.
 */
function scanAttrs(c: readonly string[], start: number, n: number): AttrScan {
  const limit = Math.min(n, start + MAX_TAG_CHARS);
  let sawEq = false;
  let j = start;
  const partial = (end: number): AttrScan => ({ kind: "partial", end, sawEq, selfClose: false });
  const bad: AttrScan = { kind: "bad", end: start, sawEq: false, selfClose: false };
  while (j < limit) {
    const ch = c[j]!;
    if (ch === ">") {
      return { kind: "closed", end: j + 1, sawEq, selfClose: j > start && c[j - 1] === "/" };
    }
    if (isWs(ch)) {
      if (delimAt(c, j)) return partial(j);
      j++;
      continue;
    }
    if (ch === "/") {
      j++;
      continue;
    }
    if (ch === "<") return partial(j);
    if (ch === '"' || ch === "'") {
      const q = findQuote(c, ch, j + 1, limit);
      if (q <= -3) return partial(-2 - q);
      if (q < 0) return limit === n ? partial(n) : bad;
      j = q + 1;
      continue;
    }
    if (ch === "=") {
      sawEq = true;
      j++;
    } else {
      while (j < limit && !isWs(c[j]) && !"=>/<\"'".includes(c[j]!)) j++;
    }
    let k = j;
    while (k < limit && isWs(c[k]) && !delimAt(c, k)) k++;
    if (c[k] === "=") {
      sawEq = true;
      k++;
      while (k < limit && isWs(c[k]) && !delimAt(c, k)) k++;
      const v = c[k];
      if (v === '"' || v === "'") {
        const q = findQuote(c, v, k + 1, limit);
        if (q <= -3) return partial(-2 - q);
        if (q < 0) return limit === n ? partial(n) : bad;
        k = q + 1;
      } else {
        while (k < limit && !isWs(c[k]) && c[k] !== ">" && c[k] !== "<") k++;
      }
      j = k;
    }
  }
  return j >= n ? partial(n) : bad;
}

/**
 * The end of a tail cut from a tag at the start of a fragment: `class="x" id='y'>`. Strict (quoted
 * `name="value"` pairs only) so prose such as `a = b > c` is never read as a tail.
 */
function leadingAttrTail(c: readonly string[], start: number, n: number): number {
  const limit = Math.min(n, start + MAX_TAG_CHARS);
  let j = start;
  let pairs = 0;
  while (j < limit) {
    while (j < limit && isWs(c[j])) j++;
    if (c[j] === ">" && pairs > 0) return j + 1;
    if (c[j] === "/" && c[j + 1] === ">" && pairs > 0) return j + 2;
    const nameStart = j;
    while (j < limit && (isNameChar(c[j]) || c[j] === "@")) j++;
    if (j === nameStart || c[j] !== "=") return -1;
    const q = c[j + 1];
    if (q !== '"' && q !== "'") return -1;
    const close = indexOfChar(c, q, j + 2, limit);
    if (close < 0) return -1;
    pairs++;
    j = close + 1;
  }
  return -1;
}

function commentEnd(c: readonly string[], from: number, n: number): number {
  for (let j = from; j < n; j++) {
    if (delimAt(c, j)) return j;
    if (c[j] === "-" && c[j + 1] === "-") {
      if (c[j + 2] === ">") return j + 3;
      if (c[j + 2] === "!" && c[j + 3] === ">") return j + 4;
    }
  }
  return n;
}

/** End of `<!doctype ...>`, `<?xml ...?>`: after the next `>`; to the text end if cut. */
function declarationEnd(c: readonly string[], from: number, n: number): number {
  const limit = Math.min(n, from + MAX_TAG_CHARS);
  for (let j = from; j < limit; j++) {
    if (c[j] === ">") return j + 1;
    if (delimAt(c, j)) return j;
  }
  return limit === n ? n : -1;
}

/**
 * `<scheme:rest>` or `<user@host>`: the text between the brackets is kept (`to` is where it ends).
 * A scheme autolink cut by the end of the text or of a fragment (`<https://x.y/z`) counts too.
 */
function autolinkAt(
  c: readonly string[],
  i: number,
  n: number,
): { readonly end: number; readonly to: number } | null {
  const limit = Math.min(n, i + 2000);
  let j = i + 1;
  let colon = -1;
  let at = false;
  let cut = false;
  for (; j < limit; j++) {
    const ch = c[j]!;
    if (ch === ">") break;
    if (delimAt(c, j)) {
      cut = true;
      break;
    }
    if (isWs(ch) || ch === "<" || ch === '"') return null;
    if (ch === ":" && colon < 0) colon = j;
    if (ch === "@") at = true;
  }
  if (j >= limit && limit === n) cut = true;
  if (!cut && (j >= limit || c[j] !== ">")) return null;
  const end = cut ? j : j + 1;
  if (colon > i + 2 && colon - i <= 33) {
    for (let k = i + 1; k < colon; k++) {
      const ch = c[k];
      if (!(isLetter(ch) || isDigit(ch) || ch === "+" || ch === "." || ch === "-")) return null;
    }
    return { end, to: j };
  }
  return !cut && at && colon < 0 && j > i + 3 ? { end, to: j } : null;
}

function jsxLike(name: string): boolean {
  return (
    (name.length >= 2 && name[0]! >= "A" && name[0]! <= "Z") ||
    name.includes("-") ||
    (name.includes(".") && name.length >= 3)
  );
}

/** Recognizes markup at `c[i] === "<"`; null means the `<` is text. */
function markupAt(c: readonly string[], i: number, n: number): Markup | null {
  const next = c[i + 1];
  if (next === undefined) return null;
  if (next === "!") {
    // `<!`, `<!-` or `<!--` cut by the end of the text or of a fragment.
    let k = i + 2;
    while (k < i + 4 && c[k] === "-") k++;
    if (k >= n || delimAt(c, k)) return { kind: "drop", end: k, space: false };
    if (c[i + 2] === "-" && c[i + 3] === "-") {
      if (c[i + 4] === ">") return { kind: "drop", end: i + 5, space: false };
      if (c[i + 4] === "-" && c[i + 5] === ">") return { kind: "drop", end: i + 6, space: false };
      return { kind: "drop", end: commentEnd(c, i + 4, n), space: false };
    }
    const x = c[i + 2];
    if (isLetter(x) || x === "[") {
      const end = declarationEnd(c, i + 2, n);
      return end < 0 ? null : { kind: "drop", end, space: false };
    }
    return null;
  }
  if (next === "?") {
    if (i + 2 >= n || delimAt(c, i + 2)) return { kind: "drop", end: i + 2, space: false };
    const end = declarationEnd(c, i + 2, n);
    return end < 0 ? null : { kind: "drop", end, space: false };
  }
  if (isLetter(next)) {
    const link = autolinkAt(c, i, n);
    if (link !== null) return { kind: "keep", end: link.end, from: i + 1, to: link.to };
  }
  const prev = c[i - 1];
  let j = i + 1;
  const closing = c[j] === "/";
  if (closing) j++;
  if (!isLetter(c[j])) return null;
  const nameStart = j;
  while (j < n && j - nameStart < 64 && isNameChar(c[j])) j++;
  if (j - nameStart >= 64) return null;
  const name = c.slice(nameStart, j).join("");
  const lname = name.toLowerCase();
  const known = HTML_ELEMENTS.has(lname);
  const jsx = jsxLike(name);
  const space = BLOCK_ELEMENTS.has(lname);
  const raw = RAW_TEXT_ELEMENTS.has(lname);

  // Cut inside the tag name, at the end of the text or of a fragment: `<di`, `</sc`.
  if (j >= n || delimAt(c, j) || c[j] === "<") {
    if (isIdent(prev) && !closing) return null;
    return { kind: "drop", end: j, space };
  }
  const term = c[j]!;
  if (term === ">") {
    const end = j + 1;
    if (closing) {
      if (raw) return { kind: "stray-close", end };
      return known || jsx ? { kind: "drop", end, space } : null;
    }
    if (known) {
      return raw ? { kind: "raw-open", end, name: lname } : { kind: "drop", end, space };
    }
    // An unknown bare `<Name>` is a JSX tag unless it hangs on an identifier (`List<Integer>`).
    if (jsx && !isIdent(prev) && prev !== ">" && prev !== ")") return { kind: "drop", end, space };
    return null;
  }
  if (isWs(term) || term === "/") {
    if (closing) {
      let k = j;
      while (k < n && isWs(c[k])) k++;
      if (c[k] !== ">") return null;
      if (raw) return { kind: "stray-close", end: k + 1 };
      return known || jsx ? { kind: "drop", end: k + 1, space } : null;
    }
    const scan = scanAttrs(c, j, n);
    if (scan.kind === "bad") return null;
    // Single-letter elements (`a`, `b`, `i`, `p`) need attribute evidence or a cut; they are prose.
    const ok = known
      ? name.length >= 2 || scan.sawEq || scan.selfClose || scan.kind === "partial"
      : jsx || scan.sawEq || (scan.selfClose && name.length >= 2);
    if (!ok) return null;
    if (raw && scan.kind === "closed" && !scan.selfClose) {
      return { kind: "raw-open", end: scan.end, name: lname };
    }
    return { kind: "drop", end: scan.end, space };
  }
  return null;
}

/**
 * Where to resume after the opening tag of a raw-text element: after its closing tag, at the
 * fragment delimiter, or at the end of the text when neither comes.
 */
function findRawEnd(c: readonly string[], from: number, n: number, lname: string): number {
  for (let j = from; j < n; j++) {
    if (delimAt(c, j)) return j;
    if (c[j] !== "<" || c[j + 1] !== "/") continue;
    let k = j + 2;
    let match = true;
    for (let m = 0; m < lname.length; m++, k++) {
      if (c[k]?.toLowerCase() !== lname[m]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const t = c[k];
    if (t !== undefined && !isWs(t) && t !== "/" && t !== ">") continue;
    const close = indexOfChar(c, ">", k, Math.min(n, k + MAX_TAG_CHARS));
    return close < 0 ? Math.min(n, k) : close + 1;
  }
  return n;
}

function stripHtml(src: Out): Out {
  const { c, h } = src;
  const n = c.length;
  const out = new Out();
  let segStart = 0;
  let i = 0;
  const skipTail = () => {
    const end = leadingAttrTail(c, i, n);
    if (end > 0) i = end;
  };
  skipTail();
  while (i < n) {
    const ch = c[i]!;
    if (ch === " " && delimAt(c, i)) {
      out.push(" ", false);
      out.push("…", false);
      out.push(" ", false);
      i += 3;
      segStart = out.length;
      skipTail();
      continue;
    }
    if (ch !== "<") {
      out.push(ch, h[i]!);
      i++;
      continue;
    }
    const m = markupAt(c, i, n);
    if (m === null || m.end <= i) {
      out.push("<", h[i]!);
      i++;
      continue;
    }
    switch (m.kind) {
      case "keep":
        for (let k = m.from; k < m.to; k++) out.push(c[k]!, h[k]!);
        i = m.end;
        break;
      case "drop":
        if (m.space) out.push(" ", false);
        i = m.end;
        break;
      case "raw-open":
        out.push(" ", false);
        i = findRawEnd(c, m.end, n, m.name);
        break;
      case "stray-close":
        // The fragment began inside the element: what came before its end is its content.
        out.truncate(segStart);
        i = m.end;
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stage 3 and 4: Markdown (blocks per line, inline per line)
// ---------------------------------------------------------------------------------------------

const ASCII_PUNCT = new Set([..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"]);
const MAX_URL_SCAN = 2048;
const URL_KEEP_CHARS = 40;
const MAX_LABEL_SCAN = 2048;

interface BlockState {
  fence: { readonly ch: string; readonly len: number } | null;
  /** Inside a table: a separator row was seen and no line without pipes has come since. */
  table: boolean;
}

function stripMarkdown(src: Out): Out {
  const { c, h } = src;
  const n = c.length;
  const out = new Out();
  const state: BlockState = { fence: null, table: false };
  const starts: number[] = [0];
  for (let i = 0; i < n; i++) if (c[i] === "\n") starts.push(i + 1);
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k]!;
    const end = k + 1 < starts.length ? starts[k + 1]! - 1 : n;
    const nextSeparator =
      k + 1 < starts.length &&
      isTableSeparatorLine(c, starts[k + 1]!, k + 2 < starts.length ? starts[k + 2]! - 1 : n);
    processLine(c, h, start, end, state, nextSeparator, out);
    if (k + 1 < starts.length) out.push("\n", false);
  }
  return out;
}

function runLength(c: readonly string[], from: number, to: number, ch: string): number {
  let k = from;
  while (k < to && c[k] === ch) k++;
  return k - from;
}

function emitRaw(c: readonly string[], h: readonly boolean[], s: number, e: number, out: Out) {
  for (let k = s; k < e; k++) out.push(c[k]!, h[k]!);
}

const REF_DEF =
  /^\[[^\]^[][^\][]{0,200}\]:\s+(?:<[^>\s]{1,2000}>|[^\s<>]{1,2000})(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const REF_DEST_LOOKS_LIKE_LINK =
  /^(?:<[^>]*>|[^\s]*[/#][^\s]*|https?:[^\s]+|mailto:[^\s]+|[^\s]*\.[A-Za-z0-9]{1,6}(?:#[^\s]*)?)$/;
const MDX_IMPORT = /^import\s+(?:[^'"]*\sfrom\s+)?['"][^'"]*['"];?$/;
const MDX_EXPORT = /^export\s+(?:default|const|let|var|function|async|class)\s/;

function isReferenceDefinition(line: string): boolean {
  if (line.length > 3000 || !REF_DEF.test(line)) return false;
  const afterColon = line.slice(line.indexOf("]:") + 2).trimStart();
  const dest = afterColon.startsWith("<") ? afterColon : (afterColon.split(/\s/, 1)[0] ?? "");
  const token = dest.startsWith("<") ? dest.slice(0, dest.indexOf(">") + 1) : dest;
  return REF_DEST_LOOKS_LIKE_LINK.test(token);
}

/** A line made of one rule character (`-`, `*`, `_`, `=`), three or more times, with spaces. */
function isRuleLine(c: readonly string[], s: number, e: number): boolean {
  const marker = c[s]!;
  if (marker !== "-" && marker !== "*" && marker !== "_" && marker !== "=" && marker !== "+") {
    return false;
  }
  let count = 0;
  for (let k = s; k < e; k++) {
    if (c[k] === marker) count++;
    else if (c[k] !== " ") return false;
  }
  return marker === "+" ? count === 3 && e - s === 3 : count >= 3;
}

/** A table separator row: `|---|:--:|` or `--- | ---`. */
function isTableSeparator(c: readonly string[], s: number, e: number): boolean {
  let dash = false;
  let pipe = false;
  for (let k = s; k < e; k++) {
    const ch = c[k]!;
    if (ch === "-") dash = true;
    else if (ch === "|") pipe = true;
    else if (ch !== ":" && ch !== " " && ch !== "+") return false;
  }
  return dash && pipe;
}

function isTableSeparatorLine(c: readonly string[], start: number, end: number): boolean {
  let s = start;
  let e = end;
  while (s < e && isWs(c[s])) s++;
  while (e > s && isWs(c[e - 1])) e--;
  return s < e && isTableSeparator(c, s, e);
}

function processLine(
  c: readonly string[],
  h: readonly boolean[],
  start: number,
  end: number,
  state: BlockState,
  nextIsSeparator: boolean,
  out: Out,
): void {
  let s = start;
  let e = end;
  while (s < e && isWs(c[s])) s++;
  while (e > s && isWs(c[e - 1])) e--;
  if (s >= e) {
    state.table = false;
    return;
  }
  const first = c[s]!;

  if (state.fence !== null) {
    if (first === state.fence.ch) {
      const run = runLength(c, s, e, first);
      if (run >= state.fence.len && s + run === e) {
        state.fence = null;
        return;
      }
    }
    emitRaw(c, h, s, e, out);
    return;
  }
  if (first === "`" || first === "~") {
    const run = runLength(c, s, e, first);
    if (run >= 3 && (first === "~" || indexOfChar(c, "`", s + run, e) < 0)) {
      state.fence = { ch: first, len: run };
      return;
    }
  }
  if (isTableSeparator(c, s, e)) {
    state.table = true;
    return;
  }
  if (isRuleLine(c, s, e)) return;
  if (first === "i" || first === "e") {
    const text = e - s <= 2000 ? c.slice(s, e).join("") : "";
    if (MDX_IMPORT.test(text) || MDX_EXPORT.test(text)) return;
  }

  let heading = false;
  let afterList = false;
  for (let guard = 0; guard < 8 && s < e; guard++) {
    while (s < e && isWs(c[s])) s++;
    const ch = c[s];
    if (ch === ">" && c[s + 1] !== "=") {
      s++;
      continue;
    }
    if (
      (ch === "-" || ch === "*" || ch === "+" || ch === "•") &&
      (s + 1 >= e || c[s + 1] === " ")
    ) {
      s++;
      afterList = true;
      continue;
    }
    if (isDigit(ch)) {
      let k = s;
      while (k < e && k - s < 9 && isDigit(c[k])) k++;
      if ((c[k] === "." || c[k] === ")") && (k + 1 >= e || c[k + 1] === " ")) {
        s = k + 1;
        afterList = true;
        continue;
      }
    }
    if (ch === "#") {
      const run = runLength(c, s, e, "#");
      if (run <= 6 && (s + run >= e || c[s + run] === " ")) {
        s += run;
        heading = true;
        continue;
      }
    }
    if (ch === "[") {
      if (
        afterList &&
        (c[s + 1] === " " || c[s + 1] === "x" || c[s + 1] === "X") &&
        c[s + 2] === "]" &&
        (s + 3 >= e || c[s + 3] === " ")
      ) {
        s += 3;
        continue;
      }
      if (c[s + 1] === "!") {
        const close = indexOfChar(c, "]", s + 2, Math.min(e, s + 20));
        if (close > s + 2 && /^[A-Za-z]+$/.test(c.slice(s + 2, close).join(""))) {
          s = close + 1;
          continue;
        }
      }
      if (c[s + 1] === "^") {
        const close = indexOfChar(c, "]", s + 2, Math.min(e, s + 60));
        if (close > s + 2 && c[close + 1] === ":") {
          s = close + 2;
          continue;
        }
      }
    }
    break;
  }
  while (s < e && isWs(c[s])) s++;
  if (heading) {
    let k = e;
    while (k > s && c[k - 1] === "#") k--;
    if (k < e && (k === s || isWs(c[k - 1]))) {
      e = k;
      while (e > s && isWs(c[e - 1])) e--;
    }
  }
  if (s >= e) return;
  if (c[s] === "[" && e - s <= 3000 && isReferenceDefinition(c.slice(s, e).join(""))) return;

  // Table row: two or more single pipes, or a single pipe at an edge.
  let pipes = 0;
  for (let k = s; k < e; k++) {
    if (c[k] === "\\") {
      k++;
    } else if (c[k] === "|" && c[k - 1] !== "|" && c[k + 1] !== "|") {
      pipes++;
    }
  }
  if (pipes === 0) state.table = false;
  else if (nextIsSeparator) state.table = true;
  const table = pipes >= 2 || (pipes === 1 && (c[s] === "|" || c[e - 1] === "|" || state.table));
  if (table) {
    if (c[s] === "|") s++;
    if (e > s && c[e - 1] === "|" && c[e - 2] !== "\\") e--;
  }
  inline(c, h, s, e, table, out);
}

function startsWithCI(c: readonly string[], i: number, e: number, prefix: string): boolean {
  if (i + prefix.length > e) return false;
  for (let k = 0; k < prefix.length; k++) {
    if (c[i + k]!.toLowerCase() !== prefix[k]) return false;
  }
  return true;
}

/**
 * End of a link destination that starts at `open` (`c[open] === "("`): after the closing `)`.
 * A destination cut by the end of the line or the fragment delimiter ends there. -1: not a link
 * destination (whitespace then something that is not a title).
 */
function destinationEnd(c: readonly string[], open: number, e: number): number {
  const limit = Math.min(e, open + MAX_LABEL_SCAN);
  let depth = 1;
  let k = open + 1;
  while (k < limit && isWs(c[k]) && !delimAt(c, k)) k++;
  while (k < limit) {
    const ch = c[k]!;
    if (delimAt(c, k)) return k;
    if (ch === "\\") {
      k += 2;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return k + 1;
    } else if (isWs(ch)) {
      let m = k;
      while (m < limit && isWs(c[m]) && !delimAt(c, m)) m++;
      if (delimAt(c, m)) return m;
      const q = c[m];
      if (q === ")" && depth === 1) return m + 1;
      if (m >= e) return e;
      if (q !== '"' && q !== "'" && q !== "(") return -1;
      const closeCh = q === "(" ? ")" : q;
      const close = findQuote(c, closeCh, m + 1, limit);
      if (close <= -3) return -2 - close;
      if (close < 0) return limit === e ? e : -1;
      k = close + 1;
      while (k < limit && isWs(c[k])) k++;
      return c[k] === ")" ? k + 1 : e === k ? e : -1;
    }
    k++;
  }
  return limit === e ? e : -1;
}

interface LineScan {
  /** Matching bracket index, or -1. */
  readonly match: Int32Array;
  /** For an opening backtick run: [content start, content end, closing run end]; else null. */
  readonly codeClose: Int32Array;
  /** 1 for single `*`/`_` delimiters that are part of a matched emphasis pair. */
  readonly strip: Uint8Array;
  /** Length of the backtick run starting here (0 elsewhere). */
  readonly runLen: Int32Array;
}

function scanLine(c: readonly string[], s: number, e: number): LineScan {
  const len = e - s;
  const match = new Int32Array(len).fill(-1);
  const codeClose = new Int32Array(len).fill(-1);
  const runLen = new Int32Array(len);
  const strip = new Uint8Array(len);

  // Backtick runs, then pair equal-length runs in order.
  const runStarts: number[] = [];
  const runLens: number[] = [];
  for (let i = s; i < e; i++) {
    const ch = c[i]!;
    if (ch === "\\") {
      i++;
    } else if (ch === "`") {
      const run = runLength(c, i, e, "`");
      runStarts.push(i);
      runLens.push(run);
      runLen[i - s] = run;
      i += run - 1;
    }
  }
  const nextSame = new Int32Array(runStarts.length).fill(-1);
  const lastOfLength = new Map<number, number>();
  for (let r = runStarts.length - 1; r >= 0; r--) {
    nextSame[r] = lastOfLength.get(runLens[r]!) ?? -1;
    lastOfLength.set(runLens[r]!, r);
  }
  for (let r = 0; r < runStarts.length;) {
    const m = nextSame[r]!;
    if (m >= 0) {
      codeClose[runStarts[r]! - s] = runStarts[m]!;
      r = m + 1;
    } else {
      r++;
    }
  }

  // Brackets and single emphasis delimiters, outside code spans.
  const brackets: number[] = [];
  const openers = { "*": [] as number[], _: [] as number[] };
  for (let i = s; i < e; i++) {
    const ch = c[i]!;
    if (ch === "\\") {
      i++;
    } else if (ch === "`") {
      const close = codeClose[i - s]!;
      i = close >= 0 ? close + runLen[close - s]! - 1 : i + runLen[i - s]! - 1;
    } else if (ch === "[") {
      brackets.push(i);
    } else if (ch === "]") {
      const open = brackets.pop();
      if (open !== undefined) {
        match[open - s] = i;
        match[i - s] = open;
      }
    } else if (ch === "*" || ch === "_") {
      const run = runLength(c, i, e, ch);
      if (run === 1) {
        const prev = i > s ? c[i - 1] : undefined;
        const next = i + 1 < e ? c[i + 1] : undefined;
        const intraword = isAlnum(prev) && isAlnum(next);
        const canOpen = !wsOrEdge(next) && !intraword && !(ch === "_" && isAlnum(prev));
        const canClose = !wsOrEdge(prev) && !intraword && !(ch === "_" && isAlnum(next));
        const stack = openers[ch];
        if (canClose && stack.length > 0) {
          const o = stack.pop()!;
          strip[o - s] = 1;
          strip[i - s] = 1;
        } else if (canOpen) {
          stack.push(i);
        }
      } else {
        i += run - 1;
      }
    }
  }
  return { match, codeClose, strip, runLen };
}

const EMOJI_BODY = /^(?:[a-z][a-z0-9_+-]{0,30}|[+-]1)$/;
const MEMBER_EXPR =
  /^\s*[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[[\w'"]+\])+(?:\([^(){}]*\))?\s*$/;
const CALL_EXPR = /^\s*[A-Za-z_$][\w$]*\([^(){}]*\)\s*$/;
const ARROW_EXPR = /^[^{}]*=>[^{}]*$/;

/** End of a `{js expression}` (member access, call, arrow), else -1. Placeholders stay. */
function expressionEnd(c: readonly string[], i: number, e: number): number {
  if (c[i - 1] === "{" || c[i + 1] === "{" || c[i - 1] === "$") return -1;
  const limit = Math.min(e, i + 121);
  for (let k = i + 1; k < limit; k++) {
    const ch = c[k];
    if (ch === "{") return -1;
    if (ch === "}") {
      const inner = c.slice(i + 1, k).join("");
      return MEMBER_EXPR.test(inner) || CALL_EXPR.test(inner) || ARROW_EXPR.test(inner)
        ? k + 1
        : -1;
    }
  }
  return -1;
}

const URL_SCHEMES = ["https://", "http://", "ftp://", "www."];

/** Length of the URL prefix (`https://`, `www.`) at `i`, else 0. */
function urlPrefixLength(c: readonly string[], i: number, e: number): number {
  for (const scheme of URL_SCHEMES) {
    if (startsWithCI(c, i, e, scheme)) {
      return scheme === "www." && !isLetter(c[i + 4]) ? 0 : scheme.length;
    }
  }
  return 0;
}

/** End of a bare URL at `i`, else -1. */
function urlEnd(c: readonly string[], i: number, e: number): number {
  const ch = c[i];
  if (ch !== "h" && ch !== "H" && ch !== "f" && ch !== "F" && ch !== "w" && ch !== "W") return -1;
  const prev = c[i - 1];
  if (prev !== undefined && (isAlnum(prev) || "/@._-".includes(prev))) return -1;
  const prefix = urlPrefixLength(c, i, e);
  if (prefix === 0) return -1;
  const limit = Math.min(e, i + MAX_URL_SCAN);
  let k = i + prefix;
  let depth = 0;
  for (; k < limit; k++) {
    const x = c[k]!;
    if (isWs(x) || x === "<" || x === ">" || x === '"' || x === "[" || x === "]" || x === "`") {
      break;
    }
    if (x === "*" && c[k + 1] === "*") break;
    if (x === "(") depth++;
    else if (x === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  while (k > i + prefix && ".,;:!?'*_~]".includes(c[k - 1]!)) k--;
  return k > i + prefix ? k : -1;
}

function emitUrl(c: readonly string[], h: readonly boolean[], i: number, end: number, out: Out) {
  const from = i + urlPrefixLength(c, i, end);
  let to = from;
  while (to < end && c[to] !== "?" && c[to] !== "#") to++;
  while (to > from && c[to - 1] === "/") to--;
  const cut = to - from > URL_KEEP_CHARS;
  const stop = cut ? from + URL_KEEP_CHARS : to;
  for (let k = from; k < stop; k++) out.push(c[k]!, h[k]!);
  if (cut) out.push("…", false);
}

function inline(
  c: readonly string[],
  h: readonly boolean[],
  s: number,
  e: number,
  table: boolean,
  out: Out,
): void {
  const scan = scanLine(c, s, e);
  const skipTo = new Int32Array(e - s).fill(-1);
  let pendingSep = false;
  let hasContent = false;
  const flushSeparator = () => {
    if (pendingSep && hasContent) {
      out.push(" ", false);
      out.push("·", false);
      out.push(" ", false);
    }
    pendingSep = false;
  };
  const emit = (ch: string, hl: boolean) => {
    if (!isWs(ch)) flushSeparator();
    if (!isWs(ch)) hasContent = true;
    out.push(ch, hl);
  };
  let i = s;
  while (i < e) {
    const ch = c[i]!;
    const hl = h[i]!;
    const prev = i > s ? c[i - 1] : undefined;
    const next = i + 1 < e ? c[i + 1] : undefined;

    if (ch === "\\") {
      if (next === undefined) {
        i++;
      } else if (ASCII_PUNCT.has(next)) {
        emit(next, h[i + 1]!);
        i += 2;
      } else {
        emit(ch, hl);
        i++;
      }
      continue;
    }

    if (ch === "`") {
      const run = scan.runLen[i - s]!;
      const close = scan.codeClose[i - s]!;
      if (close < 0) {
        i += run;
        continue;
      }
      let from = i + run;
      let to = close;
      if (to - from >= 2 && c[from] === " " && c[to - 1] === " ") {
        let allSpace = true;
        for (let k = from; k < to; k++) if (c[k] !== " ") allSpace = false;
        if (!allSpace) {
          from++;
          to--;
        }
      }
      for (let k = from; k < to; k++) emit(c[k]!, h[k]!);
      i = close + run;
      continue;
    }

    if (ch === "!" && next === "[" && scan.match[i + 1 - s]! >= 0) {
      const close = scan.match[i + 1 - s]!;
      if (isLinkClose(c, close, e)) {
        i++;
        continue;
      }
    }

    if (ch === "[") {
      const close = scan.match[i - s]!;
      if (close >= 0) {
        if (next === "^") {
          let plain = close > i + 2 && close - i <= 60;
          for (let k = i + 2; plain && k < close; k++) if (isWs(c[k])) plain = false;
          if (plain) {
            i = close + 1;
            continue;
          }
        }
        const after = linkTail(c, scan, s, close, e);
        if (after >= 0) {
          skipTo[close - s] = after;
          i++;
          continue;
        }
      }
      emit(ch, hl);
      i++;
      continue;
    }

    if (ch === "]") {
      const jump = skipTo[i - s]!;
      if (jump >= 0) {
        i = jump;
        continue;
      }
      if (scan.match[i - s]! < 0 && next === "(") {
        const after = destinationEnd(c, i + 1, e);
        if (after >= 0) {
          i = after;
          continue;
        }
      }
      emit(ch, hl);
      i++;
      continue;
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      const run = runLength(c, i, e, ch);
      if (run >= 4 && ch !== "~") {
        emit(" ", false);
        i += run;
        continue;
      }
      if (run >= 2) {
        const intraword = ch === "_" && isAlnum(prev) && isAlnum(c[i + run]);
        const glob = ch === "*" && (prev === "/" || c[i + run] === "/");
        if (!intraword && !glob) {
          i += run;
          continue;
        }
      } else if (ch !== "~" && scan.strip[i - s] === 1) {
        i++;
        continue;
      }
      for (let k = 0; k < run; k++) emit(ch, h[i + k]!);
      i += run;
      continue;
    }

    if (ch === "-" || ch === "=" || ch === "#" || ch === "+" || ch === "^") {
      const run = runLength(c, i, e, ch);
      if (run >= 4) {
        emit(" ", false);
        i += run;
        continue;
      }
      for (let k = 0; k < run; k++) emit(ch, h[i + k]!);
      i += run;
      continue;
    }

    if (ch === "|" && table) {
      if (prev !== "|" && next !== "|") {
        pendingSep = true;
        i++;
        continue;
      }
    }

    if (ch === ":" && next !== undefined && !isAlnum(prev) && prev !== ":") {
      const close = indexOfChar(c, ":", i + 2, Math.min(e, i + 33));
      if (close > 0 && !isAlnum(c[close + 1]) && c[close + 1] !== ":") {
        if (EMOJI_BODY.test(c.slice(i + 1, close).join(""))) {
          i = close + 1;
          continue;
        }
      }
    }

    if (ch === "{") {
      const end = expressionEnd(c, i, e);
      if (end > 0) {
        i = end;
        continue;
      }
    }

    const url = urlEnd(c, i, e);
    if (url > 0) {
      flushSeparator();
      emitUrl(c, h, i, url, out);
      hasContent = true;
      i = url;
      continue;
    }

    emit(ch, hl);
    i++;
  }
}

/** True when `c[close]` (a `]`) is followed by an inline destination or a reference label. */
function isLinkClose(c: readonly string[], close: number, e: number): boolean {
  return c[close + 1] === "(" ? destinationEnd(c, close + 1, e) >= 0 : c[close + 1] === "[";
}

/** Where the text after `]` at `close` resumes if it is a link tail, else -1. */
function linkTail(
  c: readonly string[],
  scan: LineScan,
  s: number,
  close: number,
  e: number,
): number {
  const after = c[close + 1];
  if (after === "(") return destinationEnd(c, close + 1, e);
  if (after === "[") {
    const refClose = scan.match[close + 1 - s]!;
    return refClose >= 0 ? refClose + 1 : -1;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Stage 5: entities
// ---------------------------------------------------------------------------------------------

const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"],
  ["hellip", "…"],
  ["mdash", "—"],
  ["ndash", "–"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["bull", "•"],
  ["middot", "·"],
  ["rarr", "→"],
  ["larr", "←"],
]);

function isHexDigit(ch: string | undefined): boolean {
  return (
    ch !== undefined &&
    ((ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F"))
  );
}

/** The text of a numeric reference, or "" when it must not be decoded. */
function decodeNumeric(digits: string, hex: boolean): string {
  const cp = Number.parseInt(digits, hex ? 16 : 10);
  if (!Number.isFinite(cp) || cp > 0x10ffff || isDroppedCodePoint(cp)) return "";
  if (cp === 0x2028 || cp === 0x2029 || isUnicodeSpace(cp)) return " ";
  return String.fromCodePoint(cp);
}

function isEntityPrefix(body: string): boolean {
  if (body === "" || body === "#" || body === "#x" || body === "#X") return true;
  if (/^#\d{1,7}$/.test(body) || /^#[xX][0-9a-fA-F]{1,6}$/.test(body)) return true;
  for (const name of NAMED_ENTITIES.keys()) if (name.startsWith(body)) return true;
  return false;
}

function decodeEntities(src: Out): Out {
  const { c, h } = src;
  const n = c.length;
  const out = new Out();
  let i = 0;
  // A reference cut at the start of the text: `amp;`, `#x27;`.
  const head = c.slice(0, 12).join("");
  const lead = /^(?:([a-z]{2,6})|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/.exec(head);
  if (lead !== null && (lead[1] === undefined || NAMED_ENTITIES.has(lead[1]))) i = lead[0].length;
  while (i < n) {
    const ch = c[i]!;
    if (ch !== "&") {
      out.push(ch, h[i]!);
      i++;
      continue;
    }
    let k = i + 1;
    let hl = h[i]!;
    let decoded: string | null = null;
    if (c[k] === "#") {
      k++;
      const hex = c[k] === "x" || c[k] === "X";
      if (hex) k++;
      const digitsStart = k;
      while (k < n && k - digitsStart < 12 && (hex ? isHexDigit(c[k]) : isDigit(c[k]))) k++;
      if (k > digitsStart && k - digitsStart <= 10 && c[k] === ";") {
        decoded = decodeNumeric(c.slice(digitsStart, k).join(""), hex);
      }
    } else if (isLetter(c[k])) {
      const nameStart = k;
      while (k < n && k - nameStart < 10 && (isLetter(c[k]) || isDigit(c[k]))) k++;
      if (c[k] === ";") decoded = NAMED_ENTITIES.get(c.slice(nameStart, k).join("")) ?? null;
    }
    if (decoded !== null) {
      for (let m = i; m <= k; m++) if (h[m]) hl = true;
      if (decoded !== "") out.push(decoded, hl);
      i = k + 1;
      continue;
    }
    // A reference cut by the end of the text.
    let tail = i + 1;
    while (tail < n && tail - i <= 10 && (isAlnum(c[tail]) || c[tail] === "#")) tail++;
    if (tail >= n && isEntityPrefix(c.slice(i + 1, tail).join("")) && tail - i > 1) {
      i = tail;
      continue;
    }
    out.push(ch, h[i]!);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stage 6: whitespace, length, markers
// ---------------------------------------------------------------------------------------------

function collapseWhitespace(src: Out): Out {
  const { c, h } = src;
  const out = new Out();
  let i = 0;
  while (i < c.length && isWs(c[i])) i++;
  while (i < c.length) {
    if (!isWs(c[i])) {
      out.push(c[i]!, h[i]!);
      i++;
      continue;
    }
    let allHl = true;
    while (i < c.length && isWs(c[i])) {
      if (!h[i]) allHl = false;
      i++;
    }
    if (i >= c.length) break;
    out.push(" ", allHl && out.h[out.length - 1] === true && h[i] === true);
  }
  return out;
}

function capLength(src: Out, maxChars: number): Out {
  if (src.length <= maxChars) return src;
  const window = maxChars - 1;
  let cut = window;
  for (let k = window; k > window - 40 && k > 0; k--) {
    if (src.c[k] === " ") {
      cut = k;
      break;
    }
  }
  while (cut > 0 && isWs(src.c[cut - 1])) cut--;
  const out = new Out();
  for (let k = 0; k < cut; k++) out.push(src.c[k]!, src.h[k]!);
  out.push("…", false);
  return out;
}

/** Writes the markers back: one balanced pair around each highlighted run that has a word. */
function serialize(src: Out): string {
  const parts: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (!src.h[i]) {
      parts.push(src.c[i]!);
      i++;
      continue;
    }
    let k = i;
    let word = false;
    while (k < n && src.h[k]) {
      if (isAlnum(src.c[k])) word = true;
      k++;
    }
    const run = src.c.slice(i, k).join("");
    if (word) {
      const text = run.trim();
      const lead = run.slice(0, run.length - run.trimStart().length);
      const trail = run.slice(run.trimEnd().length);
      parts.push(lead, HIGHLIGHT_START, text, HIGHLIGHT_END, trail);
    } else {
      parts.push(run);
    }
    i = k;
  }
  return parts.join("");
}
