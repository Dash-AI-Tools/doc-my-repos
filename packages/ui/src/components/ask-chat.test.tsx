// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  encodeEvent,
  type AskEvent,
  type AskReference,
} from "@docmyrepos/core/internal/ask/events";
import { ASK_ERROR_MESSAGES } from "@docmyrepos/core/internal/ask/messages";

import { AskChat, type AskChatProps } from "./ask-chat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<typeof fetch>();

const PROPS: AskChatProps = {
  providerLabel: "Anthropic",
  host: null,
  scope: null,
  repos: ["acme/api", "acme/handbook"],
  initialQuestion: "",
};

const REF1: AskReference = {
  n: 1,
  title: "Signing keys",
  repo: "acme/api",
  path: "docs/keys.md",
  heading: "Rotate the signing key",
  href: "/acme/api/docs/keys#rotate-the-signing-key",
};
const REF2: AskReference = {
  n: 2,
  title: "Deploying",
  repo: "acme/api",
  path: "docs/deploy.md",
  heading: null,
  href: "/acme/api/docs/deploy",
};

/** A complete answer as events. */
function answer(text: string, refs: AskReference[] = [REF1, REF2]): AskEvent[] {
  return [
    { event: "status", data: { state: "searching" } },
    { event: "references", data: { references: refs } },
    { event: "status", data: { state: "answering" } },
    { event: "delta", data: { text } },
    { event: "done", data: { outcome: "ok" } },
  ];
}

function sseResponse(events: AskEvent[]): Response {
  return new Response(events.map(encodeEvent).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A stream the test feeds by hand; aborting the request errors it, like a real fetch. */
function openStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    send: (event: AskEvent) => controller.enqueue(encoder.encode(encodeEvent(event))),
    close: () => controller.close(),
    fail: () => controller.error(new DOMException("aborted", "AbortError")),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const field = () => screen.getByLabelText("Your question") as HTMLTextAreaElement;
const live = () => screen.getByTestId("ask-live");
const askButton = () => screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement;

function ask(text: string) {
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.click(askButton());
}

const bodyOf = (call = 0) => JSON.parse(String(fetchMock.mock.calls[call]![1]?.body));

describe("AskChat: asking", () => {
  it("shows the provider notice, an empty log and a labelled field", () => {
    render(
      <AskChat {...PROPS} providerLabel="OpenAI-compatible endpoint" host="models.internal" />,
    );
    const notice = screen.getByTestId("ask-notice-provider").textContent ?? "";
    expect(notice).toContain("OpenAI-compatible endpoint");
    expect(notice).toContain("(models.internal)");
    expect(notice).toContain("does not store");
    expect(field()).toBeDefined();
    expect(screen.getByRole("log", { name: "Conversation" }).getAttribute("aria-live")).toBe("off");
    expect(document.querySelector("noscript")).not.toBeNull();
  });

  it("sends the question, shows the answer with its references, and announces it", async () => {
    fetchMock.mockResolvedValue(sseResponse(answer("Run `keys rotate` [1].")));
    render(<AskChat {...PROPS} />);
    ask("  How do I rotate the key?  ");

    expect(await screen.findByTestId("ask-answer")).toBeDefined();
    await waitFor(() => expect(live().textContent).toBe("Answer ready."));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/ask");
    expect(init?.method).toBe("POST");
    expect(bodyOf()).toEqual({ question: "How do I rotate the key?", history: [] });
    expect(field().value).toBe(""); // cleared
    expect(screen.getByTestId("ask-answer").textContent).toContain("keys rotate");
    const links = within(screen.getByTestId("ask-exchange")).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#ask-1-ref-1", // the citation marker
      "/acme/api/docs/keys#rotate-the-signing-key",
      "/acme/api/docs/deploy",
    ]);
    expect(links[1]?.textContent).toBe(
      "Signing keys, section Rotate the signing key (acme/api/docs/keys.md)",
    );
  });

  it("sends with Enter and adds a line with Shift+Enter", () => {
    fetchMock.mockResolvedValue(sseResponse(answer("ok")));
    render(<AskChat {...PROPS} />);
    fireEvent.change(field(), { target: { value: "one" } });
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send an empty question, or a second one while one is being answered", async () => {
    const stream = openStream();
    fetchMock.mockResolvedValue(stream.response);
    render(<AskChat {...PROPS} />);
    expect(askButton().disabled).toBe(true);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();

    ask("first");
    await waitFor(() => expect(askButton().disabled).toBe(true));
    fireEvent.change(field(), { target: { value: "second" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stream.close();
  });

  it("puts a question from search in the field without sending it", () => {
    render(<AskChat {...PROPS} initialQuestion="rotate signing keys" />);
    expect(field().value).toBe("rotate signing keys");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a counter near the limit and caps the field at 2,000 characters", () => {
    render(<AskChat {...PROPS} />);
    expect(screen.queryByTestId("ask-counter")).toBeNull();
    fireEvent.change(field(), { target: { value: "x".repeat(1850) } });
    expect(screen.getByTestId("ask-counter").textContent).toBe("1850 / 2000");
    expect(field().maxLength).toBe(2000);
  });
});

describe("AskChat: streaming and stopping", () => {
  it("shows text as it arrives, with Stop available, then finishes", async () => {
    const stream = openStream();
    fetchMock.mockResolvedValue(stream.response);
    render(<AskChat {...PROPS} />);
    ask("q");

    expect(await screen.findByText("Searching the documentation…")).toBeDefined();
    stream.send({ event: "references", data: { references: [REF1] } });
    stream.send({ event: "delta", data: { text: "First part " } });
    expect(await screen.findByText(/First part/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
    expect(live().textContent).toBe(""); // tokens are not announced
    stream.send({ event: "delta", data: { text: "and the rest." } });
    stream.send({ event: "done", data: { outcome: "ok" } });
    stream.close();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
    expect(screen.getByTestId("ask-answer").textContent).toBe("First part and the rest.");
    expect(live().textContent).toBe("Answer ready.");
  });

  it("keeps the text received when stopped, aborts the request, and allows asking again", async () => {
    const stream = openStream();
    fetchMock.mockImplementation(async (_url, init) => {
      init?.signal?.addEventListener("abort", () => stream.fail());
      return stream.response;
    });
    render(<AskChat {...PROPS} />);
    ask("q");
    stream.send({ event: "delta", data: { text: "Partial answer" } });
    await screen.findByText(/Partial answer/);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("You stopped this answer.")).toBeDefined();
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(screen.getByTestId("ask-answer").textContent).toBe("Partial answer");
    expect(live().textContent).toBe("Stopped.");
    expect(askButton().disabled).toBe(true); // empty field
    fireEvent.change(field(), { target: { value: "again" } });
    expect(askButton().disabled).toBe(false);
  });

  it("treats a stream that ends without done as an interrupted answer", async () => {
    fetchMock.mockResolvedValue(sseResponse([{ event: "delta", data: { text: "cut" } }]));
    render(<AskChat {...PROPS} />);
    ask("q");
    expect((await screen.findByTestId("ask-notice")).textContent).toBe(
      ASK_ERROR_MESSAGES.malformed,
    );
    expect(screen.getByTestId("ask-answer").textContent).toBe("cut");
  });

  it("notes an answer cut at the length limit", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        { event: "delta", data: { text: "long" } },
        { event: "done", data: { outcome: "cut_off" } },
      ]),
    );
    render(<AskChat {...PROPS} />);
    ask("q");
    expect(await screen.findByText(/cut short/)).toBeDefined();
  });
});

describe("AskChat: conversation", () => {
  it("sends the last four exchanges with a follow-up", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const n = JSON.parse(String(init?.body)).question;
      return sseResponse(answer(`answer to ${n}`, []));
    });
    render(<AskChat {...PROPS} />);
    for (const q of ["q1", "q2", "q3", "q4", "q5"]) {
      ask(q);
      await waitFor(() => expect(askButton().disabled).toBe(true)); // field cleared, idle
      await waitFor(() => expect(screen.getAllByTestId("ask-exchange")).toHaveLength(Number(q[1])));
      await waitFor(() => expect(live().textContent).toBe("Answer ready."));
    }
    ask("q6");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    expect(bodyOf(5).history).toEqual([
      { question: "q2", answer: "answer to q2" },
      { question: "q3", answer: "answer to q3" },
      { question: "q4", answer: "answer to q4" },
      { question: "q5", answer: "answer to q5" },
    ]);
  });

  it("clears the conversation with New conversation, so later questions carry no context", async () => {
    fetchMock.mockImplementation(async () => sseResponse(answer("hello", [])));
    render(<AskChat {...PROPS} />);
    ask("first");
    await screen.findByTestId("ask-answer");
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(screen.queryByTestId("ask-exchange")).toBeNull();
    expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
    ask("second");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(1).history).toEqual([]);
  });

  it("stores nothing in the browser", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    fetchMock.mockResolvedValue(sseResponse(answer("x", [])));
    render(<AskChat {...PROPS} />);
    ask("q");
    await screen.findByTestId("ask-answer");
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    setItem.mockRestore();
  });
});

describe("AskChat: failures", () => {
  it("shows each fixed provider failure message and offers to try again", async () => {
    for (const kind of Object.keys(ASK_ERROR_MESSAGES) as (keyof typeof ASK_ERROR_MESSAGES)[]) {
      cleanup();
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(sseResponse([{ event: "error", data: { kind } }]));
      render(<AskChat {...PROPS} />);
      ask("q");
      expect((await screen.findByTestId("ask-notice")).textContent).toBe(ASK_ERROR_MESSAGES[kind]);
      expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
      expect(live().textContent).toBe(ASK_ERROR_MESSAGES[kind]);
    }
  });

  it("retries the same question and replaces the failed attempt", async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([{ event: "error", data: { kind: "unavailable" } }]),
    );
    fetchMock.mockResolvedValueOnce(sseResponse(answer("fixed", [])));
    render(<AskChat {...PROPS} />);
    ask("my question");
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("fixed")).toBeDefined();
    expect(screen.getAllByTestId("ask-exchange")).toHaveLength(1);
    expect(bodyOf(1).question).toBe("my question");
  });

  it("says when a rate-limited user can ask again", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: "rate_limited", retryAfterSeconds: 300, error: "SECRET" }, 429),
    );
    render(<AskChat {...PROPS} />);
    ask("q");
    expect((await screen.findByTestId("ask-notice")).textContent).toBe(
      "You have reached your question limit. You can ask again in 5 minutes.",
    );
    expect(document.body.textContent).not.toContain("SECRET");
  });

  it("explains busy, one-at-a-time, signed-out and unavailable answers", async () => {
    const cases: [number, Record<string, unknown>, RegExp][] = [
      [503, { code: "busy" }, /busy right now/],
      [429, { code: "user_busy" }, /current question/],
      [401, {}, /Sign in again/],
      [404, {}, /not available/],
      [500, {}, /not available right now/],
    ];
    for (const [status, body, text] of cases) {
      cleanup();
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse(body, status));
      render(<AskChat {...PROPS} />);
      ask("q");
      expect((await screen.findByTestId("ask-notice")).textContent).toMatch(text);
    }
  });

  it("shows a fixed message for a network failure, never the error text", async () => {
    fetchMock.mockRejectedValue(new TypeError("connect ECONNREFUSED 10.0.0.1 token=abc"));
    render(<AskChat {...PROPS} />);
    ask("q");
    expect((await screen.findByTestId("ask-notice")).textContent).toBe(
      ASK_ERROR_MESSAGES.unavailable,
    );
    expect(document.body.textContent).not.toMatch(/ECONNREFUSED|token=abc/);
  });

  it("says nothing was found, and links to the search, when no document matched", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        { event: "references", data: { references: [] } },
        { event: "done", data: { outcome: "no_results" } },
      ]),
    );
    render(<AskChat {...PROPS} />);
    ask("zzz qqq");
    expect((await screen.findByTestId("ask-notice")).textContent).toMatch(
      /Nothing relevant was found/,
    );
    const link = screen.getByRole("link", { name: /Search the documentation/ });
    expect(link.getAttribute("href")).toBe("/search?q=zzz%20qqq");
    expect(live().textContent).toMatch(/Nothing relevant/);
  });
});

describe("AskChat: references and citations", () => {
  it("links each citation marker to its own reference, and removes invalid markers", async () => {
    fetchMock.mockResolvedValue(sseResponse(answer("See [2] first, then [1]; ignore [9].")));
    render(<AskChat {...PROPS} />);
    ask("q");
    const answerEl = await screen.findByTestId("ask-answer");
    const cites = within(answerEl).getAllByRole("link");
    expect(cites.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["[2]", "#ask-1-ref-2"],
      ["[1]", "#ask-1-ref-1"],
    ]);
    expect(answerEl.textContent).not.toContain("[9]");
    for (const cite of cites) {
      const target = document.getElementById(cite.getAttribute("href")!.slice(1));
      expect(target).not.toBeNull();
      expect(target?.textContent).toContain(
        cite.textContent === "[1]" ? "Signing keys" : "Deploying",
      );
    }
  });

  it("keeps each message's citations pointing at that message's own references", async () => {
    fetchMock.mockImplementation(async () => sseResponse(answer("See [1].", [REF1])));
    render(<AskChat {...PROPS} />);
    ask("one");
    await screen.findByTestId("ask-answer");
    ask("two");
    await waitFor(() => expect(screen.getAllByTestId("ask-answer")).toHaveLength(2));
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("#ask-1-ref-1");
    expect(hrefs).toContain("#ask-2-ref-1");
  });

  it("links only same-site paths, whatever the server sent", async () => {
    const hostile: AskReference[] = [
      { ...REF1, n: 1, href: "https://evil.example/x" },
      { ...REF2, n: 2, href: "//evil.example/x" },
      { ...REF2, n: 3, title: "No link", href: null },
    ];
    fetchMock.mockResolvedValue(sseResponse(answer("x", hostile)));
    render(<AskChat {...PROPS} />);
    ask("q");
    await screen.findByTestId("ask-answer");
    const hrefs = screen.queryAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.includes("evil.example"))).toBe(false);
    expect(screen.getByText(/No link/)).toBeDefined();
  });
});

describe("AskChat: scope", () => {
  it("shows the scope from the page, sends it, and can clear it", async () => {
    fetchMock.mockImplementation(async () => sseResponse(answer("ok", [])));
    render(<AskChat {...PROPS} scope="acme/api" />);
    expect(screen.getByTestId("ask-scope").textContent).toContain("Searching in acme/api");
    ask("q");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf(0).repo).toBe("acme/api");

    await waitFor(() => expect(live().textContent).toBe("Answer ready."));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByTestId("ask-scope").textContent).toContain("all repositories");
    ask("q2");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect("repo" in bodyOf(1)).toBe(false);
  });

  it("changes the scope from a list of the repositories the reader can see", async () => {
    fetchMock.mockImplementation(async () => sseResponse(answer("ok", [])));
    render(<AskChat {...PROPS} scope="acme/api" />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const select = screen.getByLabelText("Repository to search in") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "acme/api", "acme/handbook"]);
    fireEvent.change(select, { target: { value: "acme/handbook" } });
    expect(screen.getByTestId("ask-scope").textContent).toContain("Searching in acme/handbook");
    ask("q");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf(0).repo).toBe("acme/handbook");
  });

  it("starts unscoped when the page found no valid scope, and can pick one", () => {
    render(<AskChat {...PROPS} scope={null} />);
    expect(screen.getByTestId("ask-scope").textContent).toContain("all repositories");
    fireEvent.click(screen.getByRole("button", { name: "Limit to a repository" }));
    expect(screen.getByLabelText("Repository to search in")).toBeDefined();
  });

  it("offers no scope picker when there are no repositories", () => {
    render(<AskChat {...PROPS} repos={[]} />);
    expect(screen.queryByRole("button", { name: "Limit to a repository" })).toBeNull();
  });
});

describe("AskChat: safe rendering of hostile answers", () => {
  const HOSTILE = [
    "Intro ![leak](https://evil.example/leak?q=1) and [click](https://evil.example/steal) ",
    '<script>window.__pwned = 1</script> <img src=x onerror="window.__pwned = 2"> ',
    "[x](javascript:window.__pwned=3) <https://evil.example/auto> https://evil.example/bare ",
    "**bold** `code` [1].\n\n- item\n\n```js\nconst a = '<img src=y>';\n```",
  ].join("");

  it("creates no image, script, event handler or foreign link", async () => {
    fetchMock.mockResolvedValue(sseResponse(answer(HOSTILE, [REF1])));
    const { container } = render(<AskChat {...PROPS} />);
    ask("q");
    await screen.findByTestId("ask-answer");
    const root = screen.getByTestId("ask-answer");

    expect(
      container.querySelector("img, script, iframe, object, embed, svg, form input"),
    ).toBeNull();
    expect(root.querySelector("img, script")).toBeNull();
    for (const el of container.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) expect(attr.startsWith("on")).toBe(false);
    }
    // The only links in the answer are citation markers pointing inside the page.
    const hrefs = [...root.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["#ask-1-ref-1"]);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // The hostile text is still readable as text.
    expect(root.textContent).toContain("<script>window.__pwned = 1</script>");
    expect(root.textContent).toContain("bold");
    expect(root.querySelector("li")?.textContent).toBe("item");
    expect(root.querySelector("pre code")?.textContent).toContain("<img src=y>");
    expect(root.querySelector("strong")?.textContent).toBe("bold");
  });
});

describe("AskChat: code blocks", () => {
  it("copies a code block with a labelled control and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    fetchMock.mockResolvedValue(sseResponse(answer("```sh\nnpm run build\n```", [])));
    render(<AskChat {...PROPS} />);
    ask("q");
    fireEvent.click(await screen.findByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("npm run build"));
    expect(await screen.findByText("Code copied")).toBeDefined();
    expect(screen.getByText("sh")).toBeDefined();
  });

  it("makes a wide code block focusable so it can be scrolled by keyboard", async () => {
    fetchMock.mockResolvedValue(sseResponse(answer("```\n" + "x".repeat(500) + "\n```", [])));
    const { container } = render(<AskChat {...PROPS} />);
    ask("q");
    await screen.findByTestId("ask-answer");
    expect(container.querySelector("pre")?.getAttribute("tabindex")).toBe("0");
  });
});

describe("AskChat: keyboard", () => {
  it("uses native controls in order: scope, field, Ask, then New conversation", async () => {
    fetchMock.mockResolvedValue(sseResponse(answer("ok", [])));
    const { container } = render(<AskChat {...PROPS} scope="acme/api" />);
    ask("q");
    await screen.findByTestId("ask-answer");
    const order = [...container.querySelectorAll("button, textarea, select, a[href]")].map((el) =>
      el.tagName === "TEXTAREA" ? "TEXTAREA" : (el.textContent?.trim() ?? el.tagName),
    );
    expect(order).toEqual(["Change", "Clear", "TEXTAREA", "Ask", "New conversation"]);
    expect(container.querySelector("[tabindex]:not(pre)")).toBeNull();
  });
});
