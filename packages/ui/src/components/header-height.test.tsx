// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HeaderHeight } from "./header-height";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let resize: (() => void) | null = null;

class FakeResizeObserver {
  constructor(callback: () => void) {
    resize = callback;
  }
  observe() {}
  disconnect() {
    resize = null;
  }
}

let height = 64;

beforeEach(() => {
  height = 64;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => height,
  });
});

afterEach(() => {
  cleanup();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
  document.documentElement.style.removeProperty("--site-header-h");
});

const value = () => document.documentElement.style.getPropertyValue("--site-header-h");

describe("HeaderHeight", () => {
  it("publishes the height of its header and follows it when it resizes", () => {
    render(
      <header>
        <HeaderHeight />
      </header>,
    );
    expect(value()).toBe("64px");
    height = 104;
    act(() => resize?.());
    expect(value()).toBe("104px");
  });

  it("removes the property when the header goes away, so the stylesheet fallback applies", () => {
    const { unmount } = render(
      <header>
        <HeaderHeight />
      </header>,
    );
    expect(value()).toBe("64px");
    unmount();
    expect(value()).toBe("");
  });

  it("still publishes once where ResizeObserver does not exist", () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    render(
      <header>
        <HeaderHeight />
      </header>,
    );
    expect(value()).toBe("64px");
  });
});
