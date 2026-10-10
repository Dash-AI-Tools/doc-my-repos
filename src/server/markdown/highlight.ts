import type { Element, ElementContent, Root } from "hast";
import {
  bundledLanguages,
  createHighlighter,
  createJavaScriptRegexEngine,
  type BundledLanguage,
  type Highlighter,
} from "shiki";
import type { VFile } from "vfile";

import { LANGUAGE_CLASS } from "./sanitize";

/**
 * Server-side syntax highlighting (task 7.3, design decision 6). A rehype plugin for
 * `slots.highlight`. It runs before the sanitizer, so its output is as untrusted as the
 * document and must fit the code contract in sanitize.ts (classes `shiki` and `shiki-themes`
 * on `pre`, `language-*` on `code`, `line` on `span`, hex colors and `--shiki-*` variables in
 * `style`). Anything else is dropped there.
 *
 * Dual themes through CSS variables (`defaultColor: false`): every token carries
 * `--shiki-light` and `--shiki-dark` (and `-font-style` etc. when a theme sets them), the
 * `pre` carries `--shiki-light-bg` and `--shiki-dark-bg`. globals.css picks one set from the
 * `.dark` class, so a theme switch needs no re-render. Themes are `github-light` and
 * `github-dark`.
 *
 * A block that is not highlighted is left exactly as it came (`<pre><code>` with its text,
 * and the `language-*` class when the fence had one, so the UI can label it). That covers no
 * language, `text`/`plaintext`/`txt`, an unknown language, and Mermaid (7.6 handles it).
 */

export const LIGHT_THEME = "github-light";
export const DARK_THEME = "github-dark";

/** Languages loaded when the highlighter is created. Others load on demand. */
export const PRELOADED_LANGUAGES: readonly string[] = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "jsonc",
  "yaml",
  "toml",
  "bash",
  "shell",
  "diff",
  "md",
  "html",
  "css",
  "sql",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "dockerfile",
  "ini",
  "graphql",
  "xml",
  "php",
  "ruby",
  "kotlin",
  "swift",
];

/** Largest code block that is highlighted, in characters. */
export const MAX_BLOCK_CHARS = 100 * 1024;
/** Most code blocks highlighted per document. */
export const MAX_BLOCKS = 200;
/** Most characters highlighted per document, summed over blocks. */
export const MAX_TOTAL_CHARS = 160 * 1024;
/** Wall-clock budget per document; remaining blocks stay plain. */
export const MAX_HIGHLIGHT_MS = 1000;
/** Shiki skips tokenizing a line longer than this (it is emitted as one plain token). */
const MAX_LINE_CHARS = 5000;
/** Shiki stops tokenizing a line after this many milliseconds. */
const LINE_TIME_LIMIT_MS = 100;

const LANGUAGE_TOKEN = /^[A-Za-z0-9_+#.-]{1,32}$/;
/** Names that mean "no highlighting"; `mermaid` is left for task 7.6. */
const PLAIN_LANGUAGES: ReadonlySet<string> = new Set(["text", "plaintext", "txt", "plain"]);

export const WARN_BLOCK_TOO_LARGE =
  "a code block is too large to highlight and is shown as plain text";
export const WARN_TOO_MANY_BLOCKS =
  "too many code blocks to highlight; the rest are shown as plain text";
export const WARN_BUDGET = "the highlighting budget is used up; the rest is shown as plain text";

let highlighterPromise: Promise<Highlighter> | undefined;

/**
 * The shared highlighter. Created once per process (concurrent first calls share the same
 * promise); a failed creation is not cached, so the next call retries. JavaScript regex engine:
 * no WASM to load under Next or Vitest.
 */
export function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise !== undefined) return highlighterPromise;
  {
    const created = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: [...PRELOADED_LANGUAGES],
      engine: createJavaScriptRegexEngine(),
    });
    highlighterPromise = created;
    created.catch(() => {
      if (highlighterPromise === created) highlighterPromise = undefined;
    });
    return created;
  }
}

/** Test hook: forget the cached highlighter. */
export function resetHighlighterForTests(): void {
  highlighterPromise = undefined;
}

/**
 * Maps a fence's language token to a Shiki bundled language name, or `undefined` when it must
 * not be highlighted. The token is checked against a strict pattern and then against Shiki's
 * own table of names and aliases (own keys only); nothing from the document reaches an import
 * path.
 */
export function resolveLanguage(token: string): BundledLanguage | undefined {
  if (!LANGUAGE_TOKEN.test(token)) return undefined;
  const name = token.toLowerCase();
  if (PLAIN_LANGUAGES.has(name) || name === "mermaid") return undefined;
  return Object.hasOwn(bundledLanguages, name) ? (name as BundledLanguage) : undefined;
}

interface CodeBlock {
  readonly parent: Element | Root;
  readonly index: number;
  readonly pre: Element;
  readonly code: Element;
}

function classNames(node: Element): string[] {
  return (node.properties.className ?? []).map(String);
}

/** The first valid `language-*` class on `code`, or `undefined`. */
function languageClass(code: Element): string | undefined {
  return classNames(code).find((c) => LANGUAGE_CLASS.test(c));
}

function isBlank(node: ElementContent): boolean {
  return node.type === "text" && node.value.trim() === "";
}

/** `pre` whose only content is one `code` element (whitespace aside). */
function soleCode(pre: Element): Element | undefined {
  let found: Element | undefined;
  for (const child of pre.children) {
    if (isBlank(child)) continue;
    if (child.type !== "element" || child.tagName !== "code" || found !== undefined) {
      return undefined;
    }
    found = child;
  }
  return found;
}

/** Code blocks in document order. Iterative; does not descend into `pre`. */
function findBlocks(tree: Root): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const stack: (Element | Root)[] = [tree];
  while (stack.length > 0) {
    const parent = stack.pop();
    if (parent === undefined) break;
    const children = parent.children as ElementContent[];
    const found: CodeBlock[] = [];
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child === undefined || child.type !== "element") continue;
      if (child.tagName === "pre") {
        const code = soleCode(child);
        if (code !== undefined) found.push({ parent, index, pre: child, code });
      } else {
        stack.push(child);
      }
    }
    blocks.push(...found);
  }
  return blocks;
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

function addWarning(file: VFile, message: string): void {
  const warnings = (file.data.warnings ??= []) as string[];
  if (!warnings.includes(message)) warnings.push(message);
}

/** Shiki writes `class: "line"`; hast wants `className`. Only the `line` class is kept. */
function normalizeLine(node: ElementContent): ElementContent {
  if (node.type !== "element") return node;
  const { class: cls, ...rest } = node.properties;
  return cls === "line" ? { ...node, properties: { ...rest, className: ["line"] } } : node;
}

/** Shiki's `pre` rebuilt with only what the contract allows. */
function toContractPre(shikiPre: Element, languageClassName: string): Element {
  const style = shikiPre.properties.style;
  const code = shikiPre.children.find(
    (c): c is Element => c.type === "element" && c.tagName === "code",
  );
  return {
    type: "element",
    tagName: "pre",
    properties: {
      className: ["shiki", "shiki-themes"],
      ...(typeof style === "string" ? { style } : {}),
      tabIndex: 0,
    },
    children: [
      {
        type: "element",
        tagName: "code",
        properties: { className: [languageClassName] },
        children: (code?.children ?? []).map(normalizeLine),
      },
    ],
  };
}

/**
 * Rehype plugin for `slots.highlight`. Never throws: a block that cannot be highlighted stays
 * as it was. Warnings go to `file.data.warnings`, which `renderMarkdown` appends to its result.
 */
export function rehypeHighlight() {
  return async (tree: Root, file: VFile): Promise<void> => {
    const blocks = findBlocks(tree);
    if (blocks.length === 0) return;

    // Only blocks with a language Shiki knows are candidates.
    const candidates = blocks.flatMap((block) => {
      const cls = languageClass(block.code);
      const lang = cls === undefined ? undefined : resolveLanguage(cls.slice("language-".length));
      return cls === undefined || lang === undefined ? [] : [{ block, cls, lang }];
    });
    if (candidates.length === 0) return;

    let highlighter: Highlighter;
    try {
      highlighter = await getHighlighter();
    } catch {
      return;
    }

    const started = Date.now();
    let total = 0;
    let count = 0;
    for (const { block, cls, lang } of candidates) {
      if (count >= MAX_BLOCKS) {
        addWarning(file, WARN_TOO_MANY_BLOCKS);
        break;
      }
      if (Date.now() - started > MAX_HIGHLIGHT_MS) {
        addWarning(file, WARN_BUDGET);
        break;
      }
      let text = textOf(block.code);
      if (text.endsWith("\n")) text = text.slice(0, -1);
      if (text.length > MAX_BLOCK_CHARS) {
        addWarning(file, WARN_BLOCK_TOO_LARGE);
        continue;
      }
      if (total + text.length > MAX_TOTAL_CHARS) {
        addWarning(file, WARN_BUDGET);
        continue;
      }
      try {
        if (!highlighter.getLoadedLanguages().includes(lang)) {
          await highlighter.loadLanguage(lang);
        }
        const root = highlighter.codeToHast(text, {
          lang,
          themes: { light: LIGHT_THEME, dark: DARK_THEME },
          defaultColor: false,
          tokenizeMaxLineLength: MAX_LINE_CHARS,
          tokenizeTimeLimit: LINE_TIME_LIMIT_MS,
        });
        const shikiPre = root.children.find(
          (c): c is Element => c.type === "element" && c.tagName === "pre",
        );
        if (shikiPre === undefined) continue;
        (block.parent.children as ElementContent[])[block.index] = toContractPre(shikiPre, cls);
        total += text.length;
        count++;
      } catch {
        // This block stays plain; the others are unaffected.
      }
    }
  };
}
