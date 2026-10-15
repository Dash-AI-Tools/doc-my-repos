// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReadModeProvider } from "./read-mode-provider";
import { ReadModeTarget } from "./read-mode-target";
import { ReadingControls } from "./reading-controls";

function Page() {
  return (
    <ReadModeProvider initialShortcutEnabled>
      <ReadModeTarget />
      <ReadingControls />
    </ReadModeProvider>
  );
}

const group = () => screen.queryByRole("complementary", { name: "Reading controls" });

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.readMode;
});

describe("ReadingControls", () => {
  it("is not shown until read mode is on", () => {
    render(<Page />);
    expect(group()).toBeNull();
  });

  it("is shown with an exit button and the text size menu in read mode", () => {
    render(<Page />);
    fireEvent.keyDown(window, { key: "r" });
    expect(group()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Exit read mode" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Text size and reading options" })).not.toBeNull();
  });

  it("turns read mode off from the exit button", () => {
    render(<Page />);
    fireEvent.keyDown(window, { key: "r" });
    fireEvent.click(screen.getByRole("button", { name: "Exit read mode" }));
    expect(group()).toBeNull();
    expect(document.documentElement.dataset.readMode).toBeUndefined();
  });
});
