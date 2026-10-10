// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  displayMessage,
  MAX_MESSAGE_LENGTH,
  MAX_TEXT_SIZE,
  MermaidDiagram,
  RENDER_TIMEOUT_MS,
  resetMermaidForTests,
} from "./mermaid-diagram";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => {
  return { default: { initialize: mock.initialize, render: mock.render } };
});

const svgFor = (text: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><text>${text}</text></svg>`;

beforeEach(() => {
  mock.initialize.mockReset();
  mock.render.mockReset();
  mock.render.mockImplementation(async (_id: string, source: string) => ({ svg: svgFor(source) }));
  resetMermaidForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("error fallback", () => {
  it("shows the source and an alert when render rejects", async () => {
    mock.render.mockRejectedValue(new Error("Parse error on line 2"));
    render(<MermaidDiagram source={"graph TD\n  A --> -->"} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Parse error on line 2");
    expect(document.querySelector("pre code")?.textContent).toBe("graph TD\n  A --> -->");
    expect(screen.getByRole("group", { name: "Diagram could not be rendered" })).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("uses theme tokens for both light and dark", async () => {
    mock.render.mockRejectedValue(new Error("bad"));
    render(<MermaidDiagram source="x" />);
    await screen.findByRole("alert");
    const box = document.querySelector(".dmr-mermaid-error");
    // Tokens switch with the theme, so no `dark:` variants are needed.
    expect(box?.className).toMatch(/bg-destructive-muted\b/);
    expect(box?.className).toMatch(/text-destructive-muted-foreground/);
    expect(box?.className).not.toMatch(/dark:/);
  });

  it("renders HTML-looking error text as text", async () => {
    mock.render.mockRejectedValue(new Error('<img src=x onerror="alert(1)"><b>x</b>'));
    render(<MermaidDiagram source="x" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe('<img src=x onerror="alert(1)"><b>x</b>');
    expect(alert.querySelector("img, b")).toBeNull();
  });

  it("falls back to a fixed message for an empty or non-error rejection", async () => {
    mock.render.mockRejectedValue(undefined);
    render(<MermaidDiagram source="x" />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The diagram could not be rendered.",
    );
  });

  it("empty source renders a fixed note and never calls mermaid", async () => {
    render(<MermaidDiagram source={"  \n "} />);
    expect(screen.getByText("Empty diagram.")).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mock.render).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a too-long source shows a fixed message without calling mermaid", async () => {
    render(<MermaidDiagram source={"a".repeat(MAX_TEXT_SIZE + 1)} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "The diagram source is too large to render.",
    );
    expect(mock.render).not.toHaveBeenCalled();
  });
});

describe("displayMessage", () => {
  it("strips control, bidi and zero-width characters but keeps line breaks", () => {
    const raw = "a\u0000b\u0007c\u001bd‮e⁦f​g﻿h\r\ni\tj";
    expect(displayMessage(new Error(raw))).toBe("abcdefgh\nij");
  });

  it("removes generated element ids", () => {
    expect(displayMessage(new Error("bad in dmr-mermaid-r1-3 and ddmr-mermaid-r1-3 here"))).toBe(
      "bad in  and  here",
    );
  });

  it("caps length and lines", () => {
    const long = displayMessage(new Error("x".repeat(5000)));
    expect(long.length).toBe(MAX_MESSAGE_LENGTH + 1);
    expect(long.endsWith("…")).toBe(true);
    const lines = displayMessage(
      new Error(Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n")),
    );
    expect(lines.split("\n")).toHaveLength(8);
  });

  it("handles strings and unknown values", () => {
    expect(displayMessage("plain")).toBe("plain");
    expect(displayMessage(42)).toBe("The diagram could not be rendered.");
  });
});

describe("timeout", () => {
  it("shows a fixed message and releases the queue for the next diagram", async () => {
    vi.useFakeTimers();
    mock.render.mockImplementationOnce(() => new Promise(() => undefined));
    render(
      <>
        <MermaidDiagram source="hang" />
        <MermaidDiagram source="next" />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS + 10);
    });
    expect(screen.getByRole("alert").textContent).toBe("The diagram took too long to render.");
    expect(screen.getByRole("img").textContent).toBe("next");
  });

  it("a render that finishes in time is not affected", async () => {
    vi.useFakeTimers();
    render(<MermaidDiagram source="ok" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS + 10);
    });
    expect(screen.getByRole("img").textContent).toBe("ok");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
