import type { Element, ElementContent, Root } from "hast";
import type { VFile } from "vfile";

import { MERMAID_CLASS } from "./sanitize";

/**
 * Mermaid block marking (task 7.6, design decision 7). A rehype plugin that `createProcessor`
 * always runs just before the `slots.mermaid` plugins and the sanitizer. It only tags; the diagram
 * is drawn in the browser by `src/components/mermaid-enhancer.tsx`. No SVG is ever produced here.
 *
 * A fenced block whose language is `mermaid` (case-insensitive; remark-rehype keeps only the
 * first word of the info string, so ```` ```mermaid title=x ```` counts) becomes
 * `<pre class="dmr-mermaid"><code class="language-mermaid">source</code></pre>`. The source is
 * kept as one text node, exactly as written. That is the one shape the sanitizer allows for
 * Mermaid (see MERMAID_CLASS in sanitize.ts); an author can write the same HTML by hand, which is
 * the same as writing a fence and harmless, since the client treats the text as untrusted input
 * to Mermaid's strict mode.
 *
 * Rendering costs client CPU, so a block over `MAX_SOURCE_BYTES` and every block past
 * `MAX_DIAGRAMS` stays an ordinary code block (with a warning in `file.data.warnings`).
 */

/** Largest diagram source, in UTF-8 bytes. */
export const MAX_SOURCE_BYTES = 50 * 1024;
/** Most diagrams per document. */
export const MAX_DIAGRAMS = 20;

export const WARN_DIAGRAM_TOO_LARGE =
  "a Mermaid diagram is too large to render and is shown as a code block";
export const WARN_TOO_MANY_DIAGRAMS =
  "too many Mermaid diagrams; the rest are shown as code blocks";

const LANGUAGE_MERMAID = "language-mermaid";

function addWarning(file: VFile, message: string): void {
  const warnings = (file.data.warnings ??= []) as string[];
  if (!warnings.includes(message)) warnings.push(message);
}

function isBlank(node: ElementContent): boolean {
  return node.type === "text" && node.value.trim() === "";
}

/** The `code` of a `pre` whose only content is one `code` with a `mermaid` language class. */
function mermaidCode(pre: Element): Element | undefined {
  let found: Element | undefined;
  for (const child of pre.children) {
    if (isBlank(child)) continue;
    if (child.type !== "element" || child.tagName !== "code" || found !== undefined) {
      return undefined;
    }
    found = child;
  }
  const classes = (found?.properties.className ?? []).map(String);
  return classes.some((c) => c.toLowerCase() === LANGUAGE_MERMAID) ? found : undefined;
}

function textOf(node: Element): string {
  let out = "";
  const stack: ElementContent[] = [...node.children].reverse();
  while (stack.length > 0) {
    const child = stack.pop();
    if (child === undefined) break;
    if (child.type === "text") out += child.value;
    else if (child.type === "element") {
      for (let i = child.children.length - 1; i >= 0; i--) {
        const grandchild = child.children[i];
        if (grandchild !== undefined) stack.push(grandchild);
      }
    }
  }
  return out;
}

/** Fence/pre positions in document order. Iterative; does not descend into `pre`. */
function findBlocks(tree: Root): { parent: Element | Root; index: number; code: Element }[] {
  const blocks: { parent: Element | Root; index: number; code: Element }[] = [];
  const stack: (Element | Root)[] = [tree];
  while (stack.length > 0) {
    const parent = stack.pop();
    if (parent === undefined) break;
    const children = parent.children as ElementContent[];
    const nested: Element[] = [];
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child === undefined || child.type !== "element") continue;
      if (child.tagName === "pre") {
        const code = mermaidCode(child);
        if (code !== undefined) blocks.push({ parent, index, code });
      } else {
        nested.push(child);
      }
    }
    // Reversed so the stack pops siblings in document order.
    for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i] as Element);
  }
  return blocks;
}

/** Rehype plugin: tags Mermaid fences. Never throws. */
export function rehypeMermaid() {
  return (tree: Root, file: VFile): void => {
    const blocks = findBlocks(tree);
    let count = 0;
    for (const block of blocks) {
      const source = textOf(block.code);
      if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
        addWarning(file, WARN_DIAGRAM_TOO_LARGE);
        continue;
      }
      if (count >= MAX_DIAGRAMS) {
        addWarning(file, WARN_TOO_MANY_DIAGRAMS);
        continue;
      }
      count++;
      (block.parent.children as ElementContent[])[block.index] = {
        type: "element",
        tagName: "pre",
        properties: { className: [MERMAID_CLASS] },
        children: [
          {
            type: "element",
            tagName: "code",
            properties: { className: [LANGUAGE_MERMAID] },
            children: [{ type: "text", value: source }],
          },
        ],
      };
    }
  };
}
