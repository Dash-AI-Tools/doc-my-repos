// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ResponsiveDetails } from "./responsive-details";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

type Listener = () => void;

/** A controllable `matchMedia` for the `lg` query. */
function mockViewport(matches: boolean) {
  const listeners = new Set<Listener>();
  const query = {
    matches,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  };
  (window as unknown as { matchMedia: () => typeof query }).matchMedia = () => query;
  return {
    resize(to: boolean) {
      query.matches = to;
      for (const l of listeners) l();
    },
  };
}

function el(): HTMLDetailsElement {
  return screen.getByTestId("d") as HTMLDetailsElement;
}

function show() {
  return render(
    <ResponsiveDetails summary={<span>Label</span>} testId="d">
      <p>content</p>
    </ResponsiveDetails>,
  );
}

describe("ResponsiveDetails", () => {
  it("is open on the server, so it works without JavaScript", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(
      <ResponsiveDetails summary="Label">
        <p>content</p>
      </ResponsiveDetails>,
    );
    expect(html).toContain("<details open");
    expect(html).toContain("content");
  });

  it("stays open on a large screen", async () => {
    mockViewport(true);
    await act(async () => {
      show();
    });
    expect(el().open).toBe(true);
  });

  it("closes on a small screen and follows a resize", async () => {
    const viewport = mockViewport(false);
    await act(async () => {
      show();
    });
    expect(el().open).toBe(false);
    await act(async () => viewport.resize(true));
    expect(el().open).toBe(true);
    await act(async () => viewport.resize(false));
    expect(el().open).toBe(false);
  });

  it("has a summary with the label", async () => {
    mockViewport(true);
    await act(async () => {
      show();
    });
    expect(el().querySelector("summary")?.textContent).toBe("Label");
  });

  it("does nothing when matchMedia is missing", async () => {
    await act(async () => {
      show();
    });
    expect(el().open).toBe(true);
  });
});
