import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  ModerationFilters,
  ModerationRow,
} from "@docmyrepos/core/internal/comments-moderation";

import { ModerationFilterBar, ModerationList } from "./moderation-list";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const NOW = "2026-10-10T12:00:00.000Z";
const none: ModerationFilters = { state: null, githubRepoId: null, cursor: null };

function row(over: Partial<ModerationRow> & { id: number }): ModerationRow {
  return {
    isReply: false,
    state: "live",
    githubRepoId: 7,
    path: "docs/a.md",
    repoLabel: "acme/api",
    repoHref: "/acme/api",
    docHref: "/acme/api/docs/a",
    authorLabel: "ana",
    authorEmail: "ana@example.com",
    asOrg: false,
    excerpt: "hello",
    createdAt: "2026-10-10T11:00:00.000Z",
    editedAt: null,
    deleted: false,
    deletedByAdmin: false,
    groupCount: null,
    ...over,
  };
}

const html = (rows: ModerationRow[], filters = none, nextCursor: string | null = null) =>
  renderToStaticMarkup(
    <ModerationList rows={rows} filters={filters} nextCursor={nextCursor} now={NOW} />,
  );

describe("ModerationFilterBar", () => {
  it("has a link per state that keeps the repository, and marks the current one", () => {
    const out = renderToStaticMarkup(
      <ModerationFilterBar filters={{ state: "orphaned", githubRepoId: 7, cursor: "x|1" }} />,
    );
    for (const state of ["live", "deleted", "orphaned", "blocked"]) {
      expect(out).toContain(`href="/admin/comments?state=${state}&amp;repo=7"`);
    }
    expect(out).toContain('href="/admin/comments?repo=7"');
    expect(out).toContain('href="/admin/comments?state=orphaned"');
    expect(out).toMatch(/aria-current="true"[^>]*>Orphaned/);
    expect(out).not.toContain("cursor");
  });
});

describe("ModerationList", () => {
  it("shows author, email, repository, document link, time and the state label", () => {
    const out = html([row({ id: 1 })]);
    expect(out).toContain("ana@example.com");
    expect(out).toContain('href="/acme/api"');
    expect(out).toContain('href="/acme/api/docs/a"');
    expect(out).toContain("Live");
    expect(out).toContain("1 hour ago");
    expect(out).toContain('href="/admin/comments?repo=7"');
    expect(out).toContain("Delete");
  });

  it("marks the organization in text", () => {
    expect(html([row({ id: 1, asOrg: true })])).toContain("Posted as the organization");
    expect(html([row({ id: 1 })])).not.toContain("Posted as the organization");
  });

  it("labels a comment in a blocked repository and still offers delete", () => {
    const out = html([row({ id: 1, state: "blocked" })]);
    expect(out).toContain("In a blocked repository");
    expect(out).toContain('aria-label="Delete: ana"');
  });

  it("shows deleted rows without text and offers permanent removal, not delete", () => {
    const out = html([
      row({ id: 1, state: "deleted", deleted: true, deletedByAdmin: true, excerpt: "" }),
    ]);
    expect(out).toContain("Deleted by an admin");
    expect(out).toContain("Remove permanently");
    expect(out).not.toContain('aria-label="Delete: ana"');
  });

  it("offers group removal for an orphaned document with its count", () => {
    const out = html([
      row({
        id: 1,
        state: "orphaned",
        repoLabel: null,
        repoHref: null,
        docHref: null,
        authorEmail: null,
        groupCount: 3,
      }),
    ]);
    expect(out).toContain("Orphaned");
    expect(out).toContain("(account removed)");
    expect(out).toContain("repository 7 (removed)");
    expect(out).toContain("Remove all 3 comments of this document");
    expect(out).toContain("Remove permanently");
    expect(out).not.toContain('aria-label="Delete: ana"');
  });

  it("has no group button for a single orphan", () => {
    expect(html([row({ id: 1, state: "orphaned", groupCount: 1 })])).not.toContain("Remove all");
  });

  it("renders hostile text as text", () => {
    const out = html([row({ id: 1, excerpt: "<script>alert(1)</script> <img onerror=x>" })]);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });

  it("pages with plain links and keeps the filters", () => {
    const out = html([row({ id: 1 })], { state: "live", githubRepoId: 7, cursor: "c|9" }, "d|3");
    expect(out).toContain('href="/admin/comments?state=live&amp;repo=7&amp;cursor=d%7C3"');
    expect(out).toContain('href="/admin/comments?state=live&amp;repo=7"');
    expect(out).toContain("Older comments");
    expect(out).toContain("Back to the newest");
    expect(html([row({ id: 1 })])).not.toContain("Older comments");
  });

  it("says so when nothing matches", () => {
    expect(html([])).toContain("No comments match.");
  });
});
