import { cleanText } from "../okf-meta";
import { suggestedGuidelinesPath } from "./names";

/**
 * Generates a draft `okf-guidelines.md` for a repository that has none (mcp-agent-access spec
 * `okf-authoring`, design decision 7). Deterministic and pure: no model, no network, no clock (the
 * caller passes `today`), no database. The text is one fixed template (the OKF rules, the keys,
 * the date forms, the reserved files, link and heading conventions) plus a section that lists the
 * repository's own vocabulary as conventions to follow before inventing new ones.
 *
 * The only text that is not the template is the repository's own vocabulary labels (types, tags,
 * statuses, folder names, the docs folder). Each is cleaned of control and direction-override
 * characters, cut at 60 characters, and placed in a code span with its backticks removed, so a
 * value can neither add Markdown structure nor add YAML to the draft's frontmatter. The draft's
 * frontmatter itself holds only constants and the date. The result passes the OKF validation with
 * no errors (checked in `guidelines.test.ts`).
 */

/** At most this many types, tags and statuses are listed, most used first. */
export const MAX_VOCABULARY_ITEMS = 30;
const MAX_LABEL_CHARS = 60;

export interface VocabularyCount {
  readonly value: string;
  /** Documents that use the value. */
  readonly count: number;
}

/** What the repository's documents already use, with counts. */
export interface GuidelinesVocabulary {
  readonly types: readonly VocabularyCount[];
  readonly tags: readonly VocabularyCount[];
  readonly statuses: readonly VocabularyCount[];
}

export interface GuidelinesRepo {
  /** The docs folder in use (`docs`), or null when the repository has none. */
  readonly docsPath: string | null;
  /** Whether the repository already counts as OKF (a document has a type, or the root index declares a version). */
  readonly isOkf: boolean;
  readonly okfVersion: string | null;
  /** Top-level folders of the docs folder, to describe the layout. */
  readonly folders: readonly string[];
}

export interface GuidelinesDraft {
  /** The whole file, frontmatter included. */
  readonly markdown: string;
  /** Where to save it in the developer's checkout: `<docs folder>/okf-guidelines.md`. */
  readonly suggestedPath: string;
  /** What to tell the developer and the agent about saving and publishing it. */
  readonly instructions: string;
}

export const EMPTY_VOCABULARY: GuidelinesVocabulary = { types: [], tags: [], statuses: [] };

/** A repository label as a safe inline code span, or null when nothing is left of it. */
function label(value: string): string | null {
  const text = cleanText(value, MAX_LABEL_CHARS).text.replaceAll("`", "'");
  return text === "" ? null : `\`${text}\``;
}

const compareCodePoints = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Most used first, then by value in code point order; blank and non-positive entries dropped. */
function ranked(items: readonly VocabularyCount[]): { shown: VocabularyCount[]; more: number } {
  const clean = items
    .filter((i) => typeof i.value === "string" && i.value.trim() !== "" && i.count > 0)
    .map((i) => ({ value: i.value, count: Math.floor(i.count) }))
    .sort((a, b) => b.count - a.count || compareCodePoints(a.value, b.value));
  return {
    shown: clean.slice(0, MAX_VOCABULARY_ITEMS),
    more: Math.max(0, clean.length - MAX_VOCABULARY_ITEMS),
  };
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

function vocabularyList(items: readonly VocabularyCount[]): string[] {
  const { shown, more } = ranked(items);
  const lines = shown.flatMap((item) => {
    const text = label(item.value);
    return text === null ? [] : [`- ${text} (${plural(item.count, "document", "documents")})`];
  });
  if (more > 0) lines.push(`- and ${plural(more, "more", "more")}, used less often`);
  return lines;
}

function isoDay(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new TypeError("today must be a valid date");
  return date.toISOString().slice(0, 10);
}

const FRONTMATTER = (today: string) =>
  [
    "---",
    "type: Guidelines",
    "title: OKF guidelines",
    "description: How documents in this repository follow the Open Knowledge Format (OKF), with the types, tags and statuses already in use.",
    "tags: [guidelines, okf]",
    "status: draft",
    `generated: ${today}`,
    "---",
  ].join("\n");

const RULES = `# OKF guidelines

These guidelines tell people and AI agents how to write documentation in this repository so that it is valid [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) (OKF) and reads the same everywhere. Follow them, and check a document before you commit it.

## The rules

1. A concept document starts with YAML frontmatter: a block between two lines that contain only \`---\`, on the very first lines of the file.
2. The frontmatter must have a \`type\`. It is the only required key.
3. A \`type\` is free-form text. Any wording is allowed, so reuse a type the repository already has (see below) before inventing a new one. Keep its case and spacing exactly as written: \`Runbook\` and \`runbook\` are two different types.
4. Every other key is optional. Unknown keys are kept and shown as they are, so add keys when they help, not to fill space.
5. Write for the reader: one level-1 heading, a one or two sentence description, and short sections.

## Frontmatter keys

- \`type\`: text, required. What kind of document this is, for example \`Guide\`.
- \`title\`: text. Defaults to the first level-1 heading, then to the file name. At most 300 characters.
- \`description\`: text. One or two sentences, shown in lists and used by search. At most 1000 characters.
- \`tags\`: a list of text values, for example \`[ops, billing]\`. At most 100, each at most 256 characters.
- \`status\`: one text value, for example \`draft\`, \`stable\` or \`deprecated\`. \`draft\` and \`deprecated\` are flagged on the page.
- \`sources\`: where the content came from: text, a mapping such as \`{title: Spec, url: https://example.com}\`, or a list of those.
- \`generated\`: the date the document was first written.
- \`verified\`: the date a person last checked that it is still correct.
- \`stale_after\`: the date after which the document should be treated as out of date. The page is marked stale from that day on.
- \`okf_version\`: only in the index.md at the root of the docs folder, to declare the OKF version the folder follows.

## Dates

Write dates as \`YYYY-MM-DD\`, or as an ISO date with a time such as \`2026-10-16T09:30:00Z\`. A date that does not exist (for example \`2026-02-29\`) or is written another way is ignored and reported as a problem.

## Reserved files

- \`index.md\` summarizes the folder it is in. It gives the folder its title and description.
- \`log.md\` is the change log of the folder.

Neither is a concept document: do not give them a \`type\`.

## Links

- Link to other documents with relative paths, for example \`./setup.md\` or \`../reference/api.md\`. The portal turns them into links between pages.
- Link only to documents that exist in the docs folder. A link to a missing document is reported.
- Use an anchor (\`./setup.md#install\`) to point at a section.

## Headings

- Use exactly one level-1 heading (\`# Title\`), as the first heading.
- Use level-2 headings (\`##\`) for sections, and do not skip levels.`;

function repositorySection(vocabulary: GuidelinesVocabulary, repo: GuidelinesRepo | null): string {
  const lines: string[] = ["## In this repository", ""];
  const docs = repo?.docsPath == null ? null : label(repo.docsPath);
  lines.push(
    docs === null
      ? "- Docs folder: not found yet. Documentation lives in a folder named `docs`, `doc` or `documentation`."
      : `- Docs folder: ${docs}.`,
  );
  if (repo !== null) {
    const version = repo.okfVersion === null ? null : label(repo.okfVersion);
    lines.push(
      repo.isOkf
        ? `- OKF: this repository already counts as OKF${version === null ? "" : `, declaring version ${version}`}.`
        : "- OKF: not yet. A repository counts as OKF as soon as one of its documents has a `type`.",
    );
    const folders = repo.folders
      .map(label)
      .filter((f): f is string => f !== null)
      .slice(0, MAX_VOCABULARY_ITEMS);
    if (folders.length > 0) lines.push(`- Folders: ${folders.join(", ")}.`);
  }

  const sections: [string, readonly VocabularyCount[], string][] = [
    [
      "Types in use",
      vocabulary.types,
      "No document declares a type yet. Choose short, clear names for the kinds of document you write, such as `Concept`, `Guide`, `Reference`, `Runbook` and `Decision`, use the same ones everywhere, and add them here.",
    ],
    ["Tags in use", vocabulary.tags, "No document has tags yet."],
    ["Statuses in use", vocabulary.statuses, "No document has a status yet."],
  ];
  lines.push(
    "",
    "Prefer the values below before inventing new ones. They are what the documents here already use, most used first.",
  );
  for (const [title, items, none] of sections) {
    const list = vocabularyList(items);
    lines.push("", `### ${title}`, "", ...(list.length > 0 ? list : [none]));
  }
  return lines.join("\n");
}

const CHECKING = `## Checking a document

Before you commit a document, check it:

- Every error must be fixed: a missing or non-text \`type\`, frontmatter that is not closed or not valid YAML, or a field the portal cannot use.
- Read the warnings: invalid dates, a missing description, a missing or second level-1 heading, links to documents that do not exist.
- If your AI agent has the DocMyRepos MCP server connected, it can run the \`validate_okf_document\` tool on the draft and fix what it reports.

New documents show up in the portal after they are committed and synced.`;

export function renderGuidelines(
  vocabulary: GuidelinesVocabulary,
  repo: GuidelinesRepo | null,
  today: Date,
): GuidelinesDraft {
  const day = isoDay(today);
  const suggestedPath = suggestedGuidelinesPath(repo?.docsPath ?? null);
  const markdown = [
    FRONTMATTER(day),
    "",
    RULES,
    "",
    repositorySection(vocabulary, repo),
    "",
    CHECKING,
    "",
  ].join("\n");
  return {
    markdown,
    suggestedPath,
    instructions: `Save this draft as ${suggestedPath} in the developer's own checkout of the repository, ask the developer to review it, set \`verified\` in its frontmatter once they have, and commit it. DocMyRepos never writes to GitHub, so the file appears in the portal only after it is committed and the next sync has run. Do not tell the developer the guidelines are published until then.`,
  };
}
