// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { ReadModeTarget, useReadModeAvailable } from "./read-mode-target";

function Probe() {
  return <output data-testid="available">{String(useReadModeAvailable())}</output>;
}

const available = () => document.querySelector('[data-testid="available"]')?.textContent;

afterEach(cleanup);

describe("ReadModeTarget", () => {
  it("renders nothing on the server, and the store reads unavailable there", () => {
    expect(renderToStaticMarkup(<ReadModeTarget />)).toBe("");
    expect(renderToStaticMarkup(<Probe />)).toContain(">false<");
  });

  it("registers on mount and unregisters on unmount", () => {
    const page = render(
      <>
        <Probe />
        <ReadModeTarget />
      </>,
    );
    expect(available()).toBe("true");

    page.unmount();
    expect(available()).toBeUndefined();
    // The store is empty again: a fresh probe with no target reads false.
    render(<Probe />);
    expect(available()).toBe("false");
  });

  it("stays available until the last of two targets is gone", () => {
    const first = render(<ReadModeTarget />);
    const second = render(<ReadModeTarget />);
    render(<Probe />);
    expect(available()).toBe("true");

    first.unmount();
    expect(available()).toBe("true");

    second.unmount();
    cleanup();
    render(<Probe />);
    expect(available()).toBe("false");
  });
});
