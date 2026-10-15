// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { READ_KEY_COOKIE, TEXT_SIZE_COOKIE, parseReadKey } from "@/lib/reading-prefs";

import { ReadModeProvider } from "./read-mode-provider";
import { ReadModeTarget } from "./read-mode-target";
import { TextSizeMenu } from "./text-size-menu";

const renderInProvider = (ui: ReactNode) =>
  render(<ReadModeProvider initialShortcutEnabled>{ui}</ReadModeProvider>);

type SizeLabel = "Small" | "Default" | "Large" | "Larger" | "Largest";

const CONTROL = { name: "Text size and reading options" };

const buttons = () => screen.getAllByRole("button", CONTROL);
const panelOf = (trigger: HTMLElement) =>
  document.getElementById(trigger.getAttribute("aria-controls") ?? "") as HTMLElement;
const LABELS: readonly SizeLabel[] = ["Small", "Default", "Large", "Larger", "Largest"];
const sliderIn = (trigger: HTMLElement) =>
  within(panelOf(trigger)).getByRole("slider", { name: /^Text size/ }) as HTMLInputElement;
const slider = () => screen.getByRole("slider", { name: /^Text size/ }) as HTMLInputElement;
/** Moves the slider to a size, as a drag or arrow key does. */
const choose = (label: SizeLabel, input: HTMLInputElement = slider()) =>
  fireEvent.change(input, { target: { value: String(LABELS.indexOf(label)) } });
const isChecked = (label: SizeLabel) => slider().value === String(LABELS.indexOf(label));
const expanded = (trigger: HTMLElement) => trigger.getAttribute("aria-expanded");
const cookieValue = () =>
  document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${TEXT_SIZE_COOKIE}=`))
    ?.slice(TEXT_SIZE_COOKIE.length + 1);

/** Resets the document between tests: the attribute and the stored cookie. */
function resetDocument(): void {
  document.documentElement.removeAttribute("data-text-size");
  document.cookie = `${TEXT_SIZE_COOKIE}=; Path=/; Max-Age=0`;
  document.cookie = `${READ_KEY_COOKIE}=; Path=/; Max-Age=0`;
}

beforeEach(resetDocument);
afterEach(() => {
  cleanup();
  resetDocument();
});

describe("TextSizeMenu before mount", () => {
  it("renders a same-size placeholder on the server, not the control", () => {
    const html = renderToStaticMarkup(<TextSizeMenu />);
    expect(html).toContain('data-testid="text-size-placeholder"');
    expect(html).not.toContain("Text size and reading options");
  });
});

describe("TextSizeMenu", () => {
  it("opens and closes from the icon button", () => {
    renderInProvider(<TextSizeMenu />);
    const [trigger] = buttons() as HTMLElement[];
    expect(expanded(trigger!)).toBe("false");
    expect(panelOf(trigger!).hidden).toBe(true);

    fireEvent.click(trigger!);
    expect(expanded(trigger!)).toBe("true");
    expect(panelOf(trigger!).hidden).toBe(false);

    fireEvent.click(trigger!);
    expect(expanded(trigger!)).toBe("false");
  });

  it("offers a five-step slider, Default selected", () => {
    renderInProvider(<TextSizeMenu />);
    const [trigger] = buttons() as HTMLElement[];
    fireEvent.click(trigger!);
    expect(slider().min).toBe("0");
    expect(slider().max).toBe("4");
    expect(isChecked("Default")).toBe(true);
    expect(slider().getAttribute("aria-valuetext")).toBe("Default, 100%");
  });

  it("shows one guide dot per stop under the slider", () => {
    renderInProvider(<TextSizeMenu />);
    fireEvent.click(buttons()[0] as HTMLElement);
    const guides = screen.getByTestId("text-size-guides");
    expect(guides.getAttribute("aria-hidden")).toBe("true");
    expect(guides.children).toHaveLength(5);
    expect(guides.children[1]?.className).toContain("bg-primary");
    choose("Largest");
    expect(guides.children[4]?.className).toContain("bg-primary");
    expect(guides.children[1]?.className).not.toContain("bg-primary");
  });

  it("applies each size at once and marks it", async () => {
    renderInProvider(<TextSizeMenu />);
    const [trigger] = buttons() as HTMLElement[];
    fireEvent.click(trigger!);

    for (const [label, size] of [
      ["Small", "small"],
      ["Large", "large"],
      ["Larger", "larger"],
      ["Largest", "largest"],
    ] as const) {
      choose(label);
      expect(document.documentElement.dataset.textSize).toBe(size);
      await waitFor(() => expect(isChecked(label)).toBe(true));
    }
  });

  it("writes the cookie for a size and clears it for Default", () => {
    renderInProvider(<TextSizeMenu />);
    const [trigger] = buttons() as HTMLElement[];
    fireEvent.click(trigger!);

    choose("Large");
    expect(cookieValue()).toBe("large");

    choose("Default");
    expect(document.documentElement.hasAttribute("data-text-size")).toBe(false);
    expect(cookieValue()).toBeUndefined();
  });

  it("closes on Escape and returns focus to the button", () => {
    renderInProvider(<TextSizeMenu />);
    const [trigger] = buttons() as HTMLElement[];
    fireEvent.click(trigger!);
    fireEvent.keyDown(slider(), { key: "Escape" });
    expect(expanded(trigger!)).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a pointer down outside, and keeps the size", () => {
    renderInProvider(
      <>
        <TextSizeMenu />
        <p>elsewhere</p>
      </>,
    );
    const [trigger] = buttons() as HTMLElement[];
    fireEvent.click(trigger!);
    choose("Larger");
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(expanded(trigger!)).toBe("false");
    expect(document.documentElement.dataset.textSize).toBe("larger");
  });

  it("closes when focus moves out of the panel", () => {
    renderInProvider(
      <>
        <TextSizeMenu />
        <button type="button">next</button>
      </>,
    );
    const [trigger] = buttons() as HTMLElement[];
    fireEvent.click(trigger!);
    act(() => {
      slider().focus();
    });
    fireEvent.focusOut(slider(), { relatedTarget: screen.getByText("next") });
    expect(expanded(trigger!)).toBe("false");
  });

  it("does not change the size when the R key checkbox is used", () => {
    renderInProvider(<TextSizeMenu />);
    const [trigger] = buttons() as HTMLElement[];
    fireEvent.click(trigger!);
    choose("Large");
    fireEvent.click(screen.getByRole("checkbox", { name: "Press R for read mode" }));
    expect(document.documentElement.dataset.textSize).toBe("large");
    expect(isChecked("Large")).toBe(true);
  });

  it("keeps two instances in agreement", async () => {
    renderInProvider(
      <>
        <TextSizeMenu />
        <TextSizeMenu />
      </>,
    );
    const [first, second] = buttons() as HTMLElement[];
    fireEvent.click(first!);
    choose("Largest", sliderIn(first!));

    fireEvent.click(second!);
    await waitFor(() => expect(sliderIn(second!).value).toBe("4"));
    expect(document.documentElement.dataset.textSize).toBe("largest");
    expect(sliderIn(first!).value).toBe("4");
  });
});

describe("Theme and read mode in the panel", () => {
  it("holds the theme buttons", () => {
    renderInProvider(<TextSizeMenu />);
    fireEvent.click(buttons()[0] as HTMLElement);
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
  });

  it("has a Read mode button only on a readable page", () => {
    renderInProvider(<TextSizeMenu />);
    fireEvent.click(buttons()[0] as HTMLElement);
    expect(screen.queryByRole("button", { name: "Read mode" })).toBeNull();
    cleanup();
    render(
      <ReadModeProvider initialShortcutEnabled>
        <ReadModeTarget />
        <TextSizeMenu />
      </ReadModeProvider>,
    );
    fireEvent.click(buttons()[0] as HTMLElement);
    expect(screen.getByRole("button", { name: "Read mode" })).not.toBeNull();
  });
});

describe("R key checkbox", () => {
  const readKeyCookie = () =>
    document.cookie
      .split("; ")
      .find((part) => part.startsWith(`${READ_KEY_COOKIE}=`))
      ?.slice(READ_KEY_COOKIE.length + 1);
  const shortcutBox = () =>
    screen.getByRole("checkbox", { name: "Press R for read mode" }) as HTMLInputElement;
  const readModeOn = () => document.documentElement.dataset.readMode === "true";
  const clickReadMode = () => {
    fireEvent.click(buttons()[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Read mode" }));
  };

  function Reader({ shortcut }: { shortcut: boolean }) {
    return (
      <ReadModeProvider initialShortcutEnabled={shortcut}>
        <ReadModeTarget />
        <TextSizeMenu />
      </ReadModeProvider>
    );
  }

  it("is checked by default", () => {
    renderInProvider(<TextSizeMenu />);
    fireEvent.click(buttons()[0] as HTMLElement);
    expect(shortcutBox().checked).toBe(true);
  });

  it("stops R working when unchecked, while the button and Escape still work", () => {
    render(<Reader shortcut />);
    fireEvent.click(buttons()[0] as HTMLElement);
    fireEvent.click(shortcutBox());
    expect(readKeyCookie()).toBe("off");
    fireEvent.click(buttons()[0] as HTMLElement);

    fireEvent.keyDown(window, { key: "r" });
    expect(readModeOn()).toBe(false);

    clickReadMode();
    expect(readModeOn()).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(readModeOn()).toBe(false);
  });

  it("is remembered across a remount, and checking again restores R", () => {
    const first = render(<Reader shortcut />);
    fireEvent.click(buttons()[0] as HTMLElement);
    fireEvent.click(shortcutBox());
    first.unmount();

    // The layout reads the cookie on the server; a fresh mount gets the stored setting.
    render(<Reader shortcut={parseReadKey(readKeyCookie()) === "on"} />);
    fireEvent.click(buttons()[0] as HTMLElement);
    expect(shortcutBox().checked).toBe(false);

    fireEvent.click(shortcutBox());
    expect(readKeyCookie()).toBeUndefined();
    fireEvent.click(buttons()[0] as HTMLElement);
    fireEvent.keyDown(window, { key: "r" });
    expect(readModeOn()).toBe(true);
  });
});
