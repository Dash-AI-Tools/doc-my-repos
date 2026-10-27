// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommentData, ThreadData } from "@docmyrepos/core/internal/comments-view";

import { comment, NOW, thread, forViewer } from "./comments-fixtures";
import { CommentsClient } from "./comments-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}
const calls: Call[] = [];
type Responder = (call: Call) => { status: number; json: unknown };
let responder: Responder = () => ({ status: 500, json: {} });

beforeEach(() => {
  calls.length = 0;
  refresh.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? "GET",
        url,
        body: typeof init.body === "string" ? (JSON.parse(init.body) as Call["body"]) : null,
        headers: init.headers as Record<string, string>,
      };
      calls.push(call);
      const { status, json } = responder(call);
      return new Response(JSON.stringify(json), { status });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function view(threads: ThreadData[], over: Partial<Parameters<typeof CommentsClient>[0]> = {}) {
  // The server sends each comment with the viewer's permissions on it.
  const initial = over.viewer ? forViewer(threads, over.viewer) : threads;
  return render(
    <CommentsClient
      repo="acme/api"
      path="docs/a.md"
      initialCursor={null}
      viewer={{ userId: 2, isAdmin: false }}
      orgName="Acme Inc"
      loadedAt={NOW}
      {...over}
      initialThreads={over.initialThreads ?? initial}
    />,
  );
}

const mine = (id: number, over: Partial<CommentData> = {}) => comment({ id, ...over });
const theirs = (id: number, over: Partial<CommentData> = {}) =>
  comment({ id, authorId: 3, authorLabel: "bob", ...over });

function ok(status: number, c: CommentData, t: ThreadData | null, removed = false) {
  return { status, json: { comment: c, thread: t, removed } };
}

async function type(label: string | RegExp, text: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
}

async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

const status = () => screen.getByTestId("comments-status").textContent;

describe("CommentsClient", () => {
  it("posts a thread: JSON write, clears the form, announces, focuses the new comment, refreshes", async () => {
    view([]);
    const created = mine(10, { body: "The install step is missing the database." });
    responder = () => ok(201, created, thread(created));
    await type("Add a comment", "The install step is missing the database.");
    await click("Post comment");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/api/comments",
      body: {
        repo: "acme/api",
        path: "docs/a.md",
        body: "The install step is missing the database.",
      },
    });
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.body).not.toHaveProperty("parentId");
    expect(calls[0]!.body).not.toHaveProperty("asOrganization");
    expect(screen.getByText("The install step is missing the database.")).toBeTruthy();
    expect(status()).toBe("Comment posted.");
    expect((screen.getByLabelText("Add a comment") as HTMLTextAreaElement).value).toBe("");
    expect(document.activeElement?.id).toBe("comment-10");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("comments-empty")).toBeNull();
  });

  it("shows validation messages and keeps the typed text without calling the server", async () => {
    view([]);
    await type("Add a comment", "   ");
    await click("Post comment");
    expect(screen.getByRole("alert").textContent).toBe("Write something before posting.");
    expect(calls).toHaveLength(0);

    await type("Add a comment", "x".repeat(4001));
    expect(screen.getByText(/1 over the limit/)).toBeTruthy();
    await click("Post comment");
    expect(screen.getByRole("alert").textContent).toMatch(/at most 4,000 characters/);
    expect((screen.getByLabelText("Add a comment") as HTMLTextAreaElement).value).toHaveLength(
      4001,
    );
    expect(calls).toHaveLength(0);
  });

  it("counts characters", () => {
    view([]);
    expect(screen.getByText(/0 of 4,000 characters/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Add a comment"), { target: { value: "héllo 😀" } });
    expect(screen.getByText(/7 of 4,000 characters/)).toBeTruthy();
  });

  it("shows a 429 message with the wait and keeps the text", async () => {
    view([]);
    responder = () => ({
      status: 429,
      json: { error: "You are posting too fast", code: "rate_limited", retryAfterSeconds: 240 },
    });
    await type("Add a comment", "hello");
    await click("Post comment");
    expect(screen.getByRole("alert").textContent).toBe(
      "You are posting too fast. Try again in 4 minutes.",
    );
    expect((screen.getByLabelText("Add a comment") as HTMLTextAreaElement).value).toBe("hello");
    expect(status()).toContain("posting too fast");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("explains a network failure and a full document", async () => {
    view([]);
    responder = () => ({ status: 409, json: { error: "x", code: "document_full" } });
    await type("Add a comment", "hello");
    await click("Post comment");
    expect(screen.getByRole("alert").textContent).toMatch(/limit of 1,000 comments/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    await click("Post comment");
    expect(screen.getByRole("alert").textContent).toMatch(/Could not reach the server/);
  });

  it("replies to a reply: the form opens under the reply, posts its id and the comment lands in the same thread", async () => {
    const root = theirs(1);
    const first = theirs(2, { parentId: 1 });
    view([thread(root, [first])]);
    const second = mine(3, { parentId: 1, body: "me too" });
    responder = () => ok(201, second, thread(root, [first, second]));

    const buttons = screen.getAllByRole("button", { name: "Reply to the comment by bob" });
    expect(buttons).toHaveLength(2);
    await act(async () => {
      fireEvent.click(buttons[1]!);
    });
    const replyBox = document.getElementById("comment-2")!;
    const field = within(replyBox).getByLabelText("Write a reply to the comment by bob");
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "me too" } });
    await act(async () => {
      fireEvent.click(within(replyBox).getByRole("button", { name: "Post reply" }));
    });

    expect(calls[0]!.body).toMatchObject({ parentId: 2, body: "me too" });
    expect(screen.getAllByTestId("comment-threads")).toHaveLength(1);
    expect(screen.getByTestId("comment-threads").children).toHaveLength(1);
    expect(screen.getByText("me too")).toBeTruthy();
    expect(status()).toBe("Reply posted.");
    expect(document.activeElement?.id).toBe("comment-3");
  });

  it("edits in place, announces and returns focus; cancel returns focus without a request", async () => {
    view([thread(mine(1, { body: "old" }))]);
    await click("Edit the comment by ana");
    const field = screen.getByLabelText("Edit the comment by ana") as HTMLTextAreaElement;
    expect(field.value).toBe("old");
    await click("Cancel");
    expect(calls).toHaveLength(0);
    expect(document.activeElement?.id).toBe("comment-1");

    await click("Edit the comment by ana");
    const updated = mine(1, { body: "new", editedAt: NOW });
    responder = () => ok(200, updated, thread(updated));
    fireEvent.change(screen.getByLabelText("Edit the comment by ana"), {
      target: { value: "new" },
    });
    await click("Save changes");
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      url: "/api/comments/1",
      body: { body: "new" },
    });
    expect(screen.getByText("new")).toBeTruthy();
    expect(screen.getByText("edited")).toBeTruthy();
    expect(status()).toBe("Comment updated.");
    expect(document.activeElement?.id).toBe("comment-1");
  });

  it("offers edit and delete only on the viewer's own comments", () => {
    view([thread(theirs(1))]);
    return Promise.resolve().then(() => {
      expect(screen.queryByRole("button", { name: /Edit the comment/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Delete the comment/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Resolve/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Reply to the comment by bob" })).toBeTruthy();
    });
  });

  it("deletes with a confirmation: a root with replies becomes a placeholder", async () => {
    const root = mine(1);
    const reply = theirs(2, { parentId: 1 });
    view([thread(root, [reply])]);
    await click("Delete the comment by ana");
    expect(screen.getByText(/replies stay under/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(calls).toHaveLength(0);

    const placeholder = mine(1, { deleted: true, body: "", authorLabel: "", authorId: null });
    responder = () => ok(200, placeholder, thread(placeholder, [reply]));
    await click("Delete comment");
    expect(calls[0]).toMatchObject({ method: "DELETE", url: "/api/comments/1" });
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(screen.getByText("This comment was deleted")).toBeTruthy();
    expect(screen.getByText(reply.body)).toBeTruthy();
    expect(status()).toBe("Comment deleted.");
  });

  it("deletes a comment without replies: it disappears and focus goes to the heading", async () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<h2 id="comments-heading" tabindex="-1">Comments</h2>',
    );
    view([thread(mine(1))]);
    await click("Delete the comment by ana");
    responder = () => ok(200, mine(1, { deleted: true }), null, true);
    await click("Delete comment");
    expect(screen.queryByTestId("comment")).toBeNull();
    expect(screen.getByTestId("comments-empty")).toBeTruthy();
    expect(document.activeElement?.id).toBe("comments-heading");
    document.getElementById("comments-heading")?.remove();
  });

  it("resolves a thread (collapsed with a text state) and reopens it", async () => {
    view([thread(mine(1))]);
    const resolved = mine(1, { resolvedAt: NOW });
    responder = () => ok(200, resolved, thread(resolved));
    await click("Resolve the thread started by ana");
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      url: "/api/comments/1",
      body: { resolved: true },
    });
    expect(screen.getByTestId("resolved-thread")).toBeTruthy();
    expect(screen.getByText("Resolved")).toBeTruthy();
    expect(status()).toBe("Thread resolved.");

    const reopened = mine(1);
    responder = () => ok(200, reopened, thread(reopened));
    await click("Reopen the thread started by ana");
    expect(calls[1]!.body).toEqual({ resolved: false });
    expect(screen.queryByTestId("resolved-thread")).toBeNull();
    expect(status()).toBe("Thread reopened.");
  });

  it("a reply to a resolved thread shows it open again (the response carries the reopened thread)", async () => {
    const resolvedRoot = theirs(1, { resolvedAt: NOW });
    view([thread(resolvedRoot)]);
    const reply = mine(2, { parentId: 1 });
    const reopened = theirs(1);
    responder = () => ok(201, reply, thread(reopened, [reply]));
    const details = screen.getByTestId("resolved-thread");
    fireEvent.click(within(details).getByText(/thread started by/));
    await click("Reply to the comment by bob");
    fireEvent.change(screen.getByLabelText("Write a reply to the comment by bob"), {
      target: { value: "ok" },
    });
    await click("Post reply");
    expect(screen.queryByTestId("resolved-thread")).toBeNull();
  });

  it("lets only an admin comment as the organization, and sends the flag", async () => {
    const { unmount } = view([]);
    expect(screen.queryByLabelText("Comment as the organization")).toBeNull();
    unmount();

    view([], { viewer: { userId: 9, isAdmin: true } });
    const org = comment({ id: 5, asOrg: true, authorId: 9, authorLabel: "carol" });
    responder = () => ok(201, org, thread(org));
    await type("Add a comment", "Official answer");
    fireEvent.click(screen.getByLabelText("Comment as the organization"));
    await click("Post comment");
    expect(calls[0]!.body).toMatchObject({ asOrganization: true });
    expect(screen.getByText("Acme Inc")).toBeTruthy();
    expect(screen.getByText("Organization")).toBeTruthy();
  });

  it("lets any admin edit an organization comment but not rewrite a personal one", () => {
    const org = comment({ id: 1, asOrg: true, authorId: 9 });
    view([thread(org, [theirs(2, { parentId: 1 })])], { viewer: { userId: 77, isAdmin: true } });
    return Promise.resolve().then(() => {
      expect(screen.getAllByRole("button", { name: "Edit the comment by Acme Inc" })).toHaveLength(
        1,
      );
      expect(screen.queryByRole("button", { name: "Edit the comment by bob" })).toBeNull();
      expect(screen.getByRole("button", { name: /Resolve the thread/ })).toBeTruthy();
    });
  });

  it("shows more threads with the cursor, without repeating those already shown", async () => {
    view([thread(mine(1))], { initialCursor: "2026-10-10T11:00:00.000000Z|1" });
    const two = mine(2);
    responder = () => ({
      status: 200,
      json: { threads: [thread(mine(1)), thread(two)], nextCursor: null },
    });
    await click("Show more comments");
    expect(calls[0]!.method).toBe("GET");
    const url = new URL(calls[0]!.url, "http://x");
    expect(url.pathname).toBe("/api/comments");
    expect(url.searchParams.get("cursor")).toBe("2026-10-10T11:00:00.000000Z|1");
    expect(url.searchParams.get("repo")).toBe("acme/api");
    expect(screen.getAllByTestId("comment")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Show more comments" })).toBeNull();
    expect(status()).toBe("Loaded 1 more thread.");
    expect(document.activeElement?.id).toBe("comment-2");
  });

  it("reports a failed Show more", async () => {
    view([thread(mine(1))], { initialCursor: "2026-10-10T11:00:00.000000Z|1" });
    responder = () => ({ status: 503, json: { error: "x" } });
    await click("Show more comments");
    expect(screen.getByRole("alert").textContent).toMatch(/Something went wrong/);
  });

  it("is operable by keyboard: tab order reaches actions, the form submits with the button", async () => {
    view([thread(mine(1))]);
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toEqual([
      "Reply to the comment by ana",
      "Edit the comment by ana",
      "Delete the comment by ana",
      "Resolve the thread started by ana",
      "Post comment",
    ]);
    for (const b of screen.getAllByRole("button")) expect(b.tabIndex).toBe(0);
    const form = screen.getByLabelText("Add a comment").closest("form");
    expect(form).toBeTruthy();
    const created = mine(9);
    responder = () => ok(201, created, thread(created));
    fireEvent.change(screen.getByLabelText("Add a comment"), { target: { value: "enter" } });
    await act(async () => {
      fireEvent.submit(form!);
    });
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it("uses a polite status region", () => {
    view([]);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
  });
});
