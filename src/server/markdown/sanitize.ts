import type { Element, Properties, Root } from "hast";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";

import { MAX_SLUG_CHARS } from "../docs/extract";

/**
 * The XSS boundary for rendered documents. Docs come from third-party repositories, so every
 * byte of the HTML this module returns is attacker-controlled except the fixed values it adds.
 *
 * Two steps, both inside the one plugin `rehypeSafeHtml`, which `createProcessor` runs as the
 * last tree transform (only `rehype-stringify` follows; the processor is frozen, so nothing
 * can be added after it):
 *
 *   1. `rehype-sanitize` with `SANITIZE_SCHEMA`, an allow-list. Anything not listed is removed.
 *   2. `harden`, a fixed pass over the sanitized tree. It only removes values or sets fixed
 *      ones: it filters inline `style` declarations, re-checks URL schemes the way a browser
 *      reads them, applies the id policy, and adds `rel` to external links and `loading` to
 *      images. It runs after the sanitizer because those rules cannot be written as a schema
 *      (per-declaration CSS, browser URL normalization, renaming ids) and because the values it
 *      adds would otherwise have to be allowed for author HTML too (an author `rel` or
 *      `target` is never kept; ours is set unconditionally).
 *
 * The schema starts from `defaultSchema` (GitHub's rules) and narrows it. Differences:
 *
 * Elements
 *  - Kept from the default: text formatting (`b i em strong s strike del ins sub sup kbd samp
 *    var tt q`), `p br hr div span`, headings, lists, `dl dt dd`, `blockquote`, `pre code`,
 *    tables, `details summary`, `ruby rt rp`, `a`, `img`, `input` (task lists only, below),
 *    `section` (footnotes).
 *  - Removed: `picture` and `source`. `<source srcset>` would load images that bypass the
 *    image rewriting and proxy (7.5) and `srcset` is not URL-checked by the sanitizer. A
 *    `<picture>` is unwrapped, so its fallback `<img>` still shows.
 *  - Not added: `mark`, `abbr`, `figure`, `caption`, `u`, `center`, `font`, `svg`, `math`. The
 *    spec renders none of them; unknown elements are unwrapped and their text kept. Mermaid
 *    diagrams are drawn in the browser from a `<pre>` placeholder, never from inline SVG.
 *  - Dropped together with their content (`STRIPPED`): script and style containers, embedding
 *    and plugin elements, frames, forms and form controls, media, foreign content (`svg`,
 *    `math`), raw-text and RCDATA elements (`xmp`, `plaintext`, `textarea`, `title`,
 *    `noscript`, `noembed`, `noframes`, `template`), and document-level elements (`base`,
 *    `meta`, `link`, `head`). Their content is either code, a mutation-XSS vehicle, or a
 *    fallback that would leak as stray text.
 *  - Comments and doctypes are removed (default).
 *
 * Attributes
 *  - Global: only `align` (left, right, center, justify, top, middle, bottom: READMEs use
 *    `<p align="center">` and `<img align="right">`), `dir`, `lang` and `title`. The default's
 *    other globals are gone, notably `id`, `name` (DOM clobbering), `tabIndex` and `accessKey`
 *    (focus and key hijacking), `action`, `method`, `value`, form attributes, and legacy
 *    presentational attributes.
 *  - Never allowed anywhere: `on*`, `style` (except below), `class` (except below), `name`,
 *    `target`, `rel` (set by `harden`), `srcset`, `srcdoc`, `formaction`, `xlink:href`, `ping`,
 *    `background`, `poster`, `data`, `longdesc`, microdata.
 *  - `a`: `href` (http, https, mailto, or relative, including `#fragment` and `//host`),
 *    `aria-label`, `aria-describedby="footnote-label"`, the GFM footnote data attributes, an id
 *    matching `user-content-fn-*` or `user-content-fnref-*`, and the classes `heading-anchor`,
 *    `data-footnote-backref`, `dmr-broken-link`.
 *  - `img`: `src` (http, https or relative; no `data:`), `alt`, `width` and `height` (digits,
 *    optional `%`). `harden` adds `loading="lazy"`, and `referrerpolicy="no-referrer"` for
 *    absolute sources, so a third-party image host does not learn the page URL (which names
 *    private repositories).
 *  - `input`: `type="checkbox"`, `checked`, `disabled` only, and `type` and `disabled` are
 *    forced. Any other `<input>` becomes an inert disabled checkbox.
 *  - Task lists, footnotes, tables: `contains-task-list`, `task-list-item`, `footnotes`,
 *    `sr-only` (footnote heading), `data-footnotes`, `colspan`, `rowspan`, `scope`, `start`.
 *  - `blockquote`, `q`, `del`, `ins`: `cite` (http, https or relative); `del`, `ins` also
 *    `datetime`. `details`: `open`.
 *  - Code (Shiki, task 7.3): `pre` may have the classes `shiki`, `shiki-themes`, `dmr-mermaid`
 *    and `tabindex="0"`; `code` a class `language-<name>`; `span` the class `line`. `pre`,
 *    `code` and `span` may have a `style` that `filterStyle` reduces to hex colors and font
 *    keywords (see there). Shiki's dual themes need inline colors; nothing else may be styled.
 *
 * Ids (DOM clobbering)
 *  - `id` is allowed on headings, and on footnote `a` and `li` with the footnote prefix. No
 *    clobber prefix is added, so heading ids equal the stored `headings.slug`.
 *  - A heading id must look like a github-slugger slug (letters, marks, numbers, connector
 *    punctuation, `-`); other author-written ids are removed.
 *  - A heading id that is a sensitive DOM or JavaScript name (`DENIED_IDS`, or anything that
 *    starts with `_`, such as `__proto__` or framework globals like `__next_f`) is renamed to
 *    `user-content-<id>`, and every `href="#<id>"` in the document with it, so the anchor still
 *    works. Use `anchorId(slug)` when linking to a heading from outside the rendered HTML.
 *  - `name` is never allowed, so no element can clobber `document.<name>`, and since forms,
 *    objects, embeds and frames are dropped, none of the form or document named-access vectors
 *    exist.
 *
 * URLs
 *  - The sanitizer accepts a scheme only on an exact, case-sensitive match, so obfuscated
 *    schemes (entities are already decoded by the HTML parser; mixed case, tabs, newlines or
 *    control characters inside the scheme; leading spaces) fail closed. `harden` checks again
 *    with the browser's normalization (strip leading and trailing C0 and space, remove tab and
 *    newline) and removes any URL that still holds a control character.
 *  - External links (absolute http(s), or `//host`, also written with backslashes) get
 *    `rel="nofollow noopener noreferrer"`. No `target` is set: links open in the same tab,
 *    which avoids reverse tabnabbing entirely; `noreferrer` keeps private page URLs from
 *    leaking.
 *
 * Mutation XSS
 *  - With foreign content, comments and raw-text elements gone, the serialized HTML re-parses
 *    to the same tree. As a belt, `harden` drops `title`, `alt` and `aria-label` values that
 *    hold a comment or CDATA delimiter or a raw-text end tag (`</style`, `</noscript`, ...),
 *    the sequences mutation-XSS payloads hide in attributes. Ordinary `<tag>` mentions stay,
 *    so a heading about `<details>` keeps its anchor label.
 */

export const HEADING_ANCHOR_CLASS = "heading-anchor";

/** Class 7.4 puts on a link whose target does not exist. */
export const BROKEN_LINK_CLASS = "dmr-broken-link";

/** Class 7.6 puts on the `<pre>` that holds a Mermaid diagram's source. */
export const MERMAID_CLASS = "dmr-mermaid";

/** Prefix for renamed heading ids. Same as the footnote ids from remark-rehype. */
export const RENAMED_ID_PREFIX = "user-content-";

/** `code` class from a fence's info string; one that does not match is dropped. */
export const LANGUAGE_CLASS = /^language-[A-Za-z0-9_+#.-]{1,32}$/;

/** A github-slugger slug: what a heading id may look like. */
export const SLUG_ID = new RegExp(`^[\\p{L}\\p{M}\\p{N}\\p{Pc}-]{1,${MAX_SLUG_CHARS}}$`, "u");

/** Footnote reference and definition ids from remark-rehype. */
export const FOOTNOTE_ID = new RegExp(
  `^user-content-fn(?:ref)?-[^\\s"'<>&\`=]{1,${MAX_SLUG_CHARS}}$`,
);

/**
 * Heading ids that are renamed. Lowercase; compared case-insensitively. JavaScript object
 * members (lookups in plain objects), window and document members, and form members.
 */
export const DENIED_IDS: ReadonlySet<string> = new Set([
  "constructor",
  "prototype",
  "hasownproperty",
  "isprototypeof",
  "propertyisenumerable",
  "tostring",
  "tolocalestring",
  "valueof",
  "window",
  "self",
  "top",
  "parent",
  "frames",
  "opener",
  "globalthis",
  "document",
  "defaultview",
  "location",
  "cookie",
  "domain",
  "body",
  "head",
  "forms",
  "currentscript",
  "implementation",
  "submit",
  "reset",
  "action",
  "method",
  "attributes",
  "children",
  "elements",
]);

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/** Allowed but unwrapped by `rehype-sanitize`'s default, now removed (see the header). */
const REMOVED_TAGS: ReadonlySet<string> = new Set(["picture", "source"]);

/** Not on the allow-list and dropped together with everything inside. */
export const STRIPPED: readonly string[] = [
  "script",
  "style",
  "template",
  "noscript",
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
  "listing",
  "textarea",
  "title",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "fencedframe",
  "form",
  "button",
  "select",
  "option",
  "optgroup",
  "datalist",
  "svg",
  "math",
  "video",
  "audio",
  "canvas",
  "head",
  "base",
  "meta",
  "link",
];

const ALIGN = /^(?:left|right|center|justify|top|middle|bottom)$/i;
const DIMENSION = /^\d{1,4}%?$/;

type AttributeList = NonNullable<NonNullable<SanitizeSchema["attributes"]>[string]>;

const headingAttributes = (tag: (typeof HEADINGS)[number]): AttributeList =>
  tag === "h2"
    ? [
        ["id", SLUG_ID],
        ["className", "sr-only"],
      ]
    : [["id", SLUG_ID]];

/** The allow-list. Every entry is explained in the header comment. */
export const SANITIZE_SCHEMA: SanitizeSchema = {
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => !REMOVED_TAGS.has(tag)),
  ancestors: defaultSchema.ancestors,
  strip: [...STRIPPED],
  allowComments: false,
  allowDoctypes: false,
  attributes: {
    "*": [
      ["align", ALIGN],
      ["dir", /^(?:ltr|rtl|auto)$/i],
      ["lang", /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/],
      "title",
    ],
    a: [
      "href",
      "ariaLabel",
      ["ariaDescribedBy", "footnote-label"],
      "dataFootnoteRef",
      "dataFootnoteBackref",
      ["id", FOOTNOTE_ID],
      ["className", HEADING_ANCHOR_CLASS, "data-footnote-backref", BROKEN_LINK_CLASS],
    ],
    img: ["src", "alt", ["width", DIMENSION], ["height", DIMENSION]],
    input: [
      ["type", "checkbox"],
      ["checked", true],
      ["disabled", true],
    ],
    ...Object.fromEntries(HEADINGS.map((tag) => [tag, headingAttributes(tag)])),
    ul: [["className", "contains-task-list"]],
    ol: [
      ["className", "contains-task-list"],
      ["start", /^-?\d{1,9}$/],
    ],
    li: [
      ["className", "task-list-item"],
      ["id", FOOTNOTE_ID],
    ],
    section: ["dataFootnotes", ["className", "footnotes"]],
    td: [
      ["colSpan", /^\d{1,3}$/],
      ["rowSpan", /^\d{1,4}$/],
    ],
    th: [
      ["colSpan", /^\d{1,3}$/],
      ["rowSpan", /^\d{1,4}$/],
      ["scope", /^(?:row|col|rowgroup|colgroup)$/],
    ],
    blockquote: ["cite"],
    q: ["cite"],
    del: ["cite", "dateTime"],
    ins: ["cite", "dateTime"],
    details: [["open", true]],
    pre: [["className", "shiki", "shiki-themes", MERMAID_CLASS], ["tabIndex", 0], "style"],
    code: [["className", LANGUAGE_CLASS], "style"],
    span: [["className", "line"], "style"],
  },
  protocols: {
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
    cite: ["http", "https"],
  },
  required: { input: { type: "checkbox", disabled: true } },
  clobber: [],
  clobberPrefix: "",
};

/* ---------------------------------------------------------------- style ---------------- */

/** Elements that may keep a (filtered) `style`. */
const STYLED: ReadonlySet<string> = new Set(["pre", "code", "span"]);

const MAX_STYLE_CHARS = 512;
const MAX_DECLARATIONS = 16;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FONT_STYLE = /^(?:normal|italic)$/;
const FONT_WEIGHT = /^(?:normal|bold)$/;
const TEXT_DECORATION = /^(?:none|underline|line-through)$/;

const STYLE_PROPERTIES: ReadonlyMap<string, RegExp> = new Map([
  ["color", HEX_COLOR],
  ["background-color", HEX_COLOR],
  ["font-style", FONT_STYLE],
  ["font-weight", FONT_WEIGHT],
  ["text-decoration", TEXT_DECORATION],
]);

/** Shiki's dual-theme variables, such as `--shiki-dark` or `--shiki-dark-font-style`. */
const SHIKI_VARIABLE = /^--shiki-[a-z0-9]{1,24}(?:-[a-z0-9]{1,24}){0,3}$/;

function shikiValueOk(value: string): boolean {
  return (
    HEX_COLOR.test(value) ||
    FONT_STYLE.test(value) ||
    FONT_WEIGHT.test(value) ||
    TEXT_DECORATION.test(value)
  );
}

/**
 * Reduces an inline style to the declarations Shiki emits: `color` and `background-color` as
 * hex, `font-style`, `font-weight`, `text-decoration` as fixed keywords, and `--shiki-*`
 * variables holding one of those. Property names are matched lowercase and exactly. The
 * result is rebuilt from the validated parts only, so it can hold nothing but
 * `[a-z0-9#:;-]`: no `url()`, `expression()`, `var()`, `!important`, escapes, comments or
 * quotes. Returns `undefined` when nothing is left.
 */
export function filterStyle(value: string): string | undefined {
  if (value.length > MAX_STYLE_CHARS) return undefined;
  const kept: string[] = [];
  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim();
    const val = declaration.slice(colon + 1).trim();
    const rule = STYLE_PROPERTIES.get(property);
    const ok =
      rule !== undefined ? rule.test(val) : SHIKI_VARIABLE.test(property) && shikiValueOk(val);
    if (ok) kept.push(`${property}:${val}`);
    if (kept.length >= MAX_DECLARATIONS) break;
  }
  return kept.length === 0 ? undefined : kept.join(";");
}

/* ---------------------------------------------------------------- URLs ----------------- */

const URL_SCHEMES: Readonly<Record<string, readonly string[]>> = {
  href: ["http", "https", "mailto"],
  src: ["http", "https"],
  cite: ["http", "https"],
};

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const EDGE_SPACE = /^[\u0000- ]+|[\u0000- ]+$/g;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** The URL as a browser's URL parser sees it before reading the scheme. */
function browserView(url: string): string {
  return url.replace(EDGE_SPACE, "").replace(/[\t\n\r]/g, "");
}

/** The scheme a browser would read, lowercase, or `null` for a relative URL. */
export function urlScheme(url: string): string | null {
  return SCHEME.exec(browserView(url))?.[1]?.toLowerCase() ?? null;
}

/**
 * Whether `url` may stay in attribute `attribute` (`href`, `src` or `cite`): relative, or an
 * allowed scheme, and free of control characters.
 */
export function isAllowedUrl(attribute: string, url: string): boolean {
  if (CONTROL.test(url)) return false;
  const scheme = urlScheme(url);
  return scheme === null || (URL_SCHEMES[attribute] ?? []).includes(scheme);
}

/** Absolute http(s), or protocol-relative (`//host`, which browsers also accept as `\\host`). */
export function isExternalUrl(url: string): boolean {
  const view = browserView(url);
  const scheme = urlScheme(view);
  return scheme === "http" || scheme === "https" || /^[\\/]{2}/.test(view);
}

/* ---------------------------------------------------------------- ids ------------------ */

function deniedId(id: string): boolean {
  return id.startsWith("_") || DENIED_IDS.has(id.toLowerCase());
}

/**
 * The id a heading with slug `slug` gets in the rendered HTML: the slug itself, or
 * `user-content-<slug>` when the slug is a sensitive DOM name. Links to a heading from outside
 * the rendered body (the "on this page" list, search results) must use this.
 */
export function anchorId(slug: string): string {
  return deniedId(slug) ? `${RENAMED_ID_PREFIX}${slug}` : slug;
}

const HEADING_TAGS: ReadonlySet<string> = new Set(HEADINGS);

/** The id an element may keep, or `undefined` to remove it. */
function safeId(tagName: string, id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  if (HEADING_TAGS.has(tagName)) return SLUG_ID.test(id) ? anchorId(id) : undefined;
  if ((tagName === "a" || tagName === "li") && FOOTNOTE_ID.test(id)) return id;
  return undefined;
}

/* ---------------------------------------------------------------- harden --------------- */

const MARKUP =
  /<!--|--!?>|\]>|<!\[CDATA\[|<\/(?:script|style|title|textarea|xmp|noscript|noembed|noframes|iframe|plaintext|template|svg|math)/i;
const TEXT_ATTRIBUTES = ["title", "alt", "ariaLabel"] as const;
const URL_ATTRIBUTES = ["href", "src", "cite"] as const;
const EXTERNAL_REL = ["nofollow", "noopener", "noreferrer"];

function hardenElement(node: Element): void {
  const props: Properties = node.properties;
  const tag = node.tagName;

  if (props.style !== undefined) {
    const style =
      STYLED.has(tag) && typeof props.style === "string" ? filterStyle(props.style) : undefined;
    if (style === undefined) delete props.style;
    else props.style = style;
  }

  for (const key of URL_ATTRIBUTES) {
    const value = props[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !isAllowedUrl(key, value)) delete props[key];
  }

  for (const key of TEXT_ATTRIBUTES) {
    const value = props[key];
    if (value !== undefined && (typeof value !== "string" || MARKUP.test(value))) {
      delete props[key];
    }
  }

  if (props.id !== undefined) {
    const id = safeId(tag, props.id);
    if (id === undefined) delete props.id;
    else props.id = id;
  }

  // A class list emptied by the allow-list would serialize as `class=""`.
  if (Array.isArray(props.className) && props.className.length === 0) delete props.className;

  // Never kept from the author; `rel` is set below for external links only.
  delete props.target;
  delete props.rel;
  delete props.name;

  if (tag === "a" && typeof props.href === "string") {
    const href = props.href;
    if (href.startsWith("#") && deniedId(href.slice(1))) {
      props.href = `#${anchorId(href.slice(1))}`;
    } else if (isExternalUrl(href)) {
      props.rel = [...EXTERNAL_REL];
    }
  }

  if (tag === "img") {
    props.loading = "lazy";
    if (typeof props.src === "string" && isExternalUrl(props.src)) {
      props.referrerPolicy = "no-referrer";
    }
  }
}

/** The fixed post-sanitize pass (see the header). Iterative: nesting cannot overflow. */
function harden(tree: Root): void {
  const stack: Root["children"] = [...tree.children];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.type !== "element") continue;
    hardenElement(node);
    for (const child of node.children) stack.push(child);
  }
}

/**
 * The sanitizing step of the pipeline: `rehype-sanitize` with `SANITIZE_SCHEMA`, then
 * `harden`. Must be the last tree transform.
 */
export function rehypeSafeHtml() {
  const clean = rehypeSanitize(SANITIZE_SCHEMA);
  return (tree: Root): Root => {
    const safe = clean(tree);
    harden(safe);
    return safe;
  };
}
