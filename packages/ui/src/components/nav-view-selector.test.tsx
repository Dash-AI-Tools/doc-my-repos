// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const submitted: string[] = [];
let release: () => void = () => {};
vi.mock("@docmyrepos/server/internal/nav-view-action", () => ({
  setNavView: (data: FormData) => {
    submitted.push(String(data.get("view")));
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  },
}));

const { NavViewSelector } = await import("./nav-view-selector");

afterEach(() => {
  cleanup();
  submitted.length = 0;
});

describe("NavViewSelector", () => {
  it("is a named group of two submit buttons, OKF then Tree, inside one form", () => {
    render(<NavViewSelector view="okf" />);
    const group = screen.getByRole("group", { name: "Navigation view" });
    const buttons = Array.from(group.querySelectorAll("button"));
    expect(buttons.map((b) => [b.textContent, b.type, b.name, b.value])).toEqual([
      ["OKF", "submit", "view", "okf"],
      ["Tree", "submit", "view", "tree"],
    ]);
    expect(group.closest("form")).toBe(screen.getByTestId("nav-view-selector"));
    // Each button has one icon, hidden from assistive technology, so its name stays the label.
    for (const b of buttons) {
      const icons = b.querySelectorAll("svg");
      expect(icons).toHaveLength(1);
      expect(icons[0]?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(screen.getByRole("button", { name: "OKF" })).toBe(buttons[0]);
    expect(screen.getByRole("button", { name: "Tree" })).toBe(buttons[1]);
    expect(screen.getByTestId("nav-view-selector").children).toHaveLength(1);
  });

  it.each([
    ["okf", "OKF", "Tree"],
    ["tree", "Tree", "OKF"],
  ] as const)("marks the %s view as pressed", (view, pressed, other) => {
    render(<NavViewSelector view={view} />);
    expect(screen.getByRole("button", { name: pressed }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: other }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: pressed }).className).toContain("inset_0_-2px");
    expect(screen.getByRole("button", { name: other }).className).not.toContain("inset_0_-2px");
  });

  it("submits the chosen view and marks that button busy until the action ends", async () => {
    render(<NavViewSelector view="okf" />);
    const tree = screen.getByRole("button", { name: "Tree" });
    await act(async () => {
      fireEvent.click(tree);
    });
    expect(submitted).toEqual(["tree"]);
    expect(tree.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "OKF" }).hasAttribute("aria-busy")).toBe(false);
    await act(async () => {
      release();
    });
    expect(tree.hasAttribute("aria-busy")).toBe(false);
  });
});
