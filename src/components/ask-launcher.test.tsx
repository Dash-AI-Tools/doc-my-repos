// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { carriedConversation, clearCarriedConversation } from "@/lib/ask/carry";

import { AskLauncher } from "./ask-launcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const PROPS = { providerLabel: "Anthropic", host: null, scope: null, repos: ["acme/api"] };

afterEach(() => {
  cleanup();
  nav.pathname = "/";
  clearCarriedConversation();
});

describe("AskLauncher", () => {
  it("shows only the orb until it is clicked, then a panel with the chat", () => {
    render(<AskLauncher {...PROPS} />);
    expect(screen.queryByTestId("ask-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("ask-orb"));
    const panel = screen.getByTestId("ask-panel");
    expect(panel.hidden).toBe(false);
    expect(screen.getByLabelText("Your question")).toBeTruthy();
  });

  it("closes with the close button and Escape, keeping the panel mounted", () => {
    render(<AskLauncher {...PROPS} />);
    fireEvent.click(screen.getByTestId("ask-orb"));
    fireEvent.click(screen.getByTestId("ask-close"));
    expect(screen.getByTestId("ask-panel").hidden).toBe(true);
    fireEvent.click(screen.getByTestId("ask-orb"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("ask-panel").hidden).toBe(true);
  });

  it("expands to the full page and hands the conversation over", () => {
    render(<AskLauncher {...PROPS} />);
    fireEvent.click(screen.getByTestId("ask-orb"));
    const expand = screen.getByTestId("ask-expand");
    expect(expand.getAttribute("href")).toBe("/ask");
    fireEvent.click(expand);
    expect(carriedConversation()).not.toBeNull();
  });

  it("is not shown on the Ask page itself", () => {
    nav.pathname = "/ask";
    render(<AskLauncher {...PROPS} />);
    expect(screen.queryByTestId("ask-orb")).toBeNull();
  });
});
