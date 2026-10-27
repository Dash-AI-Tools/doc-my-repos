/**
 * The "On this page" heading list of a document (task 9.7). Pure: no React, no database, no
 * server-only code, so the server builds it from the render result and a client component shows
 * it.
 *
 * The list comes from the headings the renderer reports for the HTML it produced
 * (`RenderResult.headings`), not from the headings stored at sync time, so every entry has a
 * matching `id` in the page. The caller passes `toId` (the pipeline's `anchorId`, which renames
 * sensitive slugs such as `__proto__`) so this module does not depend on the server pipeline.
 */

export interface OutlineHeading {
  readonly depth: number;
  readonly text: string;
  readonly slug: string;
}

export interface OutlineItem {
  readonly text: string;
  /** The DOM id of the heading in the rendered body; link to `#id`. */
  readonly id: string;
  readonly depth: number;
  readonly children: readonly OutlineItem[];
}

/** Levels listed: `h2` to `h4`. The page title is the `h1`; deeper levels are noise in a list. */
export const OUTLINE_MIN_DEPTH = 2;
export const OUTLINE_MAX_DEPTH = 4;

interface MutableItem {
  text: string;
  id: string;
  depth: number;
  children: MutableItem[];
}

/**
 * Nests the headings of levels 2 to 4 by depth: a heading goes under the nearest earlier heading
 * of a smaller depth, so `h2, h4` nests the `h4` under the `h2` and `h3, h2` makes two siblings.
 * Headings without a slug (they have no id to link to) are left out. Each id is listed once.
 */
export function buildOutline(
  headings: readonly OutlineHeading[],
  toId: (slug: string) => string,
): OutlineItem[] {
  const roots: MutableItem[] = [];
  const stack: MutableItem[] = [];
  const seen = new Set<string>();
  for (const heading of headings) {
    if (heading.depth < OUTLINE_MIN_DEPTH || heading.depth > OUTLINE_MAX_DEPTH) continue;
    if (heading.slug === "" || heading.text === "") continue;
    const id = toId(heading.slug);
    if (seen.has(id)) continue;
    seen.add(id);
    const item: MutableItem = { text: heading.text, id, depth: heading.depth, children: [] };
    while (stack.length > 0 && (stack[stack.length - 1] as MutableItem).depth >= item.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(item);
    else parent.children.push(item);
    stack.push(item);
  }
  return roots;
}

/** Every id of an outline in document order. */
export function outlineIds(items: readonly OutlineItem[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly OutlineItem[]) => {
    for (const item of list) {
      out.push(item.id);
      walk(item.children);
    }
  };
  walk(items);
  return out;
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whether the rendered body starts with an `h1` that repeats the page title. The page shows the
 * title as its own `h1`, so a body that opens with the same text would show it twice (and give
 * the page two `h1`s). The caller then hides that first `h1` (CSS `display: none`, which also
 * removes it from the accessibility tree); the stored body is not changed. A body whose first
 * `h1` differs from the title (a frontmatter `title`), or a body that does not start with an
 * `h1`, is shown as written.
 */
export function startsWithTitleHeading(
  html: string,
  headings: readonly OutlineHeading[],
  title: string,
): boolean {
  const first = headings[0];
  if (first === undefined || first.depth !== 1) return false;
  if (!/^\s*<h1[\s>]/.test(html)) return false;
  return normalizeTitle(first.text) === normalizeTitle(title);
}
