// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { buildOkfMeta } from "@/lib/okf-meta";

import { daysPhrase, OkfNotices } from "./okf-notices";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const NOW = new Date("2026-10-10T12:00:00Z");

function notices(frontmatter: Record<string, unknown>, now: Date = NOW) {
  const status = typeof frontmatter.status === "string" ? frontmatter.status : null;
  const meta = buildOkfMeta(frontmatter, { type: "Note", tags: [], status, description: null });
  return render(<OkfNotices meta={meta} now={now} />);
}

describe("daysPhrase", () => {
  it("words whole days", () => {
    expect(daysPhrase(0, "ago")).toBe("today");
    expect(daysPhrase(-3, "in")).toBe("today");
    expect(daysPhrase(1, "ago")).toBe("1 day ago");
    expect(daysPhrase(12, "ago")).toBe("12 days ago");
    expect(daysPhrase(1, "in")).toBe("in 1 day");
    expect(daysPhrase(40, "in")).toBe("in 40 days");
    expect(daysPhrase(364, "ago")).toBe("364 days ago");
    expect(daysPhrase(365, "ago")).toBe("1 year ago");
    expect(daysPhrase(2200, "ago")).toBe("6 years ago");
    expect(daysPhrase(355_099, "in")).toBe("in 972 years");
  });
});

describe("OkfNotices, status", () => {
  it("shows a deprecation notice for status deprecated, in any case", () => {
    for (const status of ["deprecated", "Deprecated", " DEPRECATED "]) {
      notices({ status });
      const note = screen.getByRole("note");
      expect(note.getAttribute("data-testid")).toBe("okf-notice-deprecated");
      expect(note.textContent).toContain("This document is deprecated.");
      cleanup();
    }
  });

  it("shows a draft notice for status draft", () => {
    notices({ status: "Draft" });
    const note = screen.getByRole("note");
    expect(note.getAttribute("data-testid")).toBe("okf-notice-draft");
    expect(note.textContent).toContain("This document is a draft.");
  });

  it.each(["active", "stable", "drafts", "deprecated-soon", ""])(
    "shows nothing for status %j",
    (status) => {
      const { container } = notices({ status });
      expect(container.innerHTML).toBe("");
    },
  );

  it("shows nothing without a status", () => {
    const { container } = notices({});
    expect(container.innerHTML).toBe("");
  });
});

describe("OkfNotices, stale_after", () => {
  it("warns with the date when it is in the past", () => {
    notices({ stale_after: "2026-10-01" });
    const note = screen.getByRole("note");
    expect(note.getAttribute("data-testid")).toBe("okf-notice-stale");
    expect(note.textContent).toBe(
      "This document may be out of date: it was due for review on 1 Oct 2026 (9 days ago).",
    );
    expect(note.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-01");
  });

  it("does not warn when the date is in the future", () => {
    const { container } = notices({ stale_after: "2026-10-11" });
    expect(container.innerHTML).toBe("");
    cleanup();
    expect(notices({ stale_after: "2999-12-31" }).container.innerHTML).toBe("");
  });

  it("does not warn on the day itself: a date is valid through its UTC day", () => {
    expect(notices({ stale_after: "2026-10-10" }).container.innerHTML).toBe("");
    cleanup();
    expect(
      notices({ stale_after: "2026-10-10" }, new Date("2026-10-10T23:59:59.999Z")).container
        .innerHTML,
    ).toBe("");
  });

  it("warns from the start of the next UTC day, whatever the server's time zone", () => {
    notices({ stale_after: "2026-10-10" }, new Date("2026-10-11T00:00:01Z"));
    expect(screen.getByRole("note").textContent).toContain("(1 day ago)");
  });

  it("shows the time when the date has one", () => {
    notices({ stale_after: "2026-10-10T08:00:00Z" });
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("10 Oct 2026, 08:00 UTC (today)");
  });

  it("warns for a very old date", () => {
    notices({ stale_after: "1999-12-31" });
    expect(screen.getByRole("note").textContent).toContain("31 Dec 1999 (26 years ago)");
  });

  it("does not warn for a date that is not valid", () => {
    for (const stale_after of ["soon", "2026-02-29", 2020, ["2020-01-01"], { a: 1 }]) {
      expect(notices({ stale_after }).container.innerHTML).toBe("");
      cleanup();
    }
  });

  it("accepts a leap day in a leap year", () => {
    notices({ stale_after: "2024-02-29" });
    expect(screen.getByRole("note").textContent).toContain("29 Feb 2024");
  });
});

describe("OkfNotices, stacking", () => {
  it("stacks a deprecation and a stale warning, status first", () => {
    notices({ status: "deprecated", stale_after: "2025-01-01" });
    const list = screen.getByTestId("okf-notices");
    const kinds = within(list)
      .getAllByRole("note")
      .map((n) => n.getAttribute("data-testid"));
    expect(kinds).toEqual(["okf-notice-deprecated", "okf-notice-stale"]);
  });

  it("stacks a draft and a stale warning", () => {
    notices({ status: "draft", stale_after: "2025-01-01" });
    expect(screen.getAllByRole("note")).toHaveLength(2);
  });

  it("uses notes, not alerts", () => {
    notices({ status: "deprecated", stale_after: "2025-01-01" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("escapes a hostile date text (never reaches a warning, so it is not shown here)", () => {
    const { container } = notices({ stale_after: "<script>alert(1)</script>" });
    expect(container.innerHTML).toBe("");
  });
});
