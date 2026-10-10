// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LoadErrorState } from "./load-error";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

describe("LoadErrorState", () => {
  it("shows fixed friendly text and a retry link to the home page", () => {
    render(<LoadErrorState />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Repositories could not be loaded" })).toBeTruthy();
    const retry = screen.getByRole("link", { name: "Try again" });
    expect(retry.getAttribute("href")).toBe("/");
  });

  it("carries no connection detail, stack or secret-looking text", () => {
    render(<LoadErrorState />);
    const text = screen.getByTestId("load-error").textContent ?? "";
    expect(text).not.toMatch(/postgres:|ECONNREFUSED|password|at \w+ \(|\.ts:\d+/i);
  });
});
