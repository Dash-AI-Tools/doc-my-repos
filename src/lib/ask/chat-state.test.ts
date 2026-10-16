import { describe, expect, it } from "vitest";

import {
  INITIAL_CHAT,
  MAX_HISTORY,
  MAX_HISTORY_ANSWER_CHARS,
  chatReducer,
  historyFor,
  isActive,
  noticeFor,
  type ChatAction,
  type ChatMessage,
  type ChatState,
} from "./chat-state";
import type { AskEvent } from "./events";
import { ASK_ERROR_MESSAGES, ASK_NO_RESULTS } from "./messages";

const run = (actions: ChatAction[], from: ChatState = INITIAL_CHAT) =>
  actions.reduce(chatReducer, from);
const ev = (id: number, event: AskEvent): ChatAction => ({ type: "event", id, event });

describe("chatReducer", () => {
  it("starts a message in the searching state", () => {
    const state = run([{ type: "start", id: 1, question: "q" }]);
    expect(state.messages).toEqual([
      { id: 1, question: "q", answer: "", references: [], status: "searching", errorMessage: null },
    ]);
  });

  it("accumulates deltas, keeps references, and finishes with an announcement", () => {
    const refs = [{ n: 1, title: "T", repo: "a/b", path: "p.md", heading: null, href: "/a/b" }];
    const state = run([
      { type: "start", id: 1, question: "q" },
      ev(1, { event: "status", data: { state: "searching" } }),
      ev(1, { event: "references", data: { references: refs } }),
      ev(1, { event: "status", data: { state: "answering" } }),
      ev(1, { event: "delta", data: { text: "Hel" } }),
      ev(1, { event: "delta", data: { text: "lo [1]" } }),
      ev(1, { event: "done", data: { outcome: "ok" } }),
    ]);
    expect(state.messages[0]).toMatchObject({
      answer: "Hello [1]",
      references: refs,
      status: "done",
    });
    expect(state.announcement).toBe("Answer ready.");
  });

  it("maps done outcomes: cut off, and no results with its own announcement", () => {
    const base: ChatAction = { type: "start", id: 1, question: "q" };
    expect(
      run([base, ev(1, { event: "done", data: { outcome: "cut_off" } })]).messages[0]?.status,
    ).toBe("cut_off");
    const none = run([base, ev(1, { event: "done", data: { outcome: "no_results" } })]);
    expect(none.messages[0]?.status).toBe("no_results");
    expect(none.announcement).toBe(ASK_NO_RESULTS);
  });

  it("turns an error event into a fixed message, keeping the text received", () => {
    for (const kind of Object.keys(ASK_ERROR_MESSAGES) as (keyof typeof ASK_ERROR_MESSAGES)[]) {
      const state = run([
        { type: "start", id: 1, question: "q" },
        ev(1, { event: "delta", data: { text: "partial" } }),
        ev(1, { event: "error", data: { kind } }),
      ]);
      expect(state.messages[0]).toMatchObject({
        answer: "partial",
        status: "error",
        errorMessage: ASK_ERROR_MESSAGES[kind],
      });
      expect(state.announcement).toBe(ASK_ERROR_MESSAGES[kind]);
    }
  });

  it("stops only an active message and keeps its text", () => {
    const active = run([
      { type: "start", id: 1, question: "q" },
      ev(1, { event: "delta", data: { text: "so far" } }),
      { type: "stop", id: 1 },
    ]);
    expect(active.messages[0]).toMatchObject({ status: "stopped", answer: "so far" });
    const finished = run([
      { type: "start", id: 2, question: "q" },
      ev(2, { event: "done", data: { outcome: "ok" } }),
      { type: "stop", id: 2 },
    ]);
    expect(finished.messages[0]?.status).toBe("done");
  });

  it("fails an active message with the given text, and leaves a finished one alone", () => {
    const state = run([
      { type: "start", id: 1, question: "q" },
      { type: "fail", id: 1, message: "Nope." },
    ]);
    expect(state.messages[0]).toMatchObject({ status: "error", errorMessage: "Nope." });
    const finished = run([
      { type: "start", id: 2, question: "q" },
      ev(2, { event: "done", data: { outcome: "ok" } }),
      { type: "fail", id: 2, message: "late" },
    ]);
    expect(finished.messages[0]?.status).toBe("done");
  });

  it("removes a message and resets the conversation", () => {
    const two = run([
      { type: "start", id: 1, question: "a" },
      { type: "start", id: 2, question: "b" },
    ]);
    expect(chatReducer(two, { type: "remove", id: 1 }).messages.map((m) => m.id)).toEqual([2]);
    expect(chatReducer(two, { type: "reset" })).toEqual(INITIAL_CHAT);
  });

  it("ignores events for an unknown message", () => {
    const state = run([{ type: "start", id: 1, question: "q" }]);
    expect(chatReducer(state, ev(9, { event: "delta", data: { text: "x" } })).messages).toEqual(
      state.messages,
    );
  });
});

function msg(id: number, answer: string, status: ChatMessage["status"] = "done"): ChatMessage {
  return { id, question: `question ${id}`, answer, references: [], status, errorMessage: null };
}

describe("historyFor", () => {
  it("sends the last four exchanges that have an answer, oldest first", () => {
    const messages = [1, 2, 3, 4, 5, 6].map((i) => msg(i, `answer ${i}`));
    const history = historyFor(messages);
    expect(history).toHaveLength(MAX_HISTORY);
    expect(history.map((h) => h.question)).toEqual([
      "question 3",
      "question 4",
      "question 5",
      "question 6",
    ]);
  });

  it("skips exchanges without an answer, and keeps a stopped one's partial text", () => {
    const history = historyFor([
      msg(1, ""),
      msg(2, "partial", "stopped"),
      msg(3, "   ", "error"),
      msg(4, "full"),
    ]);
    expect(history).toEqual([
      { question: "question 2", answer: "partial" },
      { question: "question 4", answer: "full" },
    ]);
  });

  it("caps lengths to what the server accepts", () => {
    const [h] = historyFor([
      { ...msg(1, "a".repeat(MAX_HISTORY_ANSWER_CHARS + 500)), question: "q".repeat(3000) },
    ]);
    expect(h?.answer).toHaveLength(MAX_HISTORY_ANSWER_CHARS);
    expect(h?.question).toHaveLength(2000);
  });

  it("is empty for a new conversation", () => {
    expect(historyFor([])).toEqual([]);
  });
});

describe("noticeFor and isActive", () => {
  it("has a notice for each non-plain ending and none for a normal answer", () => {
    expect(noticeFor(msg(1, "x", "done"))).toBeNull();
    expect(noticeFor(msg(1, "x", "cut_off"))).toMatch(/cut short/);
    expect(noticeFor(msg(1, "", "no_results"))).toBe(ASK_NO_RESULTS);
    expect(noticeFor(msg(1, "x", "stopped"))).toMatch(/stopped/);
    expect(noticeFor({ ...msg(1, "", "error"), errorMessage: "Oops." })).toBe("Oops.");
  });

  it("treats only searching and answering as active", () => {
    expect(isActive(msg(1, "", "searching"))).toBe(true);
    expect(isActive(msg(1, "", "answering"))).toBe(true);
    for (const s of ["done", "cut_off", "no_results", "stopped", "error"] as const) {
      expect(isActive(msg(1, "", s))).toBe(false);
    }
  });
});
