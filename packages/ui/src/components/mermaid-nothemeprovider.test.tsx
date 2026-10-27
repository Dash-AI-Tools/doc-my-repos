// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MermaidDiagram, resetMermaidForTests } from "./mermaid-diagram";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mock = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
// Real next-themes on purpose: no ThemeProvider is mounted.
vi.mock("mermaid", () => ({ default: { initialize: mock.initialize, render: mock.render } }));

afterEach(() => {
  cleanup();
  resetMermaidForTests();
});

describe("without a ThemeProvider", () => {
  it("does not throw and falls back to the light theme", async () => {
    mock.render.mockResolvedValue({ svg: "<svg></svg>" });
    render(<MermaidDiagram source="a" />);
    await screen.findByRole("img");
    expect(mock.initialize.mock.calls[0]?.[0]).toMatchObject({
      theme: "base",
      themeVariables: { darkMode: false },
      securityLevel: "strict",
    });
  });
});
