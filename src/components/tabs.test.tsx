// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Tabs } from "./tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const tabs = [
  { id: "a", label: "Alpha", panel: <input data-testid="field" /> },
  { id: "b", label: "Beta", panel: <p>beta body</p> },
];

describe("Tabs", () => {
  it("selects the initial tab, falling back to the first for an unknown id", () => {
    const { unmount } = render(<Tabs tabs={tabs} initial="b" label="Sections" />);
    expect(screen.getByRole("tab", { name: "Beta" }).getAttribute("aria-selected")).toBe("true");
    unmount();
    render(<Tabs tabs={tabs} initial="zzz" label="Sections" />);
    expect(screen.getByRole("tab", { name: "Alpha" }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows one panel at a time and keeps edits in a hidden one", () => {
    render(<Tabs tabs={tabs} initial="a" label="Sections" />);
    fireEvent.change(screen.getByTestId("field"), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "Beta" }));
    expect(screen.getByRole("tabpanel", { name: "Beta" })).toBeTruthy();
    expect(screen.getByTestId("field").closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Alpha" }));
    expect((screen.getByTestId("field") as HTMLInputElement).value).toBe("draft");
  });

  it("moves with the arrow keys, Home and End, wrapping around", () => {
    render(<Tabs tabs={tabs} initial="a" label="Sections" />);
    const alpha = screen.getByRole("tab", { name: "Alpha" });
    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Beta" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(document.activeElement).toBe(alpha);
    fireEvent.keyDown(alpha, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Beta" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(alpha.getAttribute("aria-selected")).toBe("true");
  });
});
