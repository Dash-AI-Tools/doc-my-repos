import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUDGET,
  MAX_EXCERPT_CHARS,
  MAX_SECTIONS_PER_DOC,
  MAX_SECTIONS_TOTAL,
  MAX_SECTION_CHARS,
  queryTerms,
  scoreSection,
  searchWords,
  selectSections,
  splitSections,
  type SectionHeading,
  type SectionSource,
} from "./sections";

const h = (depth: number, text: string): SectionHeading => ({
  depth,
  text,
  slug: text.toLowerCase().replace(/\W+/g, "-"),
});

describe("splitSections", () => {
  it("splits at the stored headings, with an intro before the first", () => {
    const body = "Intro text.\n\n# Setup\n\nInstall it.\n\n## Keys\n\nRotate keys here.\n";
    const sections = splitSections(body, [h(1, "Setup"), h(2, "Keys")]);
    expect(sections.map((s) => [s.heading?.text ?? null, s.text])).toEqual([
      [null, "Intro text."],
      ["Setup", "Install it."],
      ["Keys", "Rotate keys here."],
    ]);
  });

  it("returns one intro section for a document without headings", () => {
    const sections = splitSections("Just some text.\n\nAnd more.", []);
    expect(sections).toEqual([{ heading: null, text: "Just some text.\n\nAnd more." }]);
  });

  it("drops empty sections, including an empty intro", () => {
    const sections = splitSections("# A\n\n# B\n\ntext", [h(1, "A"), h(1, "B")]);
    expect(sections).toEqual([{ heading: h(1, "B"), text: "text" }]);
  });

  it("returns nothing for an empty body", () => {
    expect(splitSections("", [])).toEqual([]);
    expect(splitSections("  \n\n ", [h(1, "A")])).toEqual([]);
  });

  it("matches Markdown-decorated headings and setext headings", () => {
    const body = "# The `config` file\n\nabout config\n\nOther\n-----\n\nabout other\n";
    const sections = splitSections(body, [h(1, "The config file"), h(2, "Other")]);
    expect(sections.map((s) => s.heading?.text)).toEqual(["The config file", "Other"]);
    expect(sections[1]?.text).toBe("about other");
  });

  it("ignores headings inside code fences", () => {
    const body = "# Real\n\n```sh\n# not a heading\necho hi\n```\n\nafter";
    const sections = splitSections(body, [h(1, "Real"), h(1, "not a heading")]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain("echo hi");
    expect(sections[0]?.text).toContain("# not a heading");
  });

  it("keeps a stored heading that is not in the body with the section before it", () => {
    const sections = splitSections("# A\n\ntext a\n\nhtml heading text", [
      h(1, "A"),
      h(2, "From HTML"),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toContain("html heading text");
  });

  it("handles repeated heading text by order", () => {
    const body = "# A\n\nfirst\n\n# A\n\nsecond";
    const sections = splitSections(body, [h(1, "A"), h(1, "A")]);
    expect(sections.map((s) => s.text)).toEqual(["first", "second"]);
  });

  it("caps a huge section at paragraph breaks, keeping the heading on each piece", () => {
    const paragraph = "word ".repeat(100).trim(); // ~500 chars
    const body = `# Big\n\n${Array.from({ length: 20 }, () => paragraph).join("\n\n")}`;
    const sections = splitSections(body, [h(1, "Big")]);
    expect(sections.length).toBeGreaterThan(3);
    for (const s of sections) {
      expect(s.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
      expect(s.heading?.text).toBe("Big");
      expect(s.text.startsWith("word")).toBe(true);
    }
  });

  it("cuts a single enormous paragraph, with and without spaces, and never loses text", () => {
    for (const unit of ["a ", "x"]) {
      const text = unit.repeat(10_000);
      const sections = splitSections(text, []);
      for (const s of sections) expect(s.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
      expect(
        sections
          .map((s) => s.text)
          .join("")
          .replace(/\s/g, ""),
      ).toBe(text.replace(/\s/g, ""));
    }
  });

  it("copes with CRLF line ends", () => {
    const sections = splitSections("# A\r\n\r\ntext\r\n", [h(1, "A")]);
    expect(sections).toEqual([{ heading: h(1, "A"), text: "text" }]);
  });
});

describe("queryTerms", () => {
  it("drops stop-words, short words and repeats, lower-cases, and stems plurals", () => {
    expect(queryTerms("How do I rotate the signing keys? Keys!")).toEqual([
      "rotate",
      "signing",
      "key",
    ]);
  });

  it("keeps non-Latin words and numbers", () => {
    expect(queryTerms("puerto 5432 配置")).toEqual(["puerto", "5432", "配置"]);
  });

  it("is empty for a question of only stop-words", () => {
    expect(queryTerms("what is the")).toEqual([]);
  });
});

describe("scoreSection", () => {
  const section = (text: string, heading?: string) => ({
    heading: heading ? h(2, heading) : null,
    text,
  });

  it("is zero without overlap and for no terms", () => {
    expect(scoreSection(["rotate"], section("nothing here"), "Other")).toBe(0);
    expect(scoreSection([], section("rotate keys"), "Rotate")).toBe(0);
  });

  it("scores more occurrences higher, with diminishing returns", () => {
    const one = scoreSection(["key"], section("key"), "T");
    const three = scoreSection(["key"], section("key key key"), "T");
    const thirty = scoreSection(["key"], section("key ".repeat(30)), "T");
    expect(three).toBeGreaterThan(one);
    expect(thirty - three).toBeLessThan(three);
  });

  it("weights a heading match above a body match, and adds a bonus for a title match", () => {
    const body = scoreSection(["rotate"], section("we rotate things"), "T");
    const heading = scoreSection(["rotate"], section("unrelated", "Rotate keys"), "T");
    const withTitle = scoreSection(["rotate"], section("we rotate things"), "Rotate");
    expect(heading).toBeGreaterThan(body);
    expect(withTitle).toBeGreaterThan(body);
  });

  it("never scores from the document title alone", () => {
    expect(scoreSection(["rotate"], section("unrelated"), "Rotate")).toBe(0);
  });

  it("prefers a short focused section over a long diluted one", () => {
    const short = scoreSection(["rotate"], section("rotate the key"), "T");
    const long = scoreSection(["rotate"], section(`rotate the key ${"filler ".repeat(300)}`), "T");
    expect(short).toBeGreaterThan(long);
  });
});

function doc(
  key: string,
  title: string,
  body: string,
  headings: SectionHeading[] = [],
): SectionSource {
  return { key, title, body, headings };
}

describe("selectSections", () => {
  const keys = doc(
    "keys",
    "Key management",
    "Overview of keys.\n\n# Rotate the signing key\n\nRun the rotate command to rotate the signing key.\n\n# Backups\n\nBack up the vault nightly.",
    [h(1, "Rotate the signing key"), h(1, "Backups")],
  );

  it("picks the best-matching section of a document, by score", () => {
    const picked = selectSections([keys], "how do I rotate the signing key?");
    expect(picked[0]?.heading?.text).toBe("Rotate the signing key");
    expect(picked.every((s) => s.key === "keys")).toBe(true);
    expect(picked.map((s) => s.heading?.text)).not.toContain("Backups");
  });

  it("orders sections by score across documents and returns the document key", () => {
    const weak = doc(
      "weak",
      "Misc",
      "mentions rotate once in passing among much other text".repeat(5),
    );
    const picked = selectSections([weak, keys], "rotate signing key");
    expect(picked[0]?.key).toBe("keys");
    expect(picked.map((s) => s.key)).toContain("weak");
  });

  it("takes at most two sections from one document", () => {
    const body = [
      "# A\n\nrotate one",
      "# B\n\nrotate two",
      "# C\n\nrotate three",
      "# D\n\nrotate four",
    ].join("\n\n");
    const d = doc("d", "T", body, [h(1, "A"), h(1, "B"), h(1, "C"), h(1, "D")]);
    expect(selectSections([d], "rotate")).toHaveLength(MAX_SECTIONS_PER_DOC);
  });

  it("breaks ties by document order, then section order", () => {
    const body = "# A\n\nrotate\n\n# B\n\nrotate";
    const one = doc("one", "T", body, [h(1, "A"), h(1, "B")]);
    const two = doc("two", "T", body, [h(1, "A"), h(1, "B")]);
    const picked = selectSections([one, two], "rotate");
    expect(picked.map((s) => `${s.key}:${s.heading?.text}`)).toEqual([
      "one:A",
      "one:B",
      "two:A",
      "two:B",
    ]);
    expect(selectSections([two, one], "rotate")[0]?.key).toBe("two");
  });

  it("falls back to the intro for a document whose sections score zero", () => {
    const d = doc("d", "Unrelated title", "Intro about nothing.\n\n# Part\n\nmore nothing", [
      h(1, "Part"),
    ]);
    const picked = selectSections([d], "kubernetes");
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({
      key: "d",
      heading: null,
      text: "Intro about nothing.",
      score: 0,
    });
  });

  it("falls back to the first section when there is no intro", () => {
    const d = doc("d", "T", "# Part\n\nbody text", [h(1, "Part")]);
    expect(selectSections([d], "kubernetes")[0]?.heading?.text).toBe("Part");
  });

  it("returns nothing for documents without text and for no documents", () => {
    expect(selectSections([], "x")).toEqual([]);
    expect(selectSections([doc("e", "T", "  ")], "x")).toEqual([]);
  });

  it("never exceeds the section and character budgets", () => {
    const docs = Array.from({ length: 12 }, (_, i) =>
      doc(`d${i}`, "T", `# H\n\n${"rotate key ".repeat(200)}`, [h(1, "H")]),
    );
    const picked = selectSections(docs, "rotate key");
    expect(picked.length).toBeLessThanOrEqual(MAX_SECTIONS_TOTAL);
    expect(picked.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(DEFAULT_BUDGET).toEqual({
      maxSectionsPerDoc: 2,
      maxSections: 8,
      maxChars: 12_000,
    });
  });

  it("skips a section that does not fit the character budget but keeps smaller ones", () => {
    const big = doc("big", "T", "rotate ".repeat(300));
    const small = doc("small", "T", "rotate");
    const picked = selectSections([big, small], "rotate", {
      maxSectionsPerDoc: 2,
      maxSections: 8,
      maxChars: 100,
    });
    expect(picked.map((s) => s.key)).toEqual(["small"]);
  });

  it("is deterministic", () => {
    const a = selectSections([keys], "rotate signing key");
    const b = selectSections([keys], "rotate signing key");
    expect(a).toEqual(b);
  });
});

describe("searchWords", () => {
  it("keeps keywords in order, unstemmed, without stop-words, repeats or operators", () => {
    expect(searchWords("How do I rotate the signing keys? Keys!")).toEqual([
      "rotate",
      "signing",
      "keys",
    ]);
    expect(searchWords('deploy -draft "exact phrase" OR docker')).toEqual([
      "deploy",
      "draft",
      "exact",
      "phrase",
      "docker",
    ]);
  });

  it("is capped and empty for a question of only stop-words", () => {
    expect(
      searchWords("alpha bravo charlie delta echo foxtrot golf hotel india juliet"),
    ).toHaveLength(8);
    expect(searchWords("what is it?")).toEqual([]);
  });
});
