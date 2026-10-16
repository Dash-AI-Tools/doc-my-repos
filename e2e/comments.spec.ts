import type { Locator, Page } from "@playwright/test";

import { COMMENT_DOCS, ORPHANS } from "./support/comment-data";
import { syncDocument } from "./support/comment-seed";
import { docUrl, openSession } from "./support/comments";
import { expect, test } from "./support/csp";
import { SKIP_DB, SKIP_DB_REASON } from "./support/stack";

/**
 * Document comments end to end (document-comments task 6.1), on the `comments` server (its own
 * seeded database with users and comments) and, for the switch, on `commentsoff`
 * (`comments.enabled: false`). Each user is a browser context whose requests carry `x-e2e-user`.
 *
 * The tests are serial: the first block builds one conversation on `main` (ana posts, replies and
 * edits; ben reads it; and so on). The layout and axe checks are in `comments-layout.spec.ts`.
 * Authorization matrices, validation and the limits are covered with a real database in
 * `src/server/comments/*.test.ts`; this file covers the browser and the whole stack.
 */

test.skip(SKIP_DB, SKIP_DB_REASON);
test.describe.configure({ mode: "serial" });

const MAIN = COMMENT_DOCS.main;
const REPO = `${MAIN.owner}/${MAIN.name}`;

const ROOT = "The install step is missing the database.";
const ROOT_EDITED = "The install step is missing the database and the cache.";
const ANA_REPLY = "I will add both to the setup page.";
const BEN_REPLY = "Thanks, that helps.";
const BEN_NESTED = "Reply to a reply by ben.";
const THROWAWAY = "A thread nobody answers.";
const RESOLVABLE = "Is the port documented?";
const REOPENING = "No, it is not documented yet.";
const ORG_REPLY = "The platform team will document it this week.";
const ORG_EDITED = "The platform team will document it by Friday.";

const section = (page: Page) => page.getByTestId("comments-section");
const status = (page: Page) => page.getByTestId("comments-status");
const thread = (page: Page, text: string): Locator =>
  section(page).getByTestId("comment-threads").locator("> li").filter({ hasText: text });
const comment = (page: Page, text: string): Locator =>
  section(page).getByTestId("comment").filter({ hasText: text });

async function open(
  page: Page,
  doc: { owner: string; name: string; path: string } = MAIN,
): Promise<void> {
  await page.goto(docUrl(doc));
  await expect(section(page).getByRole("heading", { level: 2, name: "Comments" })).toBeVisible();
  // The composer only exists once the page is interactive.
  await expect(section(page).getByLabel("Add a comment")).toBeVisible();
}

async function post(page: Page, text: string): Promise<void> {
  await section(page).getByLabel("Add a comment").fill(text);
  await section(page).getByRole("button", { name: "Post comment" }).click();
  await expect(comment(page, text)).toBeFocused();
  await expect(status(page)).toHaveText("Comment posted.");
}

async function reply(page: Page, within: Locator, target: string, text: string): Promise<void> {
  await within
    .getByRole("button", { name: `Reply to the comment by ${target}` })
    .first()
    .click();
  await within.getByLabel(`Write a reply to the comment by ${target}`).fill(text);
  await within.getByRole("button", { name: "Post reply" }).click();
  await expect(comment(page, text)).toBeFocused();
  await expect(status(page)).toHaveText("Reply posted.");
}

test("a user posts, replies and edits; another user sees all of it", async ({ browser }) => {
  const ana = await openSession(browser, { user: "ana" });
  const ben = await openSession(browser, { user: "ben" });
  try {
    await open(ana.page);
    await expect(section(ana.page).getByTestId("comments-empty")).toBeVisible();
    await post(ana.page, ROOT);
    await expect(comment(ana.page, ROOT)).toContainText("ana");
    await reply(ana.page, thread(ana.page, ROOT), "ana", ANA_REPLY);

    await comment(ana.page, ROOT).getByRole("button", { name: "Edit the comment by ana" }).click();
    await ana.page.getByRole("textbox", { name: "Edit the comment by ana" }).fill(ROOT_EDITED);
    await ana.page.getByRole("button", { name: "Save changes" }).click();
    await expect(status(ana.page)).toHaveText("Comment updated.");
    await expect(comment(ana.page, ROOT_EDITED)).toContainText("edited");
    await expect(comment(ana.page, ROOT_EDITED)).toBeFocused();

    // Another user sees the thread, the reply and the "edited" marker, without edit buttons.
    await open(ben.page);
    await expect(thread(ben.page, ROOT_EDITED)).toBeVisible();
    await expect(comment(ben.page, ROOT_EDITED)).toContainText("edited");
    await expect(comment(ben.page, ANA_REPLY)).toBeVisible();
    await expect(ben.page.getByTestId("comment-count-link")).toHaveText("2 comments");
    await expect(
      section(ben.page).getByRole("button", { name: /^(Edit|Delete) the comment by ana$/ }),
    ).toHaveCount(0);

    // A reply to a reply lands in the same thread.
    await reply(ben.page, comment(ben.page, ANA_REPLY), "ana", BEN_REPLY);
    await reply(ben.page, comment(ben.page, BEN_REPLY), "ben", BEN_NESTED);
    await ben.page.reload();
    await expect(section(ben.page).getByTestId("comment-threads").locator("> li")).toHaveCount(1);
    await expect(thread(ben.page, ROOT_EDITED).getByTestId("comment")).toHaveCount(4);
  } finally {
    await ana.close();
    await ben.close();
  }
});

test("deleting a comment with replies leaves a placeholder; without replies it disappears", async ({
  browser,
}) => {
  const ana = await openSession(browser, { user: "ana" });
  const ben = await openSession(browser, { user: "ben" });
  try {
    await open(ana.page);
    await post(ana.page, THROWAWAY);
    await comment(ana.page, THROWAWAY)
      .getByRole("button", { name: "Delete the comment by ana" })
      .click();
    await ana.page.getByRole("button", { name: "Delete comment" }).click();
    await expect(status(ana.page)).toHaveText("Comment deleted.");
    await expect(ana.page.getByText(THROWAWAY)).toHaveCount(0);

    await comment(ana.page, ROOT_EDITED)
      .getByRole("button", { name: "Delete the comment by ana" })
      .click();
    await expect(ana.page.getByRole("group", { name: /Confirm deleting/ })).toContainText(
      "replies stay",
    );
    await ana.page.getByRole("button", { name: "Delete comment" }).click();
    await expect(status(ana.page)).toHaveText("Comment deleted.");
    await expect(ana.page.getByText("This comment was deleted")).toBeVisible();

    await open(ben.page);
    await expect(ben.page.getByText("This comment was deleted")).toBeVisible();
    await expect(comment(ben.page, ANA_REPLY)).toBeVisible();
    await expect(comment(ben.page, BEN_NESTED)).toBeVisible();
    await expect(ben.page.getByText(ROOT_EDITED)).toHaveCount(0);
    // The text is gone from storage: the API no longer returns it either.
    const api = await ben.context.request.get(
      `/api/comments?repo=${REPO}&path=${encodeURIComponent(MAIN.path)}`,
    );
    expect(api.status()).toBe(200);
    expect(await api.text()).not.toContain(ROOT_EDITED);
  } finally {
    await ana.close();
    await ben.close();
  }
});

test("resolving collapses a thread and a reply reopens it", async ({ browser }) => {
  const ana = await openSession(browser, { user: "ana" });
  const ben = await openSession(browser, { user: "ben" });
  try {
    await open(ana.page);
    await post(ana.page, RESOLVABLE);
    await thread(ana.page, RESOLVABLE)
      .getByRole("button", { name: "Resolve the thread started by ana" })
      .click();
    await expect(status(ana.page)).toHaveText("Thread resolved.");
    const resolved = thread(ana.page, RESOLVABLE).getByTestId("resolved-thread");
    await expect(resolved).toBeVisible();
    await expect(resolved.locator("summary")).toContainText("Resolved");
    await expect(resolved).not.toHaveAttribute("open", "");
    await expect(ana.page.getByTestId("comments-summary")).toContainText("open thread");

    // Someone else cannot resolve it, but can expand it and reply, which reopens it.
    await open(ben.page);
    await expect(thread(ben.page, RESOLVABLE).getByTestId("resolved-thread")).not.toHaveAttribute(
      "open",
      "",
    );
    await thread(ben.page, RESOLVABLE).locator("summary").click();
    await expect(
      thread(ben.page, RESOLVABLE).getByRole("button", { name: /^(Resolve|Reopen) the thread/ }),
    ).toHaveCount(0);
    await reply(ben.page, thread(ben.page, RESOLVABLE), "ana", REOPENING);
    await expect(thread(ben.page, RESOLVABLE).getByTestId("resolved-thread")).toHaveCount(0);
    await expect(
      thread(ben.page, RESOLVABLE).getByRole("button", {
        name: "Resolve the thread started by ana",
      }),
    ).toHaveCount(0); // ben is not the author and not an admin
  } finally {
    await ana.close();
    await ben.close();
  }
});

test("an admin comments as the organization, another admin edits it, a viewer cannot", async ({
  browser,
}) => {
  const olga = await openSession(browser, { user: "olga" });
  const otto = await openSession(browser, { user: "otto" });
  const ben = await openSession(browser, { user: "ben" });
  try {
    await open(olga.page);
    await olga.page
      .getByTestId("comment-threads")
      .locator("> li")
      .filter({ hasText: RESOLVABLE })
      .getByRole("button", { name: "Reply to the comment by ana" })
      .first()
      .click();
    await olga.page.getByLabel(/^Write a reply to the comment by ana$/).fill(ORG_REPLY);
    await thread(olga.page, RESOLVABLE).getByLabel("Comment as the organization").check();
    await olga.page.getByRole("button", { name: "Post reply" }).click();
    await expect(comment(olga.page, ORG_REPLY)).toBeFocused();
    await expect(comment(olga.page, ORG_REPLY)).toContainText("Organization");
    // Admins can tell which admin wrote it.
    await expect(comment(olga.page, ORG_REPLY).getByTestId("comment-aside")).toContainText(
      "posted by olga",
    );

    // Another admin edits it.
    await open(otto.page);
    await comment(otto.page, ORG_REPLY)
      .getByRole("button", { name: /^Edit the comment by / })
      .click();
    await otto.page.getByRole("textbox", { name: /^Edit the comment by / }).fill(ORG_EDITED);
    await otto.page.getByRole("button", { name: "Save changes" }).click();
    await expect(status(otto.page)).toHaveText("Comment updated.");
    await expect(comment(otto.page, ORG_EDITED)).toContainText("edited");

    // A viewer sees the badge but no edit button, no option, and a forged request is refused.
    await open(ben.page);
    await expect(comment(ben.page, ORG_EDITED)).toContainText("Organization");
    await expect(comment(ben.page, ORG_EDITED).getByTestId("comment-aside")).toHaveCount(0);
    await expect(
      comment(ben.page, ORG_EDITED).getByRole("button", { name: /^(Edit|Delete) the comment/ }),
    ).toHaveCount(0);
    await expect(ben.page.getByLabel("Comment as the organization")).toHaveCount(0);
    await ben.page
      .getByRole("button", { name: /^Reply to the comment by ana$/ })
      .first()
      .click();
    await expect(ben.page.getByLabel("Comment as the organization")).toHaveCount(0);

    const forged = await ben.context.request.post("/api/comments", {
      data: { repo: REPO, path: MAIN.path, body: "I am the organization", asOrganization: true },
    });
    expect(forged.status()).toBe(403);
    const listed = await ben.context.request.get(
      `/api/comments?repo=${REPO}&path=${encodeURIComponent(MAIN.path)}`,
    );
    expect(await listed.text()).not.toContain("I am the organization");
  } finally {
    await olga.close();
    await otto.close();
    await ben.close();
  }
});

test("blocking the repository hides its comments and allowing it restores them", async ({
  browser,
}) => {
  const doc = COMMENT_DOCS.blocked;
  const slug = `${doc.owner}/${doc.name}`;
  const admin = await openSession(browser); // the fixed e2e admin
  const ana = await openSession(browser, { user: "ana" });
  const api = `/api/comments?repo=${slug}&path=${encodeURIComponent(doc.path)}`;
  try {
    await open(ana.page, doc);
    await expect(section(ana.page).getByTestId("comment")).toHaveCount(2);
    expect((await ana.context.request.get(api)).status()).toBe(200);

    await admin.page.goto("/admin/repos");
    await admin.page.getByRole("button", { name: `Block ${slug}` }).click();
    await expect(admin.page.getByText(`${slug} is blocked.`)).toBeVisible();

    expect((await ana.context.request.get(api)).status()).toBe(404);
    const blockedPage = await ana.page.goto(docUrl(doc));
    expect(blockedPage?.status()).toBe(404);
    await expect(ana.page.getByTestId("comments-section")).toHaveCount(0);
    const post = await ana.context.request.post("/api/comments", {
      data: { repo: slug, path: doc.path, body: "Into the void" },
    });
    expect(post.status()).toBe(404);

    await admin.page.goto("/admin/repos");
    await admin.page.getByRole("button", { name: `Allow ${slug}` }).click();
    await expect(admin.page.getByText(`${slug} is visible again.`)).toBeVisible();

    await open(ana.page, doc);
    await expect(section(ana.page).getByTestId("comment")).toHaveCount(2);
    await expect(ana.page.getByText("Into the void")).toHaveCount(0);
  } finally {
    await admin.close();
    await ana.close();
  }
});

test("a document removed by a sync loses its comments from view and gets them back when restored", async ({
  browser,
}) => {
  const doc = COMMENT_DOCS.synced;
  const slug = `${doc.owner}/${doc.name}`;
  const ana = await openSession(browser, { user: "ana" });
  const admin = await openSession(browser);
  const api = `/api/comments?repo=${slug}&path=${encodeURIComponent(doc.path)}`;
  try {
    await open(ana.page, doc);
    await expect(comment(ana.page, "Synced root comment.")).toBeVisible();
    await expect(comment(ana.page, "Synced reply comment.")).toBeVisible();

    await syncDocument(doc, "remove");
    expect((await ana.page.goto(docUrl(doc)))?.status()).toBe(404);
    expect((await ana.context.request.get(api)).status()).toBe(404);
    // Stored, not shown: the admin page lists them as orphaned.
    await admin.page.goto("/admin/comments?state=orphaned");
    await expect(admin.page.getByText("Synced root comment.")).toBeVisible();

    await syncDocument(doc, "restore");
    await open(ana.page, doc);
    await expect(comment(ana.page, "Synced root comment.")).toBeVisible();
    await expect(comment(ana.page, "Synced reply comment.")).toBeVisible();
    await admin.page.goto("/admin/comments?state=orphaned");
    await expect(admin.page.getByText("Synced root comment.")).toHaveCount(0);
  } finally {
    await ana.close();
    await admin.close();
  }
});

test("the 21st comment within ten minutes is refused with a message", async ({ browser }) => {
  const rita = await openSession(browser, { user: "rita" });
  const doc = COMMENT_DOCS.rate;
  try {
    for (let i = 1; i <= 20; i++) {
      const response = await rita.context.request.post("/api/comments", {
        data: { repo: `${doc.owner}/${doc.name}`, path: doc.path, body: `Comment number ${i}.` },
      });
      expect(response.status(), `comment ${i}`).toBe(201);
    }
    await open(rita.page, doc);
    await section(rita.page).getByLabel("Add a comment").fill("Comment number 21.");
    await section(rita.page).getByRole("button", { name: "Post comment" }).click();
    await expect(section(rita.page).getByRole("alert")).toContainText("You are posting too fast");
    await expect(section(rita.page).getByRole("alert")).toContainText("Try again in");
    // What was typed is kept, and nothing was stored.
    await expect(section(rita.page).getByLabel("Add a comment")).toHaveValue("Comment number 21.");
    await rita.page.reload();
    await expect(rita.page.getByText("Comment number 21.")).toHaveCount(0);
    await expect(rita.page.getByTestId("comment-count-link")).toHaveText("20 comments");
  } finally {
    await rita.close();
  }
});

test("a write from a foreign origin, or without a JSON content type, is refused", async ({
  browser,
}) => {
  const ana = await openSession(browser, { user: "ana" });
  const doc = COMMENT_DOCS.main;
  const url = `/api/comments?repo=${REPO}&path=${encodeURIComponent(doc.path)}`;
  try {
    const before = await (await ana.context.request.get(url)).text();
    const foreign = await ana.context.request.post("/api/comments", {
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
      data: { repo: REPO, path: doc.path, body: "Forged from another site" },
    });
    expect(foreign.status()).toBe(403);
    const wrongOrigin = await ana.context.request.post("/api/comments", {
      headers: { Origin: "https://evil.example" },
      data: { repo: REPO, path: doc.path, body: "Forged from another site" },
    });
    expect(wrongOrigin.status()).toBe(403);
    const form = await ana.context.request.post("/api/comments", {
      headers: { "Content-Type": "text/plain" },
      data: JSON.stringify({ repo: REPO, path: doc.path, body: "Forged as text" }),
    });
    expect(form.status()).toBe(403);
    const deletion = await ana.context.request.delete("/api/comments/1", {
      headers: { Origin: "https://evil.example" },
    });
    expect(deletion.status()).toBe(403);
    expect(await (await ana.context.request.get(url)).text()).toBe(before);
  } finally {
    await ana.close();
  }
});

test("the admin page lists orphans and purges them, and protects live comments", async ({
  browser,
}) => {
  const admin = await openSession(browser);
  try {
    await admin.page.goto("/admin/comments?state=orphaned");
    await expect(admin.page.getByRole("heading", { level: 1, name: "Comments" })).toBeVisible();
    const rows = admin.page.getByTestId("moderation-row");
    await expect(rows.filter({ hasText: "Orphan of a removed document" })).toHaveCount(3);
    await expect(rows.filter({ hasText: "Orphan of a removed repository" })).toHaveCount(2);
    for (const row of await rows.all()) await expect(row).toHaveAttribute("data-state", "orphaned");

    // A whole orphaned document in one action, after a confirmation that states the count.
    await rows
      .filter({ hasText: "Orphan of a removed document" })
      .first()
      .getByRole("button", { name: /^Remove all 3 comments of this document/ })
      .click();
    await expect(admin.page.getByRole("group", { name: /^Confirm: Remove all 3/ })).toContainText(
      "Permanently remove 3 comments",
    );
    await admin.page.getByRole("button", { name: "Remove 3 comments" }).click();
    await expect(admin.page.getByTestId("moderation-notice")).toHaveText(
      "3 comments removed permanently.",
    );
    await expect(rows.filter({ hasText: "Orphan of a removed document" })).toHaveCount(0);
    await expect(rows.filter({ hasText: "Orphan of a removed repository" })).toHaveCount(2);

    // Live comments on existing documents cannot be purged, whatever is sent.
    const live = await admin.context.request.get("/api/admin/comments?state=live");
    const page = (await live.json()) as { items: { id: number }[] };
    const id = page.items[0]?.id;
    expect(id).toBeDefined();
    const refused = await admin.context.request.post("/api/admin/comments/purge", {
      data: { ids: [id] },
    });
    expect(refused.status()).toBe(409);
  } finally {
    await admin.close();
  }
});

test("with comments.enabled false: no section, the APIs answer 404, the admin page can still purge", async ({
  browser,
}) => {
  const ana = await openSession(browser, { user: "ana", stack: "commentsoff" });
  const admin = await openSession(browser, { stack: "commentsoff" });
  try {
    const page = ana.page;
    expect((await page.goto(docUrl(MAIN)))?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("comments-section")).toHaveCount(0);
    await expect(page.getByTestId("comment-count-link")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Comments" })).toHaveCount(0);

    const url = `/api/comments?repo=${REPO}&path=${encodeURIComponent(MAIN.path)}`;
    expect((await ana.context.request.get(url)).status()).toBe(404);
    expect(
      (
        await ana.context.request.post("/api/comments", {
          data: { repo: REPO, path: MAIN.path, body: "Not stored" },
        })
      ).status(),
    ).toBe(404);
    expect(
      (await ana.context.request.patch("/api/comments/1", { data: { body: "x" } })).status(),
    ).toBe(404);

    await admin.page.goto("/admin/comments?state=orphaned");
    await expect(admin.page.getByTestId("comments-off-notice")).toContainText("Comments are off");
    const rows = admin.page.getByTestId("moderation-row");
    await expect(rows.filter({ hasText: "Orphan of a removed document" })).toHaveCount(
      ORPHANS.document.count,
    );
    await rows
      .filter({ hasText: "Orphan of a removed document" })
      .first()
      .getByRole("button", { name: /^Remove all 3 comments of this document/ })
      .click();
    await admin.page.getByRole("button", { name: "Remove 3 comments" }).click();
    await expect(admin.page.getByTestId("moderation-notice")).toHaveText(
      "3 comments removed permanently.",
    );
    // Stored comments of live documents are kept.
    await admin.page.goto("/admin/comments?state=live");
    await expect(admin.page.getByTestId("moderation-row").first()).toBeVisible();
  } finally {
    await ana.close();
    await admin.close();
  }
});
