// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { firstVisible, keepPlace, type Boxed } from "./read-mode-place";

/** A block whose top edge can move, as it does when the layout changes. */
function block(top: number, height = 40): Boxed & { top: number } {
  const box = {
    top,
    getBoundingClientRect: () => ({ top: box.top, bottom: box.top + height }),
  };
  return box;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("firstVisible", () => {
  it("picks the first block that intersects the viewport, in order", () => {
    const above = block(-200);
    const partly = block(-10);
    const below = block(900);
    expect(firstVisible([above, partly, below], 800)).toBe(partly);
  });

  it("returns null when no block is on screen", () => {
    expect(firstVisible([block(-500), block(2000)], 800)).toBeNull();
  });

  it("returns null for no blocks", () => {
    expect(firstVisible([], 800)).toBeNull();
  });
});

describe("keepPlace", () => {
  function articleWith(...tops: number[]): { article: HTMLElement; paragraphs: Boxed[] } {
    const article = document.createElement("article");
    const paragraphs = tops.map((top) => {
      const el = document.createElement("p");
      const box = block(top);
      Object.defineProperty(el, "getBoundingClientRect", { value: box.getBoundingClientRect });
      article.append(el);
      return { el, box };
    });
    return { article, paragraphs: paragraphs.map((entry) => entry.box) };
  }

  it("scrolls by the amount the anchor moved", () => {
    const scroll = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    const { article, paragraphs } = articleWith(-300, 120, 500);
    const [first, second] = paragraphs as [Boxed & { top: number }, Boxed & { top: number }];
    expect(first).toBeDefined();
    // The anchor is the first visible paragraph (the one at 120). The change moves it to 180.
    keepPlace(article, () => {
      second.top = 180;
    });
    expect(scroll).toHaveBeenCalledWith({ top: 60, behavior: "instant" });
  });

  it("does not scroll when the anchor stays put", () => {
    const scroll = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    const { article } = articleWith(120);
    keepPlace(article, () => undefined);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("leaves the page alone when no anchor is found", () => {
    const scroll = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    const change = vi.fn();
    keepPlace(null, change);
    keepPlace(articleWith(-500).article, change);
    expect(change).toHaveBeenCalledTimes(2);
    expect(scroll).not.toHaveBeenCalled();
  });
});
