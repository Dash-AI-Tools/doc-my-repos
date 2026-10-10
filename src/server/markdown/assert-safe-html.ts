import type { Element, Root } from "hast";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import { VFile } from "vfile";

/**
 * Test-only oracle for rendered HTML. It does not import the sanitizer's lists: it re-parses
 * the final HTML string with a real HTML parser (parse5, through rehype-raw), the way a browser
 * would, and checks the result against its own, independently written rules. Used by the XSS
 * tests; not used by the app.
 */

const ALLOWED_TAGS: ReadonlySet<string> = new Set(
  (
    "a b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img input ins " +
    "kbd li ol p pre q rp rt ruby s samp section span strike strong sub summary sup table " +
    "tbody td tfoot th thead tr tt ul var"
  ).split(" "),
);

const GLOBAL_PROPS = ["align", "dir", "lang", "title"];

const PROPS: Readonly<Record<string, readonly string[]>> = {
  a: [
    "href",
    "rel",
    "id",
    "className",
    "ariaLabel",
    "ariaDescribedBy",
    "dataFootnoteRef",
    "dataFootnoteBackref",
  ],
  img: ["src", "alt", "width", "height", "loading", "referrerPolicy"],
  input: ["type", "checked", "disabled"],
  h1: ["id"],
  h2: ["id", "className"],
  h3: ["id"],
  h4: ["id"],
  h5: ["id"],
  h6: ["id"],
  ul: ["className"],
  ol: ["className", "start"],
  li: ["className", "id"],
  section: ["className", "dataFootnotes"],
  td: ["colSpan", "rowSpan"],
  th: ["colSpan", "rowSpan", "scope"],
  blockquote: ["cite"],
  q: ["cite"],
  del: ["cite", "dateTime"],
  ins: ["cite", "dateTime"],
  details: ["open"],
  pre: ["className", "style", "tabIndex"],
  code: ["className", "style"],
  span: ["className", "style"],
};

const CLASSES: Readonly<Record<string, RegExp>> = {
  a: /^(?:heading-anchor|data-footnote-backref|dmr-broken-link)$/,
  h2: /^sr-only$/,
  ul: /^contains-task-list$/,
  ol: /^contains-task-list$/,
  li: /^task-list-item$/,
  section: /^footnotes$/,
  pre: /^(?:shiki|shiki-themes|dmr-mermaid)$/,
  code: /^language-[A-Za-z0-9_+#.-]{1,32}$/,
  span: /^line$/,
};

const SCHEMES: Readonly<Record<string, readonly string[]>> = {
  href: ["http", "https", "mailto"],
  src: ["http", "https"],
  cite: ["http", "https"],
};

const STYLE_DECLARATION =
  /^(?:(?:color|background-color):#[0-9a-fA-F]{3,8}|font-style:(?:normal|italic)|font-weight:(?:normal|bold)|text-decoration:(?:none|underline|line-through)|--shiki-[a-z0-9-]{1,100}:(?:#[0-9a-fA-F]{3,8}|normal|italic|bold|none|underline|line-through))$/;

const SENSITIVE_IDS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "document",
  "window",
  "self",
  "top",
  "parent",
  "location",
  "cookie",
  "domain",
  "submit",
  "attributes",
  "children",
  "body",
  "forms",
]);

function scheme(url: string): string | null {
  const view = url.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "").replace(/[\t\n\r]/g, "");
  return /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(view)?.[1]?.toLowerCase() ?? null;
}

function external(url: string): boolean {
  const s = scheme(url);
  return s === "http" || s === "https" || /^\s*[\\/]{2}/.test(url);
}

function parseHtml(html: string): Root {
  const tree: Root = { type: "root", children: [{ type: "raw", value: html }] };
  return rehypeRaw()(tree, new VFile()) as Root;
}

const stringifier = unified().use(rehypeStringify);

function checkElement(node: Element, problems: string[]): void {
  const tag = node.tagName;
  const where = `<${tag}>`;
  if (!ALLOWED_TAGS.has(tag)) problems.push(`forbidden element ${where}`);
  const allowed = new Set([...GLOBAL_PROPS, ...(PROPS[tag] ?? [])]);
  for (const [key, value] of Object.entries(node.properties)) {
    if (/^on/i.test(key)) problems.push(`event handler ${key} on ${where}`);
    if (!allowed.has(key)) problems.push(`attribute ${key} on ${where}`);
    const schemes = SCHEMES[key];
    if (schemes !== undefined) {
      const url = String(value);
      if (/[\u0000-\u001f\u007f-\u009f]/.test(url)) problems.push(`control char in ${key}`);
      const s = scheme(url);
      if (s !== null && !schemes.includes(s)) problems.push(`scheme ${s}: in ${key} on ${where}`);
    }
    if (key === "className") {
      const pattern = CLASSES[tag];
      for (const name of Array.isArray(value) ? value : [value]) {
        if (pattern === undefined || !pattern.test(String(name))) {
          problems.push(`class ${String(name)} on ${where}`);
        }
      }
    }
    if (key === "style") {
      for (const declaration of String(value).split(";")) {
        if (!STYLE_DECLARATION.test(declaration)) problems.push(`style ${declaration}`);
      }
    }
    if (key === "id") {
      const id = String(value);
      if (SENSITIVE_IDS.has(id.toLowerCase()) || id.startsWith("_")) {
        problems.push(`sensitive id ${id}`);
      }
      if (!/^[\p{L}\p{M}\p{N}\p{Pc}%.-]+$/u.test(id)) problems.push(`odd id ${id}`);
    }
  }
  if (
    tag === "input" &&
    (node.properties.type !== "checkbox" || node.properties.disabled !== true)
  ) {
    problems.push("input that is not a disabled checkbox");
  }
  if (tag === "a" && typeof node.properties.href === "string" && external(node.properties.href)) {
    const rel = node.properties.rel;
    const list = Array.isArray(rel) ? rel.map(String) : [];
    if (!list.includes("noopener") || !list.includes("noreferrer")) {
      problems.push("external link without rel=noopener noreferrer");
    }
  }
}

function withoutEmptyValues(html: string): string {
  return html.replace(/ ([a-z-]+)=""/g, " $1");
}

/** Every problem the oracle finds in `html`; empty when it is safe. */
export function findUnsafeHtml(html: string): string[] {
  const problems: string[] = [];
  const tree = parseHtml(html);
  const stack: Root["children"] = [...tree.children];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.type === "comment") problems.push("comment");
    if (node.type === "doctype") problems.push("doctype");
    if (node.type !== "element") continue;
    checkElement(node, problems);
    stack.push(...node.children);
  }
  // Mutation XSS guards. What the browser parses must serialize back to the same string (up to
  // how an empty attribute is written), and parsing that again must change nothing.
  const once = String(stringifier.stringify(tree));
  const twice = String(stringifier.stringify(parseHtml(once)));
  if (once !== twice) problems.push("HTML is not stable under parse and serialize");
  if (withoutEmptyValues(once) !== withoutEmptyValues(html)) {
    problems.push("HTML does not round-trip through the parser");
  }
  return problems;
}

/** Throws with every problem found when `html` is not safe by the oracle's rules. */
export function assertSafeHtml(html: string, label = "html"): void {
  const problems = findUnsafeHtml(html);
  if (problems.length > 0) {
    throw new Error(`${label} is unsafe:\n  ${problems.join("\n  ")}\n--- html ---\n${html}`);
  }
}
