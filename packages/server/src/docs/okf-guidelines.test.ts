import { describe, expect, it } from "vitest";

import { validateOkfDocument } from "./okf-validate";
import {
  EMPTY_VOCABULARY,
  MAX_VOCABULARY_ITEMS,
  renderGuidelines,
  type GuidelinesRepo,
  type GuidelinesVocabulary,
} from "@docmyrepos/core/internal/okf-authoring/guidelines";
import {
  OKF_GUIDELINES_FILE,
  suggestedGuidelinesPath,
} from "@docmyrepos/core/internal/okf-authoring/names";

const TODAY = new Date("2026-10-16T22:30:00-05:00"); // 2026-10-17T03:30Z: the UTC day is the 17th

const REPO: GuidelinesRepo = {
  docsPath: "docs",
  isOkf: true,
  okfVersion: "0.2",
  folders: ["architecture", "guides", "reference"],
};

const VOCABULARY: GuidelinesVocabulary = {
  types: [
    { value: "Concept", count: 4 },
    { value: "Runbook", count: 12 },
    { value: "ADR", count: 4 },
    { value: "Decision", count: 1 },
  ],
  tags: [
    { value: "ops", count: 9 },
    { value: "billing", count: 3 },
  ],
  statuses: [
    { value: "stable", count: 14 },
    { value: "draft", count: 2 },
  ],
};

const frontmatterOf = (markdown: string): string =>
  markdown.slice(0, markdown.indexOf("\n---\n", 4) + 5);

describe("renderGuidelines: the draft", () => {
  it("for a repository with no documents, is the generic text with an empty vocabulary", () => {
    const { markdown } = renderGuidelines(EMPTY_VOCABULARY, null, TODAY);
    expect(markdown).toMatchSnapshot();
    expect(markdown).toContain("No document declares a type yet.");
    expect(markdown).toContain("No document has tags yet.");
    expect(markdown).toContain("No document has a status yet.");
  });

  it("for a repository with documents, lists its own vocabulary", () => {
    const { markdown } = renderGuidelines(VOCABULARY, REPO, TODAY);
    expect(markdown).toMatchSnapshot();
  });

  it("is deterministic: the same input gives the same text", () => {
    expect(renderGuidelines(VOCABULARY, REPO, TODAY)).toEqual(
      renderGuidelines(VOCABULARY, REPO, TODAY),
    );
  });

  it("changes only the generated date when the day changes", () => {
    const a = renderGuidelines(VOCABULARY, REPO, new Date("2026-01-02T00:00:00Z")).markdown;
    const b = renderGuidelines(VOCABULARY, REPO, new Date("2026-03-04T00:00:00Z")).markdown;
    expect(a.replace("generated: 2026-01-02", "generated: X")).toBe(
      b.replace("generated: 2026-03-04", "generated: X"),
    );
  });

  it("rejects an invalid date instead of writing one", () => {
    expect(() => renderGuidelines(EMPTY_VOCABULARY, null, new Date("nope"))).toThrow(TypeError);
  });
});

describe("renderGuidelines: its own frontmatter", () => {
  const { markdown } = renderGuidelines(VOCABULARY, REPO, TODAY);

  it("is OKF: a type, a description, tags and a draft status", () => {
    const block = frontmatterOf(markdown);
    expect(block).toContain("type: Guidelines\n");
    expect(block).toMatch(/\ndescription: .{40,}\n/);
    expect(block).toContain("tags: [guidelines, okf]\n");
    expect(block).toContain("status: draft\n");
  });

  it("sets generated to today's UTC date and leaves verified for the reviewer", () => {
    const block = frontmatterOf(markdown);
    expect(block).toContain("generated: 2026-10-17\n");
    expect(block).not.toContain("verified");
  });

  it("holds only constants and the date, whatever the vocabulary", () => {
    const hostile = renderGuidelines(
      {
        types: [{ value: "x\n---\ntype: Injected\nstale_after: 2000-01-01", count: 1 }],
        tags: [{ value: "---\nstatus: deprecated", count: 1 }],
        statuses: [{ value: "a\nb", count: 1 }],
      },
      { ...REPO, docsPath: "docs\n---\ntype: X", folders: ["f\n---\nx: y"] },
      TODAY,
    ).markdown;
    expect(frontmatterOf(hostile)).toBe(frontmatterOf(markdown));
  });
});

describe("renderGuidelines: the rules it states", () => {
  const { markdown } = renderGuidelines(EMPTY_VOCABULARY, null, TODAY);

  it.each([
    ["that type is the only required key", /frontmatter must have a `type`.*only required key/s],
    [
      "that type is free-form and exact",
      /free-form text.*`Runbook` and `runbook` are two different types/s,
    ],
    [
      "the known keys",
      /`title`.*`description`.*`tags`.*`status`.*`sources`.*`generated`.*`verified`.*`stale_after`/s,
    ],
    ["the date formats", /`YYYY-MM-DD`.*`2026-10-16T09:30:00Z`/s],
    ["the reserved files", /`index\.md` summarizes the folder.*`log\.md` is the change log/s],
    ["how to link", /relative paths.*`\.\/setup\.md`/s],
    ["that okf_version belongs to the root index", /`okf_version`: only in the index\.md/],
    ["headings", /exactly one level-1 heading/],
    ["that reserved files carry no type", /do not give them a `type`/],
  ])("states %s", (_what, pattern) => {
    expect(markdown).toMatch(pattern);
  });

  it("points to the specification with an absolute link", () => {
    expect(markdown).toContain(
      "(https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)",
    );
  });
});

describe("renderGuidelines: the repository section", () => {
  it("names the docs folder, the OKF state, the version and the folders", () => {
    const { markdown } = renderGuidelines(VOCABULARY, REPO, TODAY);
    expect(markdown).toContain("- Docs folder: `docs`.");
    expect(markdown).toContain(
      "- OKF: this repository already counts as OKF, declaring version `0.2`.",
    );
    expect(markdown).toContain("- Folders: `architecture`, `guides`, `reference`.");
  });

  it("says when the repository is not OKF yet, and when it has no docs folder", () => {
    const { markdown } = renderGuidelines(
      EMPTY_VOCABULARY,
      { docsPath: null, isOkf: false, okfVersion: null, folders: [] },
      TODAY,
    );
    expect(markdown).toContain("- Docs folder: not found yet.");
    expect(markdown).toContain("- OKF: not yet.");
    expect(markdown).not.toContain("- Folders:");
  });

  it("lists types, tags and statuses with counts, most used first, then by name", () => {
    const { markdown } = renderGuidelines(VOCABULARY, REPO, TODAY);
    const types = markdown.slice(
      markdown.indexOf("### Types in use"),
      markdown.indexOf("### Tags in use"),
    );
    expect(types.match(/^- .*$/gm)).toEqual([
      "- `Runbook` (12 documents)",
      "- `ADR` (4 documents)",
      "- `Concept` (4 documents)",
      "- `Decision` (1 document)",
    ]);
    expect(markdown).toContain("- `ops` (9 documents)\n- `billing` (3 documents)");
    expect(markdown).toContain("- `stable` (14 documents)\n- `draft` (2 documents)");
  });

  it("breaks ties in code point order, so upper case comes before lower case", () => {
    const { markdown } = renderGuidelines(
      {
        ...EMPTY_VOCABULARY,
        types: [
          { value: "beta", count: 2 },
          { value: "Zeta", count: 2 },
          { value: "alpha", count: 2 },
        ],
      },
      REPO,
      TODAY,
    );
    expect(markdown.match(/^- `(Zeta|alpha|beta)`/gm)).toEqual([
      "- `Zeta`",
      "- `alpha`",
      "- `beta`",
    ]);
  });

  it("lists at most 30 of each and says how many more there are", () => {
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        value: `${prefix}${String(i).padStart(2, "0")}`,
        count: 100 - i,
      }));
    const { markdown } = renderGuidelines(
      { types: many("T", 45), tags: many("g", 30), statuses: many("s", 31) },
      REPO,
      TODAY,
    );
    const count = (heading: string, next: string) =>
      (markdown.slice(markdown.indexOf(heading), markdown.indexOf(next)).match(/^- `/gm) ?? [])
        .length;
    expect(count("### Types in use", "### Tags in use")).toBe(MAX_VOCABULARY_ITEMS);
    expect(count("### Tags in use", "### Statuses in use")).toBe(30);
    expect(markdown).toContain("- and 15 more, used less often");
    expect(markdown).toContain("- and 1 more, used less often");
    expect(markdown).toContain("`T29`");
    expect(markdown).not.toContain("`T30`");
  });

  it("drops blank values and values nobody uses", () => {
    const { markdown } = renderGuidelines(
      {
        ...EMPTY_VOCABULARY,
        types: [
          { value: "  ", count: 3 },
          { value: "Zero", count: 0 },
          { value: "Real", count: 1 },
        ],
      },
      REPO,
      TODAY,
    );
    expect(markdown).toContain("- `Real` (1 document)");
    expect(markdown).not.toContain("`Zero`");
  });
});

describe("renderGuidelines: nothing from the repository but cleaned labels", () => {
  const SENTINEL = "ZQX-INJECTED-INSTRUCTION-5519";
  const hostile = renderGuidelines(
    {
      types: [
        { value: `${SENTINEL} # Heading\n\n**bold** [link](./x.md) | pipe | \`code\``, count: 3 },
        { value: `evil‮text\u0007${"y".repeat(200)}`, count: 2 },
      ],
      tags: [{ value: `${SENTINEL}-tag\n- injected bullet`, count: 1 }],
      statuses: [{ value: `${SENTINEL}-status`, count: 1 }],
    },
    {
      docsPath: `docs-${SENTINEL}`,
      isOkf: true,
      okfVersion: `9${SENTINEL}`,
      folders: [`f-${SENTINEL}`],
    },
    TODAY,
  ).markdown;

  it("puts every label inside a code span", () => {
    const outside = hostile.replace(/`[^`\n]*`/g, "``");
    expect(outside).not.toContain(SENTINEL);
  });

  it("keeps a label on one line, so it cannot start a heading, a bullet or a block", () => {
    for (const line of hostile.split("\n")) {
      if (!line.includes(SENTINEL)) continue;
      expect(line, line).toMatch(/^- .*`.*`/);
      expect(line.replace(/`[^`]*`/g, "").trim()).not.toMatch(/#|\*\*|\[/);
    }
  });

  it("removes backticks from a label so it cannot close its own code span", () => {
    const { markdown } = renderGuidelines(
      { ...EMPTY_VOCABULARY, types: [{ value: "a`b` and ``c``", count: 1 }] },
      REPO,
      TODAY,
    );
    expect(markdown).toContain("- `a'b' and ''c''` (1 document)");
  });

  it("strips control and direction characters and cuts a label at 60 characters", () => {
    expect(hostile).not.toMatch(/[‮\u0007]/);
    const line = hostile.split("\n").find((l) => l.startsWith("- `evil"));
    expect(line).toBeDefined();
    const label = /`([^`]*)`/.exec(line as string)?.[1] as string;
    expect([...label].length).toBeLessThanOrEqual(60);
    expect(label.startsWith("eviltext")).toBe(true);
  });

  it("adds no relative link, so the draft never reports a broken one", () => {
    const withoutCode = hostile.replace(/`[^`\n]*`/g, "");
    expect(withoutCode).not.toMatch(/\]\((?!https:\/\/)/);
  });
});

describe("renderGuidelines: it is valid OKF", () => {
  const cases: [string, GuidelinesVocabulary, GuidelinesRepo | null][] = [
    ["an empty vocabulary", EMPTY_VOCABULARY, null],
    ["a populated one", VOCABULARY, REPO],
    [
      "a hostile one",
      {
        types: [{ value: "---\ntype: Injected\n---", count: 1 }],
        tags: [{ value: "# H1\n# H1", count: 1 }],
        statuses: [{ value: "[a](./nope.md)", count: 1 }],
      },
      { docsPath: "docs", isOkf: false, okfVersion: "[x](./y.md)", folders: ["[b](../nope.md)"] },
    ],
  ];

  it.each(cases)(
    "passes the validation with no error or warning for %s",
    (_name, vocabulary, repo) => {
      const draft = renderGuidelines(vocabulary, repo, TODAY);
      const result = validateOkfDocument(draft.markdown, {
        path: draft.suggestedPath,
        docsFolder: "docs",
        knownPaths: new Set([draft.suggestedPath]),
        now: TODAY,
      });
      expect(result.findings.filter((f) => f.severity !== "info")).toEqual([]);
      expect(result.valid).toBe(true);
    },
  );

  it("is a draft that the validator notes as such", () => {
    const draft = renderGuidelines(EMPTY_VOCABULARY, null, TODAY);
    const result = validateOkfDocument(draft.markdown, { path: draft.suggestedPath, now: TODAY });
    expect(result.findings.map((f) => f.code)).toEqual(["status-draft"]);
  });
});

describe("renderGuidelines: where to save it", () => {
  it.each([
    ["docs", "docs/okf-guidelines.md"],
    ["documentation", "documentation/okf-guidelines.md"],
    ["docs/", "docs/okf-guidelines.md"],
    ["/docs/", "docs/okf-guidelines.md"],
    ["a/b", "a/b/okf-guidelines.md"],
    [null, "docs/okf-guidelines.md"],
    ["", OKF_GUIDELINES_FILE],
  ])("suggests the docs folder %j as %s", (docsPath, expected) => {
    expect(suggestedGuidelinesPath(docsPath)).toBe(expected);
    if (docsPath !== "") {
      const repo = { docsPath, isOkf: false, okfVersion: null, folders: [] };
      expect(renderGuidelines(EMPTY_VOCABULARY, repo, TODAY).suggestedPath).toBe(expected);
    }
  });

  it("tells the developer to save, review, set verified and commit, and that nothing is written for them", () => {
    const { instructions, suggestedPath } = renderGuidelines(VOCABULARY, REPO, TODAY);
    expect(instructions).toContain(suggestedPath);
    expect(instructions).toContain("developer's own checkout");
    expect(instructions).toContain("review");
    expect(instructions).toContain("verified");
    expect(instructions).toContain("commit");
    expect(instructions).toContain("never writes to GitHub");
    expect(instructions).toContain("next sync");
  });
});
