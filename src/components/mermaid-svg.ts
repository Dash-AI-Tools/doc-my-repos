/**
 * Allow-list sanitizer for the SVG string `mermaid.render` returns (defence in depth, task 7.8
 * follow-up). Mermaid's `securityLevel: "strict"` blocks scripts and handlers but still lets an
 * HTML label such as `<img src="https://...">` through, and the browser then requests that URL
 * (tracking pixel, leaks IP and Referer). Docs are untrusted, so nothing that can load a resource
 * or embed HTML may reach the page.
 *
 * Every SVG that is inserted into the DOM goes through `sanitizeMermaidSvg` (`renderDiagram` in
 * mermaid-diagram.tsx, which feeds both the inline diagram and the enlarge dialog).
 *
 * Approach
 *  - Parse as HTML (the same parser that will later read the string again through `innerHTML`),
 *    then walk the tree iteratively. Only elements in `ALLOWED_ELEMENTS` in the SVG namespace
 *    survive; anything else is removed with its children (`foreignObject`, `image`, `img`,
 *    `script`, `animate`, `set`, `iframe`, ...).
 *  - Attributes: `on*` and `src`-like names are removed. `href` / `xlink:href` are kept only as a
 *    fragment (`#id`) on `use`, and as a fragment, relative or http(s) URL on `a`. Any attribute
 *    value or `<style>` text that calls `url(...)` with something other than a fragment, or uses
 *    `@import`, `@font-face`, `image-set`, or CSS escapes, is dropped as a whole.
 *  - The serialized root `<svg>` is returned. A parse failure, a missing root, or oversized input
 *    throws `MermaidSvgError` with a fixed message.
 *
 * CSP note (group 12): `img-src` cannot be relied on here. The docs portal has to allow images
 * from GitHub and its own proxy, and external loads also come from CSS `url()` and SVG
 * presentation attributes (other directives), so this sanitizer must stay whatever the policy is.
 */

export class MermaidSvgError extends Error {
  constructor() {
    super("The diagram could not be rendered safely.");
  }
}

/** Largest SVG string accepted, in characters. */
export const MAX_SVG_LENGTH = 5_000_000;

const SVG_NS = "http://www.w3.org/2000/svg";

const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "a",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textpath",
  "marker",
  "pattern",
  "clippath",
  "mask",
  "lineargradient",
  "radialgradient",
  "stop",
  "style",
  "filter",
  "fegaussianblur",
  "feoffset",
  "feblend",
  "fecolormatrix",
  "feflood",
  "femerge",
  "femergenode",
  "fecomposite",
  "fedropshadow",
  "femorphology",
]);

/** Attributes dropped on every element regardless of value. */
const FORBIDDEN_ATTRIBUTES: ReadonlySet<string> = new Set([
  "src",
  "srcset",
  "srcdoc",
  "formaction",
  "action",
  "poster",
  "data",
  "ping",
  "background",
]);

function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** True when every `url(...)` in `text` points at a fragment, and no other loader syntax is used. */
function isSafeCss(text: string): boolean {
  if (text.includes("\\")) return false;
  if (
    /@import|@font-face|@namespace|image-set\s*\(|image\s*\(|-moz-binding|expression\s*\(/i.test(
      text,
    )
  )
    return false;
  const pattern = /url\s*\(\s*(["']?)\s*([^)"']*)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (!(match[2] ?? "").startsWith("#")) return false;
  }
  // A `url` that the pattern above did not recognise (for example a string-less odd form).
  const total = (text.match(/url\s*\(/gi) ?? []).length;
  const fragments = (text.match(/url\s*\(\s*["']?\s*#/gi) ?? []).length;
  return total === fragments;
}

function isSafeLink(value: string, element: string): boolean {
  const v = value.trim();
  if (hasControl(v)) return false;
  if (v.startsWith("#")) return true;
  if (element !== "a") return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (scheme === null) return !v.startsWith("\\");
  const name = (scheme[1] ?? "").toLowerCase();
  return name === "http" || name === "https";
}

function cleanAttributes(el: Element, name: string): void {
  for (const attr of Array.from(el.attributes)) {
    const attrName = attr.name.toLowerCase();
    const local = (attr.localName || attrName).toLowerCase();
    if (
      attrName.startsWith("on") ||
      FORBIDDEN_ATTRIBUTES.has(attrName) ||
      FORBIDDEN_ATTRIBUTES.has(local)
    ) {
      el.removeAttributeNode(attr);
      continue;
    }
    if (local === "href" && !isSafeLink(attr.value, name)) {
      el.removeAttributeNode(attr);
      continue;
    }
    if (/url\s*\(|@import/i.test(attr.value) && !isSafeCss(attr.value)) {
      el.removeAttributeNode(attr);
    }
  }
  if (name === "a") {
    el.setAttribute("rel", "noopener noreferrer");
  }
}

/** Sanitizes the SVG string from `mermaid.render`; throws `MermaidSvgError` if it cannot. */
export function sanitizeMermaidSvg(svg: string): string {
  try {
    return sanitize(svg);
  } catch {
    // Parser or serializer limits (very deep nesting) end up here too.
    throw new MermaidSvgError();
  }
}

function sanitize(svg: string): string {
  if (svg.length > MAX_SVG_LENGTH) throw new MermaidSvgError();
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svg, "text/html");
  } catch {
    throw new MermaidSvgError();
  }
  const root = doc.body.firstElementChild;
  if (root === null || root.namespaceURI !== SVG_NS || root.localName.toLowerCase() !== "svg") {
    throw new MermaidSvgError();
  }
  // Only the svg may be in the body; text or siblings around it are dropped by serializing the root.
  const pending: Element[] = [root];
  while (pending.length > 0) {
    const el = pending.pop();
    if (el === undefined) break;
    const name = el.localName.toLowerCase();
    if (el.namespaceURI !== SVG_NS || !ALLOWED_ELEMENTS.has(name)) {
      el.remove();
      continue;
    }
    cleanAttributes(el, name);
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 8) node.remove();
    }
    if (name === "style" && !isSafeCss(el.textContent ?? "")) {
      el.remove();
      continue;
    }
    pending.push(...Array.from(el.children));
  }
  return root.outerHTML;
}
