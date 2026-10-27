// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { buildOkfMeta, MAX_ITEMS, type OkfColumns } from "@docmyrepos/core/internal/okf-meta";
import { parseTocFilters } from "@docmyrepos/core/internal/toc-filters";

import { OkfMetadataCard } from "./okf-metadata-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const NOW = new Date("2026-10-10T12:00:00Z");
const NONE: OkfColumns = { type: null, tags: [], status: null, description: null };

function card(frontmatter: unknown, columns: Partial<OkfColumns> = {}, now: Date = NOW) {
  const meta = buildOkfMeta(frontmatter, { ...NONE, ...columns });
  return render(<OkfMetadataCard meta={meta} now={now} repoPath="/acme/kb" />);
}

const rows = (): string[] =>
  [...document.querySelectorAll("[data-testid^='okf-row-']")].map((el) =>
    (el.getAttribute("data-testid") ?? "").replace("okf-row-", ""),
  );

describe("OkfMetadataCard, full metadata", () => {
  const FULL = {
    type: "Runbook",
    tags: ["database", "oncall"],
    status: "active",
    description: "Switch to the replica.",
    resource: "https://example.com/runbooks/failover",
    sources: ["https://example.com/a", { title: "Postmortem", url: "https://example.com/pm" }],
    generated: "2026-01-02",
    verified: "2026-02-03T04:05:00Z",
    stale_after: "2027-01-01",
    owner_team: "platform",
  };

  it("shows every field in a labelled section", () => {
    card(FULL, {
      type: "Runbook",
      tags: ["database", "oncall"],
      status: "active",
      description: "Switch to the replica.",
    });
    const section = screen.getByRole("region", { name: "Document metadata" });
    expect(section).toBeTruthy();
    expect(rows()).toEqual([
      "type",
      "status",
      "tags",
      "description",
      "resource",
      "sources",
      "generated",
      "verified",
      "stale-after",
    ]);
    expect(screen.getByTestId("okf-type").textContent).toBe("Runbook");
    expect(screen.getByTestId("okf-status").textContent).toBe("active");
    expect(screen.getAllByTestId("okf-tag").map((t) => t.textContent)).toEqual([
      "database",
      "oncall",
    ]);
    expect(screen.getByTestId("okf-description").textContent).toBe("Switch to the replica.");
    expect(within(screen.getByTestId("okf-row-generated")).getByText("2 Jan 2026")).toBeTruthy();
    expect(
      within(screen.getByTestId("okf-row-verified")).getByText("3 Feb 2026, 04:05 UTC"),
    ).toBeTruthy();
    const staleRow = screen.getByTestId("okf-row-stale-after");
    expect(within(staleRow).getByText("1 Jan 2027")).toBeTruthy();
    expect(staleRow.textContent).toContain("(in 83 days)");
    expect(staleRow.querySelector("time")?.getAttribute("datetime")).toBe("2027-01-01");
  });

  it("links type, status and tags to the repository filters", () => {
    card(FULL, { type: "Runbook", tags: ["database"], status: "active" });
    expect(screen.getByTestId("okf-type").getAttribute("href")).toBe("/acme/kb?type=Runbook");
    expect(screen.getByTestId("okf-status").getAttribute("href")).toBe("/acme/kb?status=active");
    expect(screen.getByTestId("okf-tag").getAttribute("href")).toBe("/acme/kb?tag=database");
  });

  it("encodes a type with special characters in the link", () => {
    card({ type: "A&B #1" }, { type: "A&B #1" });
    const href = screen.getByTestId("okf-type").getAttribute("href") ?? "";
    expect(href.startsWith("/acme/kb?type=")).toBe(true);
    expect(href).not.toContain("&B");
    expect(href).not.toContain("#");
    expect(screen.getByTestId("okf-type").textContent).toBe("A&B #1");
  });

  it("links resource and sources to external pages, with rel", () => {
    card(FULL, { type: "Runbook" });
    const links = screen.getAllByTestId("okf-ref-link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://example.com/runbooks/failover",
      "https://example.com/a",
      "https://example.com/pm",
    ]);
    for (const a of links) {
      expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    }
    expect(links[2]?.textContent).toBe("Postmortem");
  });

  it("lists the unknown key under Other fields", () => {
    card(FULL, { type: "Runbook" });
    const other = screen.getByTestId("okf-other-fields");
    expect(within(other).getByRole("heading", { name: "Other fields" })).toBeTruthy();
    expect(within(other).getByText("owner_team")).toBeTruthy();
    expect(within(other).getByText("platform")).toBeTruthy();
  });
});

describe("OkfMetadataCard, type only", () => {
  it("shows just the type: no other rows, no placeholders, no undefined", () => {
    const { container } = card({ type: "Note" }, { type: "Note" });
    expect(rows()).toEqual(["type"]);
    expect(screen.getByTestId("okf-type").textContent).toBe("Note");
    expect(screen.queryByTestId("okf-other-fields")).toBeNull();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/undefined|null|N\/A|none|unknown|—|-$/i);
    expect(container.querySelectorAll("dt")).toHaveLength(1);
  });

  it("keeps the type's case and spacing as authored", () => {
    card({ type: "metric" }, { type: "metric" });
    expect(screen.getByTestId("okf-type").textContent).toBe("metric");
    cleanup();
    card({ type: "MeTrIc" }, { type: "MeTrIc" });
    expect(screen.getByTestId("okf-type").textContent).toBe("MeTrIc");
  });

  it("renders nothing when there is nothing to show", () => {
    const { container } = card({});
    expect(container.innerHTML).toBe("");
    cleanup();
    const again = card(null);
    expect(again.container.innerHTML).toBe("");
  });

  it("renders no empty rows for empty values", () => {
    card(
      { type: "Note", tags: [], resource: [], sources: "", description: "  ", generated: "" },
      { type: "Note" },
    );
    expect(rows()).toEqual(["type"]);
  });
});

describe("OkfMetadataCard, unknown keys", () => {
  const ODD = {
    type: "Note",
    nested: { level1: { level2: "deep" }, flag: true },
    list: ["a", 2, false, null],
    count: 42,
    enabled: false,
    nothing: null,
    markup: '<img src=x onerror="alert(1)"> <script>alert(2)</script> **bold**',
    long: "word ".repeat(400),
    empty_text: "",
    empty_list: [],
    empty_map: {},
  };

  it("shows every shape as text", () => {
    const { container } = card(ODD, { type: "Note" });
    const other = screen.getByTestId("okf-other-fields");
    const fields = within(other).getAllByTestId("okf-other-field");
    expect(fields.map((f) => f.querySelector("dt")?.textContent)).toEqual([
      "nested",
      "list",
      "count",
      "enabled",
      "nothing",
      "markup",
      "long",
      "empty_text",
      "empty_list",
      "empty_map",
    ]);
    const text = other.textContent ?? "";
    expect(text).toContain("level1");
    expect(text).toContain("deep");
    expect(text).toContain("42");
    expect(text).toContain("false");
    expect(text).toContain("null");
    expect(text).toContain("(empty)");
    expect(text).toContain("(empty list)");
    // markup is text, never elements
    expect(text).toContain("<img src=x");
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
  });

  it("collapses six or more fields behind a native details element", () => {
    card(ODD, { type: "Note" });
    const other = screen.getByTestId("okf-other-fields");
    expect(other.tagName).toBe("DETAILS");
    expect(other.hasAttribute("open")).toBe(false);
    expect(within(other).getByText(/Other fields \(10\)/)).toBeTruthy();
  });

  it("shows a few fields openly under a heading", () => {
    card({ type: "Note", a: 1, b: 2 }, { type: "Note" });
    const other = screen.getByTestId("okf-other-fields");
    expect(other.tagName).toBe("DIV");
  });

  it("shortens a long string and says so", () => {
    card({ type: "Note", long: "x".repeat(5000) }, { type: "Note" });
    const value = screen.getByTestId("okf-other-field").textContent ?? "";
    expect(value.length).toBeLessThan(700);
    expect(value).toContain("…");
  });

  it("puts a long list behind Show more", () => {
    card({ type: "Note", items: Array.from({ length: 15 }, (_, i) => `item-${i}`) });
    const field = screen.getByTestId("okf-other-field");
    expect(field.querySelectorAll(":scope > dd > div > ul > li")).toHaveLength(8);
    const more = within(field).getByTestId("okf-show-more");
    expect(more.tagName).toBe("DETAILS");
    expect(within(more).getByText("Show 7 more")).toBeTruthy();
  });

  it("says how many entries past the cap were left out", () => {
    card({ type: "Note", items: Array.from({ length: 100 }, (_, i) => i) });
    expect(screen.getByTestId("okf-other-field").textContent).toContain(
      `and ${100 - MAX_ITEMS} more`,
    );
  });

  it("summarizes a mapping nested beyond the depth cap", () => {
    let nested: unknown = { a: 1, b: 2 };
    for (let i = 0; i < 10; i += 1) nested = { next: nested };
    card({ type: "Note", deep: nested }, { type: "Note" });
    expect(screen.getByTestId("okf-other-field").textContent).toContain("1 field");
  });

  it("lists a known key with an unusable shape instead of hiding it", () => {
    card({ type: "Note", status: ["a", "b"] }, { type: "Note" });
    expect(screen.queryByTestId("okf-row-status")).toBeNull();
    expect(screen.getByTestId("okf-other-field").textContent).toContain("status");
  });

  it("does not throw on hostile keys", () => {
    const hostile = JSON.parse('{"__proto__": {"x": 1}, "type": "Note", "constructor": [1]}');
    card(hostile, { type: "Note" });
    expect(screen.getByTestId("okf-other-fields").textContent).toContain("__proto__");
  });
});

describe("OkfMetadataCard, hostile links", () => {
  it("shows javascript:, data: and relative values as text, not links", () => {
    card(
      {
        type: "Note",
        resource: "javascript:alert(1)",
        sources: [
          "data:text/html,<script>alert(1)</script>",
          "vbscript:x",
          "../secrets.md",
          "https://user:pw@example.com/",
          { title: "Click me", url: "javascript:alert(2)" },
          "https://ok.example/x",
        ],
      },
      { type: "Note" },
    );
    const links = screen.getAllByTestId("okf-ref-link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://ok.example/x");
    const texts = screen.getAllByTestId("okf-ref-text").map((t) => t.textContent);
    expect(texts).toContain("javascript:alert(1)");
    expect(texts).toContain("Click me");
    expect(texts).toContain("../secrets.md");
    expect(
      document.querySelector("a[href^='javascript'], a[href^='data'], a[href^='vbscript']"),
    ).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  it("caps a huge sources list", () => {
    card(
      { type: "Note", sources: Array.from({ length: 500 }, (_, i) => `https://e.example/${i}`) },
      { type: "Note" },
    );
    const sources = screen.getByTestId("okf-row-sources");
    expect(sources.querySelectorAll("a")).toHaveLength(MAX_ITEMS);
    expect(sources.textContent).toContain(`and ${500 - MAX_ITEMS} more`);
    expect(within(sources).getByText(`Show ${MAX_ITEMS - 8} more`)).toBeTruthy();
  });

  it("truncates a huge label", () => {
    card({ type: "Note", resource: `https://e.example/${"a".repeat(100_000)}` }, { type: "Note" });
    expect(screen.getByTestId("okf-ref-text").textContent?.length).toBeLessThan(400);
  });
});

describe("OkfMetadataCard, dates", () => {
  it("shows an invalid date as written, with a hint", () => {
    card(
      { type: "Note", generated: "last tuesday", stale_after: "2026-02-30", verified: 2026 },
      { type: "Note" },
    );
    for (const row of ["generated", "stale-after", "verified"]) {
      const el = screen.getByTestId(`okf-row-${row}`);
      expect(el.textContent).toContain("(not a valid date)");
      expect(el.querySelector("time")).toBeNull();
    }
    expect(screen.getByTestId("okf-row-generated").textContent).toContain("last tuesday");
    expect(screen.getByTestId("okf-row-stale-after").textContent).toContain("2026-02-30");
    expect(screen.getByTestId("okf-row-verified").textContent).toContain("2026");
  });

  it("words stale_after relative to now: past, today, future", () => {
    card({ type: "Note", stale_after: "2026-10-01" }, { type: "Note" });
    expect(screen.getByTestId("okf-row-stale-after").textContent).toContain("(9 days ago)");
    cleanup();
    card({ type: "Note", stale_after: "2026-10-10" }, { type: "Note" });
    expect(screen.getByTestId("okf-row-stale-after").textContent).toContain("(today)");
    cleanup();
    card({ type: "Note", stale_after: "2026-10-11" }, { type: "Note" });
    expect(screen.getByTestId("okf-row-stale-after").textContent).toContain("(in 1 day)");
  });

  it("is deterministic across time zones: dates are UTC", () => {
    card({ type: "Note", generated: "2026-03-01T23:30:00-05:00" }, { type: "Note" });
    expect(screen.getByTestId("okf-row-generated").textContent).toContain("2 Mar 2026, 04:30 UTC");
  });
});

describe("OkfMetadataCard, status chips", () => {
  it.each(["deprecated", "Deprecated", "draft", "DRAFT", "active", "Some Custom Status"])(
    "shows the status %j exactly as written",
    (status) => {
      card({ type: "Note", status }, { type: "Note", status });
      expect(screen.getByTestId("okf-status").textContent).toBe(status);
    },
  );

  it("caps and cleans tags", () => {
    const tags = Array.from({ length: 100 }, (_, i) => `tag${i}`);
    card({ type: "Note", tags }, { type: "Note", tags });
    const row = screen.getByTestId("okf-row-tags");
    expect(row.querySelectorAll("a")).toHaveLength(50);
    expect(within(row).getByText("Show 42 more")).toBeTruthy();
    expect(row.textContent).toContain("and 50 more");
  });
});

describe("OkfMetadataCard, filter links carry the stored values", () => {
  const ZWSP = String.fromCharCode(0x200b);
  const query = (testId: string, index = 0): URLSearchParams => {
    const href = screen.getAllByTestId(testId)[index]?.getAttribute("href") ?? "";
    expect(href.startsWith("/acme/kb?")).toBe(true);
    return new URLSearchParams(href.slice("/acme/kb?".length));
  };

  it("links a type with zero-width characters by its stored value, showing the cleaned text", () => {
    const type = `Run${ZWSP}book`;
    card({ type }, { type });
    expect(screen.getByTestId("okf-type").textContent).toBe("Runbook");
    expect(query("okf-type").get("type")).toBe(type);
    expect(screen.getByTestId("okf-type").getAttribute("href")).toContain("%E2%80%8B");
  });

  it("links a value with double spaces and edge whitespace as stored", () => {
    const type = "  Decision   record ";
    const status = "in  review";
    const tags = ["two  words", " padded "];
    card({ type, status, tags }, { type, status, tags });
    expect(screen.getByTestId("okf-type").textContent).toBe("Decision record");
    expect(query("okf-type").get("type")).toBe(type);
    expect(screen.getByTestId("okf-status").textContent).toBe("in review");
    expect(query("okf-status").get("status")).toBe(status);
    expect(screen.getAllByTestId("okf-tag").map((a) => a.textContent)).toEqual([
      "two words",
      "padded",
    ]);
    expect(query("okf-tag", 0).get("tag")).toBe("two  words");
    expect(query("okf-tag", 1).get("tag")).toBe(" padded ");
  });

  it("links a tag over 120 characters by the whole stored tag", () => {
    const tag = `${"long-tag-".repeat(20)}end`;
    expect(tag.length).toBeGreaterThan(120);
    card({ type: "Note", tags: [tag] }, { type: "Note", tags: [tag] });
    const shown = screen.getByTestId("okf-tag").textContent ?? "";
    expect(shown.endsWith("…")).toBe(true);
    expect(shown.length).toBeLessThan(tag.length);
    expect(query("okf-tag").get("tag")).toBe(tag);
  });

  it("round-trips through the table of contents parser to the same group", () => {
    const type = `Odd${ZWSP}  type`;
    const tag = `${ZWSP}t  ${"y".repeat(130)}`;
    card({ type, tags: [tag] }, { type, tags: [tag] });
    const typeHref = screen.getByTestId("okf-type").getAttribute("href") ?? "";
    const tagHref = screen.getByTestId("okf-tag").getAttribute("href") ?? "";
    expect(parseTocFilters(new URLSearchParams(typeHref.split("?")[1])).types).toEqual([type]);
    expect(parseTocFilters(new URLSearchParams(tagHref.split("?")[1])).tags).toEqual([tag]);
  });

  it("shows a stored value that cannot be a filter (over 256 characters) as plain text", () => {
    const type = "T".repeat(300);
    card({ type }, { type });
    const chip = screen.getByTestId("okf-type");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("href")).toBeNull();
    expect(chip.textContent).toBe(type);
  });

  it("takes the link value from the column, not from the frontmatter", () => {
    card({ type: "from-frontmatter" }, { type: "from-column" });
    expect(query("okf-type").get("type")).toBe("from-column");
  });
});

describe("OkfMetadataCard, read mode", () => {
  it("is marked for read mode to hide", () => {
    card({ type: "Runbook" });
    expect(
      document.querySelector("[data-testid='okf-metadata']")?.hasAttribute("data-read-hide"),
    ).toBe(true);
  });
});
