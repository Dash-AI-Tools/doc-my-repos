// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MermaidDiagram } from "./mermaid-diagram";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Own file: the module factory runs on the first import only, and that import must fail.
const mock = vi.hoisted(() => ({ runs: 0 }));

vi.mock("mermaid", () => {
  mock.runs++;
  if (mock.runs === 1) throw new Error("chunk load failed https://secret.example/chunk.js");
  return {
    default: {
      initialize: () => undefined,
      render: async () => ({ svg: "<svg><text>ok</text></svg>" }),
    },
  };
});

afterEach(cleanup);

describe("library load failure", () => {
  it("shows a fixed message (no raw error) and retries on the next change", async () => {
    const { rerender } = render(<MermaidDiagram source="a" theme="light" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Diagram library failed to load.");
    expect(document.body.textContent).not.toContain("secret.example");
    expect(document.querySelector("pre code")?.textContent).toBe("a");
    rerender(<MermaidDiagram source="a" theme="dark" />);
    await waitFor(() => expect(screen.getByRole("img").textContent).toBe("ok"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
