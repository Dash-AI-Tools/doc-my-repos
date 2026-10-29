// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoAccessRow } from "./repo-access-row";
import { StarredRepoList } from "./starred-repo-list";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: number, name: string): RepoAccessRow => ({
  id,
  owner: "acme",
  name,
  visibility: "public",
  isAllowed: true,
  isPublic: false,
  starPosition: id,
  isStarred: true,
  folderId: null,
  syncStatus: "ok",
});
const repos = [row(1, "handbook"), row(2, "guide"), row(3, "charter")];

// jsdom has no layout, so every box is empty and keyboard dragging has nowhere to go. Give each
// list item a 50px slot in document order, which is all the sortable keyboard coordinates need.
const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  Element.prototype.getBoundingClientRect = function rect(this: Element) {
    const items = Array.from(document.querySelectorAll("li"));
    const index = items.findIndex((li) => li === this || li.contains(this));
    const top = Math.max(index, 0) * 50;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 300,
      bottom: top + 50,
      width: 300,
      height: 50,
      toJSON() {},
    };
  };
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", NoopObserver);
});
afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = realRect;
  vi.unstubAllGlobals();
});

function setup(over: { reordering?: boolean } = {}) {
  const props = {
    repos,
    busyId: null,
    reordering: false,
    onReorder: vi.fn(),
    onToggleStar: vi.fn(),
    onToggleAllowed: vi.fn(),
    ...over,
  };
  render(<StarredRepoList {...props} />);
  return props;
}

const handle = (name: string) => screen.getByRole("button", { name: `Reorder acme/${name}` });
const order = (props: { onReorder: ReturnType<typeof vi.fn> }): string[] =>
  (props.onReorder.mock.calls[0]?.[0] as RepoAccessRow[]).map((r) => r.name);
/**
 * Every message dnd-kit puts in its live region, in order (the region only ever shows the latest,
 * and a later announcement can replace one before the test looks).
 */
function recordAnnouncements(): string[] {
  const seen: string[] = [];
  const region = document.querySelector('[role="status"][aria-live="assertive"]');
  if (!region) throw new Error("no live region");
  new MutationObserver(() => {
    const text = region.textContent ?? "";
    if (text && seen.at(-1) !== text) seen.push(text);
  }).observe(region, { childList: true, characterData: true, subtree: true });
  return seen;
}

/** dnd-kit measures the droppable boxes on a timer after a pick-up, so give it real time. */
async function key(target: Element, code: string) {
  await act(async () => {
    fireEvent.keyDown(target, { code, key: code === "Space" ? " " : code });
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

describe("StarredRepoList", () => {
  it("lists the rows in order with a handle named after each repository", () => {
    setup();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items.map((li) => li.querySelector("span.font-medium")?.textContent)).toEqual([
      "acme/handbook",
      "acme/guide",
      "acme/charter",
    ]);
    for (const name of ["handbook", "guide", "charter"]) {
      expect(handle(name).tagName).toBe("BUTTON");
      expect(handle(name).className).toContain("touch-none");
    }
  });

  describe("by keyboard", () => {
    it("picks a row up, moves it down and drops it, sending the new order once", async () => {
      const props = setup();
      const h = handle("handbook");
      h.focus();
      await key(h, "Space");
      await key(h, "ArrowDown");
      await key(h, "Space");
      expect(props.onReorder).toHaveBeenCalledTimes(1);
      expect(order(props)).toEqual(["guide", "handbook", "charter"]);
    });

    it("sends nothing when the row is dropped where it started", async () => {
      const props = setup();
      const h = handle("guide");
      h.focus();
      await key(h, "Space");
      await key(h, "Space");
      expect(props.onReorder).not.toHaveBeenCalled();
    });

    it("sends nothing when the drag is cancelled with Escape", async () => {
      const props = setup();
      const h = handle("handbook");
      h.focus();
      await key(h, "Space");
      await key(h, "ArrowDown");
      await key(h, "Escape");
      expect(props.onReorder).not.toHaveBeenCalled();
    });

    it("announces the pick-up, each move and the drop with the repository and its place", async () => {
      setup();
      const heard = recordAnnouncements();
      const live = () =>
        document.querySelector('[role="status"][aria-live="assertive"]')?.textContent;
      const h = handle("handbook");
      h.focus();
      // Straight after the pick-up, before dnd-kit's first measurement replaces the message.
      await act(async () => {
        fireEvent.keyDown(h, { code: "Space", key: " " });
      });
      expect(live()).toBe("Picked up acme/handbook, position 1 of 3.");
      await key(h, "ArrowDown");
      expect(heard).toContain("acme/handbook moved to position 2 of 3.");
      await key(h, "Space");
      expect(heard.at(-1)).toBe("Dropped acme/handbook at position 2 of 3.");
    });

    it("announces a cancel", async () => {
      setup();
      const heard = recordAnnouncements();
      const h = handle("guide");
      h.focus();
      await key(h, "Space");
      await key(h, "Escape");
      expect(heard.at(-1)).toBe("Cancelled. acme/guide stays at position 2 of 3.");
    });
  });

  describe("Up and Down", () => {
    it("moves a row one place and shares the reorder callback with dragging", () => {
      const props = setup();
      fireEvent.click(screen.getByRole("button", { name: "Move up acme/guide" }));
      expect(order(props)).toEqual(["guide", "handbook", "charter"]);
      props.onReorder.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Move down acme/guide" }));
      expect(order(props)).toEqual(["handbook", "charter", "guide"]);
    });

    it("leaves out Up on the first row and Down on the last", () => {
      setup();
      const [first, , last] = screen.getAllByRole("listitem") as [
        HTMLElement,
        HTMLElement,
        HTMLElement,
      ];
      expect(within(first).queryByRole("button", { name: /^Move up/ })).toBeNull();
      expect(within(first).getByRole("button", { name: /^Move down/ })).toBeTruthy();
      expect(within(last).queryByRole("button", { name: /^Move down/ })).toBeNull();
      expect(within(last).getByRole("button", { name: /^Move up/ })).toBeTruthy();
    });

    it("is disabled together with dragging while a reorder is saving", () => {
      setup({ reordering: true });
      expect(
        (screen.getByRole("button", { name: "Move up acme/guide" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect((handle("guide") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("controls that must not start a drag", () => {
    it("clicking Star or Allow/Block calls its own handler and reorders nothing", async () => {
      const props = setup();
      const heard = recordAnnouncements();
      const star = screen.getByRole("button", { name: "Star acme/guide" });
      fireEvent.pointerDown(star, { button: 0, isPrimary: true, pointerId: 1 });
      fireEvent.pointerMove(document, { clientY: 120, isPrimary: true, pointerId: 1 });
      fireEvent.pointerUp(document, { isPrimary: true, pointerId: 1 });
      fireEvent.click(star);
      fireEvent.click(screen.getByRole("button", { name: "Block acme/guide" }));
      await key(star, "Space");
      expect(props.onToggleStar).toHaveBeenCalledWith(repos[1]);
      expect(props.onToggleAllowed).toHaveBeenCalledWith(repos[1]);
      expect(props.onReorder).not.toHaveBeenCalled();
      expect(heard).toEqual([]);
    });

    it("only the handle carries the drag listeners", () => {
      setup();
      expect(handle("guide").getAttribute("aria-roledescription")).toBe("sortable");
      expect(
        screen
          .getByRole("button", { name: "Star acme/guide" })
          .getAttribute("aria-roledescription"),
      ).toBeNull();
      expect(
        screen
          .getByRole("button", { name: "Move up acme/guide" })
          .getAttribute("aria-roledescription"),
      ).toBeNull();
    });
  });
});
