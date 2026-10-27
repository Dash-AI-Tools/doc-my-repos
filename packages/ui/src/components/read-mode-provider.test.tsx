// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReadModeProvider, useReadMode } from "./read-mode-provider";
import { closePalette, openPalette, resetPaletteForTests } from "./palette-store";
import { ReadModeTarget } from "./read-mode-target";

function Controls() {
  const { on, shortcutEnabled, toggle, setShortcutEnabled } = useReadMode();
  return (
    <>
      <button type="button" data-read-toggle onClick={toggle}>
        Read mode
      </button>
      <button type="button" onClick={() => setShortcutEnabled(!shortcutEnabled)}>
        Shortcut
      </button>
      <output data-testid="on">{String(on)}</output>
      <input aria-label="field" />
    </>
  );
}

function Page({ readable = true, shortcut = true }: { readable?: boolean; shortcut?: boolean }) {
  return (
    <ReadModeProvider initialShortcutEnabled={shortcut}>
      {readable ? <ReadModeTarget /> : null}
      <article data-read-article tabIndex={-1}>
        <p>Document text</p>
      </article>
      <Controls />
    </ReadModeProvider>
  );
}

const onState = () => screen.getByTestId("on").textContent === "true";
const html = () => document.documentElement;
const status = () => document.querySelector('[role="status"]')?.textContent ?? "";
const pressR = (overrides: KeyboardEventInit = {}) =>
  fireEvent.keyDown(window, { key: "r", ...overrides });

beforeEach(() => {
  delete html().dataset.readMode;
});

afterEach(() => {
  cleanup();
  resetPaletteForTests();
});

describe("ReadModeProvider toggling", () => {
  it("toggles by the button and sets data-read-mode on <html>", () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Read mode" }));
    expect(onState()).toBe(true);
    expect(html().dataset.readMode).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Read mode" }));
    expect(onState()).toBe(false);
    expect(html().dataset.readMode).toBeUndefined();
  });

  it("toggles by the R key, exactly once per press", () => {
    render(<Page />);
    pressR();
    expect(onState()).toBe(true);
    pressR({ key: "R" });
    expect(onState()).toBe(false);
  });

  it("turns off with Escape", () => {
    render(<Page />);
    pressR();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onState()).toBe(false);
  });

  it("leaves Escape to anything that already handled it", () => {
    render(<Page />);
    pressR();
    const handled = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener("keydown", handled, { once: true, capture: true });
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", handled, { capture: true });
    expect(onState()).toBe(true);
  });
});

describe("ReadModeProvider availability", () => {
  it("turns off when the page is no longer readable", () => {
    const { rerender } = render(<Page />);
    pressR();
    expect(onState()).toBe(true);

    rerender(<Page readable={false} />);
    expect(onState()).toBe(false);
    expect(html().dataset.readMode).toBeUndefined();
  });

  it("stays on between readable pages", () => {
    const { rerender } = render(<Page />);
    pressR();
    rerender(<Page readable />);
    expect(onState()).toBe(true);
  });

  it("does not turn on the R key on a page that is not readable", () => {
    render(<Page readable={false} />);
    pressR();
    expect(onState()).toBe(false);
  });
});

describe("ReadModeProvider keyboard safety", () => {
  it("ignores R while typing in a field", () => {
    render(<Page />);
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "r" });
    expect(onState()).toBe(false);
  });

  it("ignores R with Ctrl or Cmd held, so the browser reload still works", () => {
    render(<Page />);
    pressR({ ctrlKey: true });
    pressR({ metaKey: true });
    expect(onState()).toBe(false);
  });

  it("ignores R while the search palette is open", () => {
    render(<Page />);
    openPalette(null);
    pressR();
    expect(onState()).toBe(false);
    closePalette();
  });

  it("ignores R while an input method is composing", () => {
    render(<Page />);
    pressR({ isComposing: true });
    expect(onState()).toBe(false);
  });

  it("ignores R when the shortcut is turned off, but the button still works", () => {
    render(<Page shortcut={false} />);
    pressR();
    expect(onState()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Read mode" }));
    expect(onState()).toBe(true);
  });
});

describe("ReadModeProvider announcements", () => {
  it("announces the shortcut and Escape when the shortcut is on", () => {
    render(<Page />);
    pressR();
    expect(status()).toBe("Read mode on. Press R or Escape to exit.");
    pressR();
    expect(status()).toBe("Read mode off.");
  });

  it("names only Escape when the shortcut is off", () => {
    render(<Page shortcut={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Read mode" }));
    expect(status()).toBe("Read mode on. Press Escape to exit.");
  });

  it("does not announce on the first render", () => {
    render(<Page />);
    expect(status()).toBe("");
  });

  it("does not re-announce when only the shortcut setting changes", () => {
    render(<Page />);
    pressR();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Shortcut" }));
    });
    expect(status()).toBe("Read mode on. Press R or Escape to exit.");
  });
});

describe("ReadModeProvider focus", () => {
  it("moves focus to the article on entry", () => {
    render(<Page />);
    pressR();
    expect(document.activeElement).toBe(document.querySelector("[data-read-article]"));
  });

  it("returns focus to the toggle on exit", async () => {
    render(<Page />);
    pressR();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector("[data-read-toggle]")),
    );
  });
});
