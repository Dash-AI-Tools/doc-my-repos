// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodeCopyEnhancer } from "./code-copy";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HTML =
  '<p>hi</p><pre class="shiki shiki-themes" tabindex="0"><code class="language-ts"><span class="line"><span style="--shiki-light:#fff">const</span> a = 1;</span>\n<span class="line">b();</span></code></pre>' +
  "<pre><code>plain &lt;b&gt;</code></pre>" +
  '<pre class="dmr-mermaid"><code class="language-mermaid">graph TD</code></pre>';

function Doc({ html = HTML }: { html?: string }) {
  return (
    <CodeCopyEnhancer>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </CodeCopyEnhancer>
  );
}

function setClipboard(writeText: ((t: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText === undefined ? undefined : { writeText },
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document as { execCommand?: unknown }).execCommand;
});

describe("CodeCopyEnhancer", () => {
  it("adds one accessible button per code block, none for mermaid", () => {
    const { container } = render(<Doc />);
    const buttons = screen.getAllByRole("button", { name: "Copy code" });
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b.getAttribute("type")).toBe("button");
    expect(container.querySelector("pre.dmr-mermaid .dmr-copy-host")).toBeNull();
    expect(container.querySelectorAll("pre > .dmr-copy-host")).toHaveLength(2);
  });

  it("does not change the server HTML of the code", () => {
    const { container } = render(<Doc />);
    expect(container.querySelector("pre.shiki > code")?.outerHTML).toBe(
      '<code class="language-ts"><span class="line"><span style="--shiki-light:#fff">const</span> a = 1;</span>\n<span class="line">b();</span></code>',
    );
  });

  it("copies the exact code text with the clipboard API", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard(writeText);
    render(<Doc />);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy code" })[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const a = 1;\nb();"));
    await waitFor(() =>
      expect(screen.getAllByRole("status")[0]!.textContent).toBe("Copied to clipboard"),
    );
    expect(screen.getAllByRole("button")[0]!.textContent).toBe("Copied");
    fireEvent.click(screen.getAllByRole("button", { name: "Copy code" })[1]!);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("plain <b>"));
  });

  it("returns to idle after the Copied state", async () => {
    setClipboard(async () => {});
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Doc />);
    const button = screen.getAllByRole("button", { name: "Copy code" })[0]!;
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe("Copied"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(button.textContent).toBe("Copy");
    expect(button);
  });

  it("falls back to a hidden textarea and execCommand without the clipboard API", async () => {
    setClipboard(undefined);
    let copied = "";
    const exec = vi.fn(() => {
      copied = document.querySelector("textarea")?.value ?? "";
      return true;
    });
    (document as { execCommand?: unknown }).execCommand = exec;
    render(<Doc />);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy code" })[0]!);
    await waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
    expect(copied).toBe("const a = 1;\nb();");
    await waitFor(() => expect(screen.getAllByRole("button")[0]!.textContent).toBe("Copied"));
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when writeText rejects, and reports failure when both fail", async () => {
    setClipboard(async () => {
      throw new Error("denied");
    });
    (document as { execCommand?: unknown }).execCommand = vi.fn(() => false);
    render(<Doc />);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy code" })[0]!);
    await waitFor(() => expect(screen.getAllByRole("button")[0]!.textContent).toBe("Copy failed"));
    expect(screen.getAllByRole("status")[0]!.textContent).toBe("Copy failed");
  });

  it("is a real button: focusable and activated by the keyboard", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard(writeText);
    render(<Doc />);
    const button = screen.getAllByRole("button", { name: "Copy code" })[0]!;
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.tabIndex).toBe(0);
    // Browsers turn Enter/Space on a button into a click; jsdom does not, so assert the
    // element type and that a click handler is what runs.
    expect(button.tagName).toBe("BUTTON");
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  });

  it("does not duplicate buttons on re-render or with a new document", () => {
    const { container, rerender } = render(<Doc />);
    rerender(<Doc />);
    rerender(<Doc />);
    expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(2);
    expect(container.querySelectorAll(".dmr-copy-host")).toHaveLength(2);
    rerender(<Doc html="<pre><code>only</code></pre>" />);
    expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(1);
    expect(container.querySelectorAll(".dmr-copy-host")).toHaveLength(1);
  });

  it("renders a document with no code blocks unchanged", () => {
    const { container } = render(<Doc html="<p>none</p>" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.innerHTML).toBe("<div><div><p>none</p></div></div>");
  });
});
