// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorPage as ErrorBoundary } from "./error";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

describe("error boundary", () => {
  it("never shows the error message or stack, only a digest reference", () => {
    const error = Object.assign(new Error("connect failed to postgres://u:secret@10.0.0.5/db"), {
      digest: "abc123",
    });
    render(<ErrorBoundary error={error} reset={() => undefined} />);
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    const text = screen.getByTestId("error-boundary").textContent ?? "";
    expect(text).not.toMatch(/secret|10\.0\.0\.5|postgres:/);
    expect(text).toContain("abc123");
  });

  it("omits the reference when there is no digest", () => {
    render(<ErrorBoundary error={new Error("x")} reset={() => undefined} />);
    expect(screen.getByTestId("error-boundary").textContent).not.toContain("Reference");
  });

  it("retries through reset and offers a way home", () => {
    const reset = vi.fn();
    render(<ErrorBoundary error={new Error("x")} reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Back to the home page" }).getAttribute("href")).toBe(
      "/",
    );
  });
});
