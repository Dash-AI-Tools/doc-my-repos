import GithubSlugger from "github-slugger";
import type { Element, Root as HastRoot } from "hast";
import type { Nodes, Root as MdastRoot } from "mdast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified, type PluggableList } from "unified";
import { VFile } from "vfile";

import type { Heading } from "../db/schema";
import {
  inlineText,
  limitNesting,
  MAX_HEADING_CHARS,
  MAX_HEADING_SOURCE_CHARS,
  MAX_HEADINGS,
  MAX_SLUG_CHARS,
} from "../docs/extract";
import { parseFrontmatter, stripNul, toWellFormed } from "../docs/frontmatter";
import { parseBody } from "./parse";

/**
 * Markdown to safe HTML, at read time, from the stored body. Output is an HTML string (design
 * decision 6: the page injects it; client-only work such as Mermaid and copy buttons hooks into
 * stable class and data attributes). Pure: no React, no database, no network.
 *
 * Phase order, fixed. New work goes into a named slot, so nothing here is reordered:
 *
 *   1. prepare       frontmatter removed, line endings normalized, size and nesting bounded
 *   2. parse         remark-parse + remark-gfm (tables, task lists, strikethrough, autolinks,
 *                    footnotes)
 *   3. headings      slugs assigned with github-slugger, exactly as `extractMetadata` does
 *   4. afterParse    SLOT (remark, mdast)
 *   5. toHast        remark-rehype with raw HTML kept as `raw` nodes, then heading anchors,
 *                    then rehype-raw parses that HTML (still untrusted)
 *   6. linkRewrite   SLOT (rehype, task 7.4)
 *   7. highlight     SLOT (rehype, task 7.3)
 *   8. mermaid       SLOT (rehype, task 7.5)
 *   9. sanitize      rehype-sanitize (task 7.2 refines the schema). Always last of the tree
 *                    transforms; nothing that touches the tree runs after it.
 *  10. stringify     rehype-stringify
 *
 * `.mdx` files are plain Markdown here. `import`/`export` lines and JSX are ordinary text or raw
 * HTML, and the sanitizer drops every element that is not on the allow-list.
 */

/** Rendered body cap, equal to the stored-document cap (`DEFAULT_MAX_FILE_BYTES`). */
export const MAX_RENDER_CHARS = 256 * 1024;

export const HEADING_ANCHOR_CLASS = "heading-anchor";

/** Plugin slots. Each runs in the order listed in the phase comment above. */
export interface RenderSlots {
  /** Remark plugins on the mdast tree, after heading slugs are fixed. */
  readonly afterParse?: PluggableList;
  /** Rehype plugins; link and image rewriting (7.4). Runs before the sanitizer. */
  readonly linkRewrite?: PluggableList;
  /** Rehype plugins; code highlighting (7.3). Runs before the sanitizer. */
  readonly highlight?: PluggableList;
  /** Rehype plugins; Mermaid block marking (7.5). Runs before the sanitizer. */
  readonly mermaid?: PluggableList;
}

export interface ProcessorOptions {
  readonly slots?: RenderSlots;
  /** Replaces `DEFAULT_SANITIZE_SCHEMA`. Task 7.2 supplies the final allow-list here. */
  readonly sanitizeSchema?: SanitizeSchema;
}

export interface RenderOptions extends ProcessorOptions {
  /** Used by link rewriting later; not read here. */
  readonly path?: string;
}

export interface RenderResult {
  readonly html: string;
  /** Equal to `extractMetadata(...).headings` for the same body. */
  readonly headings: readonly Heading[];
  /** Fixed-text diagnostics; never quote the document. */
  readonly warnings: readonly string[];
}

const FOOTNOTE_ID = /^user-content-fn(?:ref)?-/;
const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

type AttributeList = NonNullable<NonNullable<SanitizeSchema["attributes"]>[string]>;

function withClassValue(list: AttributeList | undefined, value: string): AttributeList {
  const out: AttributeList = [];
  let merged = false;
  for (const entry of list ?? []) {
    if (Array.isArray(entry) && entry[0] === "className") {
      out.push(["className", ...entry.slice(1), value] as AttributeList[number]);
      merged = true;
    } else {
      out.push(entry);
    }
  }
  if (!merged) out.push(["className", value]);
  return out;
}

/**
 * Conservative default: the library allow-list plus what GFM output needs. Differences from
 * `defaultSchema`:
 *  - `id` and `name` are not allowed everywhere. `id` is allowed on headings (anchors), and on
 *    footnote references and definitions; nowhere else, so author HTML cannot
 *    plant ids that shadow page elements or DOM globals (DOM clobbering).
 *  - No clobber prefix: heading ids must equal the stored `headings.slug` so `#slug` links and
 *    the "on this page" list work. Footnote ids already carry `user-content-` from remark-rehype.
 *  - The heading anchor link keeps its class.
 */
export const DEFAULT_SANITIZE_SCHEMA: SanitizeSchema = (() => {
  const base = defaultSchema.attributes ?? {};
  const star = (base["*"] ?? []).filter((a) => a !== "id" && a !== "name");
  const attributes: NonNullable<SanitizeSchema["attributes"]> = { ...base, "*": star };
  for (const tag of HEADINGS) {
    attributes[tag] = [...(base[tag] ?? []), "id"];
  }
  attributes.li = [...(base.li ?? []), ["id", FOOTNOTE_ID]];
  attributes.a = [...withClassValue(base.a, HEADING_ANCHOR_CLASS), ["id", FOOTNOTE_ID]];
  return { ...defaultSchema, attributes, clobberPrefix: "", clobber: [] };
})();

/** Heading text exactly as `extractMetadata` derives it before slugging. */
function headingTextOf(node: Extract<Nodes, { type: "heading" }>): string {
  const raw = inlineText(node);
  const text = raw.length > MAX_HEADING_SOURCE_CHARS ? raw.slice(0, MAX_HEADING_SOURCE_CHARS) : raw;
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Assigns ids to every heading with one `GithubSlugger`, in document order, empty headings
 * included (they take a counter, as in `extractMetadata`). Stores the non-empty ones in
 * `file.data.headings`. Walks iteratively, so nesting depth cannot overflow the stack.
 */
function remarkHeadings() {
  return (tree: MdastRoot, file: VFile) => {
    const slugger = new GithubSlugger();
    const headings: Heading[] = [];
    const stack: Nodes[] = [...tree.children].reverse();
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      if (node.type === "heading") {
        const text = headingTextOf(node);
        const slug = slugger.slug(text).slice(0, MAX_SLUG_CHARS);
        const data = (node.data ??= {});
        data.hProperties = {
          ...data.hProperties,
          ...(slug === "" || text === "" ? {} : { id: slug }),
          ...(text === "" ? {} : { dataDmrHeading: "" }),
        };
        if (text !== "" && headings.length < MAX_HEADINGS) {
          headings.push({ depth: node.depth, text: text.slice(0, MAX_HEADING_CHARS), slug });
        }
        continue;
      }
      if ("children" in node && node.type !== "paragraph" && node.type !== "table") {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i] as Nodes);
        }
      }
    }
    file.data.headings = headings;
  };
}

function hastText(node: Element): string {
  let out = "";
  const stack: Element["children"] = [...node.children].reverse();
  while (stack.length > 0 && out.length < MAX_HEADING_CHARS) {
    const child = stack.pop();
    if (child === undefined) break;
    if (child.type === "text") out += child.value;
    else if (child.type === "element") stack.push(...[...child.children].reverse());
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Appends `<a class="heading-anchor" href="#slug" aria-label="Link to section: Title"></a>` to
 * every heading that came from Markdown (marked by `remarkHeadings`; the marker is removed here,
 * before `rehype-raw` runs, so author HTML cannot carry it). The link has no text: the UI draws
 * the icon with CSS on `.heading-anchor`.
 */
function rehypeHeadingAnchors() {
  return (tree: HastRoot) => {
    const stack: HastRoot["children"] = [...tree.children].reverse();
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      if (node.type !== "element") continue;
      if (node.properties.dataDmrHeading !== undefined) {
        delete node.properties.dataDmrHeading;
        const id = node.properties.id;
        if (typeof id === "string" && id !== "") {
          const title = hastText(node);
          node.children.push({
            type: "element",
            tagName: "a",
            properties: {
              className: [HEADING_ANCHOR_CLASS],
              href: `#${id}`,
              ariaLabel: title === "" ? "Link to this section" : `Link to section: ${title}`,
            },
            children: [],
          });
        }
      }
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child !== undefined) stack.push(child);
      }
    }
  };
}

function hasRawHtml(tree: HastRoot): boolean {
  const stack: HastRoot["children"] = [...tree.children];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.type === "raw") return true;
    if (node.type === "element") {
      for (const child of node.children) stack.push(child);
    }
  }
  return false;
}

/**
 * `rehype-raw` re-serializes and re-parses the whole tree (3.4 s for 200k nodes), so it only
 * runs when the Markdown held raw HTML. Without a `raw` node it would change nothing.
 */
function rehypeRawWhenNeeded() {
  const parseRaw = rehypeRaw();
  return (tree: HastRoot, file: VFile) => (hasRawHtml(tree) ? parseRaw(tree, file) : tree);
}

/** Builds the full chain. The sanitizer is always present and always after every transform. */
export function createProcessor(options: ProcessorOptions = {}) {
  const slots = options.slots ?? {};
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkHeadings)
    .use(slots.afterParse ?? [])
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeHeadingAnchors)
    .use(rehypeRawWhenNeeded)
    .use(slots.linkRewrite ?? [])
    .use(slots.highlight ?? [])
    .use(slots.mermaid ?? [])
    .use(rehypeSanitize, options.sanitizeSchema ?? DEFAULT_SANITIZE_SCHEMA)
    .use(rehypeStringify);
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Frontmatter removed, NUL and lone surrogates cleaned, LF only, bounded. */
function prepare(source: string, warnings: string[]): string {
  const parsed = parseFrontmatter(stripNul(toWellFormed(source)));
  let body = parsed.body.replace(/\r\n?/g, "\n");
  if (body.length > MAX_RENDER_CHARS) {
    const last = body.charCodeAt(MAX_RENDER_CHARS - 1);
    body = body.slice(
      0,
      last >= 0xd800 && last <= 0xdbff ? MAX_RENDER_CHARS - 1 : MAX_RENDER_CHARS,
    );
    warnings.push("document is longer than the render limit and was cut");
  }
  return limitNesting(body);
}

/**
 * The only entry point that returns HTML. Never throws: if the pipeline fails, the text is
 * returned escaped in a `<pre>`.
 */
export async function renderMarkdown(
  source: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const warnings: string[] = [];
  const body = prepare(source, warnings);
  try {
    const processor = createProcessor(options);
    const file = new VFile({ value: body });
    const hast = await processor.run(parseBody(body, warnings), file);
    return {
      html: String(processor.stringify(hast, file)),
      headings: (file.data.headings as Heading[] | undefined) ?? [],
      warnings,
    };
  } catch {
    warnings.push("rendering failed; showing plain text");
    return { html: `<pre>${escapeHtml(body)}</pre>`, headings: [], warnings };
  }
}
