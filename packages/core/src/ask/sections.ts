/**
 * Excerpt selection for Ask (ask-the-docs design decision 2): split a document body into sections
 * at its stored headings, score sections against the question's words, and pick the best few within
 * a fixed budget. Pure and deterministic: same input, same excerpts, no database and no model.
 */

/** A stored heading (`documents.headings`). `slug` links with `anchorId(slug)` on the server. */
export interface SectionHeading {
  readonly depth: number;
  readonly text: string;
  readonly slug: string;
}

/** A piece of a document. `heading` is null for the intro (text before the first heading). */
export interface Section {
  readonly heading: SectionHeading | null;
  readonly text: string;
}

export const MAX_SECTION_CHARS = 2500;
export const MAX_SECTIONS_PER_DOC = 2;
export const MAX_SECTIONS_TOTAL = 8;
export const MAX_EXCERPT_CHARS = 12_000;

// --- splitting ---------------------------------------------------------------------------------

interface Candidate {
  readonly line: number;
  /** Lines the heading itself occupies (2 for a setext heading). */
  readonly span: number;
  readonly depth: number;
  readonly key: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

/** Heading text with Markdown punctuation, case and spacing removed, to compare source and stored. */
function headingKey(text: string): string {
  return text
    .replace(/[*_`~[\]()<>\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function findCandidates(lines: readonly string[]): Candidate[] {
  const out: Candidate[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const open = FENCE.exec(line);
    if (fence !== null) {
      if (open && open[1]?.[0] === fence[0] && (open[1]?.length ?? 0) >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1] ?? null;
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      out.push({ line: i, span: 1, depth: atx[1]?.length ?? 1, key: headingKey(atx[2] ?? "") });
      continue;
    }
    const next = lines[i + 1];
    if (line.trim() !== "" && next !== undefined && !/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      const setext = SETEXT.exec(next);
      if (setext) {
        out.push({
          line: i,
          span: 2,
          depth: setext[1]?.startsWith("=") ? 1 : 2,
          key: headingKey(line),
        });
        i += 1;
      }
    }
  }
  return out;
}

/** Splits `text` at paragraph breaks into chunks of at most `max` characters. */
function chunk(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let current = "";
  const push = () => {
    if (current !== "") out.push(current);
    current = "";
  };
  for (const paragraph of text.split(/\n[ \t]*\n/)) {
    let rest = paragraph;
    while (rest.length > max) {
      push();
      let cut = rest.lastIndexOf(" ", max);
      if (cut < max / 2) cut = max;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest === "") continue;
    if (current !== "" && current.length + 2 + rest.length > max) push();
    current = current === "" ? rest : `${current}\n\n${rest}`;
  }
  push();
  return out.filter((c) => c !== "");
}

/**
 * Splits a document body at its stored headings. A stored heading that cannot be found in the body
 * (for example one that came from HTML) does not start a section; its text stays with the section
 * before it. Text before the first heading is the intro. Each section is capped at
 * `MAX_SECTION_CHARS`: longer ones are split at paragraph breaks into several sections that share
 * the heading. Empty sections are dropped. Headings inside code fences are ignored.
 */
export function splitSections(body: string, headings: readonly SectionHeading[]): Section[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const candidates = findCandidates(lines);

  const starts: { candidate: Candidate; heading: SectionHeading }[] = [];
  let cursor = 0;
  for (const heading of headings) {
    const key = headingKey(heading.text);
    const found = candidates.findIndex(
      (c, i) => i >= cursor && c.depth === heading.depth && c.key === key,
    );
    if (found === -1) continue;
    starts.push({ candidate: candidates[found]!, heading });
    cursor = found + 1;
  }

  const raw: { heading: SectionHeading | null; text: string }[] = [];
  const first = starts[0]?.candidate.line ?? lines.length;
  raw.push({ heading: null, text: lines.slice(0, first).join("\n") });
  starts.forEach((start, i) => {
    const from = start.candidate.line + start.candidate.span;
    const to = starts[i + 1]?.candidate.line ?? lines.length;
    raw.push({ heading: start.heading, text: lines.slice(from, to).join("\n") });
  });

  return raw.flatMap(({ heading, text }) =>
    chunk(text.trim(), MAX_SECTION_CHARS)
      .filter((piece) => piece.trim() !== "")
      .map((piece) => ({ heading, text: piece })),
  );
}

// --- scoring -----------------------------------------------------------------------------------

const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a about after all also am an and any are as at be been but by can could did do does for from " +
    "had has have how i if in into is it its me my no not of on or our should so than that the " +
    "their them then there these they this to up us was we were what when where which who why " +
    "will with would you your " +
    "al como con cual cuando de del donde el ella ellos en es esta este esto la las lo los me mi " +
    "no o para pero por que se si sin su sus un una uno y"
  ).split(" "),
);

/** Lower-cases, strips a plural `s` (not `ss`) from words of four or more letters. */
function normalizeWord(word: string): string {
  const lower = word.toLowerCase();
  return lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")
    ? lower.slice(0, -1)
    : lower;
}

function words(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).map(normalizeWord);
}

/** The words of a question worth matching: no stop-words, no single characters, no repeats. */
export function queryTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const word of words(text)) {
    if (word.length < 2 || STOP_WORDS.has(word)) continue;
    seen.add(word);
  }
  return [...seen];
}

/** At most this many words go into a fallback keyword query. */
export const MAX_SEARCH_WORDS = 8;

/**
 * Plain keywords from a question for the full-text search: lower-cased, stop-words and single
 * characters dropped, repeats removed, in order, at most `MAX_SEARCH_WORDS`. Words only (letters and
 * digits), no operators, and not stemmed, because the search index is unstemmed. Empty when the
 * question has no keyword.
 */
export function searchWords(text: string): string[] {
  const seen = new Set<string>();
  for (const word of (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.toLowerCase())) {
    if (word.length < 2 || STOP_WORDS.has(word)) continue;
    seen.add(word);
    if (seen.size === MAX_SEARCH_WORDS) break;
  }
  return [...seen];
}

const K1 = 1.2;
const B = 0.75;
const AVERAGE_LENGTH = 800;
const HEADING_WEIGHT = 3;
const TITLE_WEIGHT = 1;

/**
 * Term-overlap score of one section: for each query term the section contains (in its text or its
 * heading), a saturating term frequency with length normalization (BM25 style), plus a bonus when
 * the term is in the heading and a smaller one when it is also in the document title. The title
 * only counts for terms the section itself has, so a section never scores from its document's
 * title alone. Zero when no query term occurs in the section.
 */
export function scoreSection(terms: readonly string[], section: Section, title: string): number {
  if (terms.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const word of words(section.text)) counts.set(word, (counts.get(word) ?? 0) + 1);
  const headingWords = new Set(words(section.heading?.text ?? ""));
  const titleWords = new Set(words(title));
  const lengthFactor = 1 - B + (B * section.text.length) / AVERAGE_LENGTH;

  let score = 0;
  for (const term of terms) {
    const tf = counts.get(term) ?? 0;
    const inHeading = headingWords.has(term);
    if (tf === 0 && !inHeading) continue;
    if (tf > 0) score += (tf * (K1 + 1)) / (tf + K1 * lengthFactor);
    if (inHeading) score += HEADING_WEIGHT;
    if (titleWords.has(term)) score += TITLE_WEIGHT;
  }
  return score;
}

// --- selection ---------------------------------------------------------------------------------

export interface SectionSource {
  /** Caller's key for the document, returned on each selected section. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly headings: readonly SectionHeading[];
}

export interface SelectedSection extends Section {
  readonly key: string;
  readonly score: number;
}

export interface SelectionBudget {
  readonly maxSectionsPerDoc: number;
  readonly maxSections: number;
  readonly maxChars: number;
}

export const DEFAULT_BUDGET: SelectionBudget = {
  maxSectionsPerDoc: MAX_SECTIONS_PER_DOC,
  maxSections: MAX_SECTIONS_TOTAL,
  maxChars: MAX_EXCERPT_CHARS,
};

/**
 * Picks the excerpts for a question. Per document: its best `maxSectionsPerDoc` sections by score
 * (document order breaks ties); a document whose best section scores zero (it matched only through
 * its description) contributes its intro, or its first section when there is no intro. Overall: the
 * highest scores first (earlier documents, then earlier sections, break ties), at most
 * `maxSections` sections and `maxChars` characters; a section that does not fit is skipped.
 * `docs` should be in relevance order.
 */
export function selectSections(
  docs: readonly SectionSource[],
  question: string,
  budget: SelectionBudget = DEFAULT_BUDGET,
): SelectedSection[] {
  const terms = queryTerms(question);
  const candidates: (SelectedSection & { order: number })[] = [];

  docs.forEach((doc, docIndex) => {
    const scored = splitSections(doc.body, doc.headings).map((section, i) => ({
      key: doc.key,
      heading: section.heading,
      text: section.text,
      score: scoreSection(terms, section, doc.title),
      order: docIndex * 100_000 + i,
    }));
    if (scored.length === 0) return;
    const best = [...scored].sort((a, b) => b.score - a.score || a.order - b.order);
    if ((best[0]?.score ?? 0) === 0) {
      candidates.push(scored.find((s) => s.heading === null) ?? scored[0]!);
      return;
    }
    candidates.push(...best.slice(0, budget.maxSectionsPerDoc).filter((s) => s.score > 0));
  });

  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  const picked: SelectedSection[] = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (picked.length >= budget.maxSections) break;
    if (chars + candidate.text.length > budget.maxChars) continue;
    picked.push({
      key: candidate.key,
      heading: candidate.heading,
      text: candidate.text,
      score: candidate.score,
    });
    chars += candidate.text.length;
  }
  return picked;
}
