import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommentCountLink } from "./comment-count-link";
import { comment, ready, thread } from "./comments-fixtures";
import { CommentsSection } from "./comments-section";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const html = (data: Parameters<typeof CommentsSection>[0]["data"]) =>
  renderToStaticMarkup(<CommentsSection data={data} />);

describe("CommentsSection (server markup)", () => {
  it("renders nothing when comments are off or nobody is signed in", () => {
    expect(html({ status: "disabled" })).toBe("");
    expect(html({ status: "hidden" })).toBe("");
  });

  it("shows a short notice when the read failed", () => {
    const out = html({ status: "unavailable" });
    expect(out).toContain("Comments are temporarily unavailable.");
    expect(out).toContain('id="comments"');
    expect(out).toContain("data-read-hide");
  });

  it("says so when there are no comments, and explains that posting needs script", () => {
    const out = html(ready([]));
    expect(out).toContain('aria-labelledby="comments-heading"');
    expect(out).toContain("0 comments, 0 open threads");
    expect(out).toContain("No comments yet.");
    expect(out).toMatch(/<noscript>[\s\S]*needs JavaScript[\s\S]*<\/noscript>/);
    // Static markup has no form and no buttons: it reads without script.
    expect(out).not.toContain("<textarea");
    expect(out).not.toContain("<button");
  });

  it("renders threads, replies, time with the exact time, edited and the data-read-hide marker", () => {
    const root = comment({
      id: 1,
      body: "Line one\nLine two",
      editedAt: "2026-10-10T11:30:00.000Z",
    });
    const reply = comment({ id: 2, parentId: 1, authorLabel: "bob", authorId: 3, body: "Reply" });
    const out = html(ready([thread(root, [reply])]));
    expect(out).toContain('data-testid="comments-section"');
    expect(out).toMatch(/<section[^>]*data-read-hide/);
    expect(out).toContain("2 comments, 1 open thread");
    expect(out).toContain(">ana<");
    expect(out).toContain(">bob<");
    expect(out).toContain("Line one\nLine two");
    expect(out).toContain("1 hour ago");
    expect(out).toContain("10 Oct 2026, 11:00 UTC");
    expect(out).toContain("edited");
    expect(out).toMatch(/<ol[^>]*>[\s\S]*<ol[^>]*>[\s\S]*Reply/);
  });

  it("shows a deleted comment as a placeholder with its replies", () => {
    const root = comment({ id: 1, deleted: true, authorLabel: "", body: "" });
    const reply = comment({ id: 2, parentId: 1, body: "Still here" });
    const out = html(ready([thread(root, [reply])]));
    expect(out).toContain("This comment was deleted");
    expect(out).toContain("Still here");
    expect(out).toContain("1 comment, 1 open thread");
  });

  it("collapses resolved threads in a details element with the state as text", () => {
    const root = comment({ id: 1, resolvedAt: "2026-10-10T11:45:00.000Z", body: "Fixed now" });
    const out = html(ready([thread(root, [comment({ id: 2, parentId: 1 })])]));
    expect(out).toMatch(/<details[^>]*data-testid="resolved-thread"/);
    expect(out).not.toMatch(/<details[^>]* open/);
    expect(out).toContain("Resolved</span> thread started by");
    expect(out).toContain("1 reply");
    expect(out).toContain("0 open threads");
  });

  it("shows the organization name with an Organization badge, and who posted it to admins only", () => {
    const org = comment({
      id: 1,
      asOrg: true,
      authorLabel: "carol",
      authorEmail: "carol@example.com",
    });
    const asAdmin = html(
      ready([thread(org)], { orgName: "Acme Inc", viewer: { userId: 9, isAdmin: true } }),
    );
    expect(asAdmin).toContain(">Acme Inc<");
    expect(asAdmin).toContain(">Organization<");
    expect(asAdmin).toContain("posted by carol, carol@example.com");

    const plain = comment({ id: 1, asOrg: true, authorLabel: "carol" });
    const asUser = html(ready([thread(plain)], { orgName: "Acme Inc" }));
    expect(asUser).toContain(">Acme Inc<");
    expect(asUser).toContain(">Organization<");
    expect(asUser).not.toContain("carol");
  });

  it("shows an email only when the data carries one (admins), and a removed author's stored name", () => {
    const withEmail = comment({ id: 1, authorEmail: "ana@example.com" });
    expect(html(ready([thread(withEmail)]))).toContain("(ana@example.com)");
    const removed = comment({ id: 2, authorId: null, authorLabel: "gone" });
    const out = html(ready([thread(removed)]));
    expect(out).toContain(">gone<");
    expect(out).not.toContain("@");
  });

  it("shows markup in a comment as literal text and links only safe addresses", () => {
    const body =
      "<script>alert(1)</script> **bold** <img src=x onerror=alert(1)> javascript:alert(1) https://example.com/page [x](data:text/html,hi)";
    const out = html(ready([thread(comment({ id: 1, body }))]));
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("**bold**");
    expect(out).toContain('href="https://example.com/page"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).not.toMatch(/href="javascript:/i);
    expect(out).not.toMatch(/href="data:/i);
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  it("copes with very long unbroken text by wrapping it", () => {
    const out = html(ready([thread(comment({ id: 1, body: "a".repeat(5000) }))]));
    expect(out).toContain("[overflow-wrap:anywhere]");
    expect(out).toContain("whitespace-pre-wrap");
  });
});

describe("CommentCountLink", () => {
  it("links to the section with a singular and plural label", () => {
    expect(renderToStaticMarkup(<CommentCountLink count={1} />)).toContain(">1 comment<");
    const out = renderToStaticMarkup(<CommentCountLink count={3} />);
    expect(out).toContain('href="#comments"');
    expect(out).toContain(">3 comments<");
  });
});
