// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MermaidDiagram } from "./mermaid-diagram";
import { MermaidEnhancer } from "./mermaid-enhancer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The factory runs when `mermaid` is first imported, and the module is cached after that, so
// this file keeps the order: no-diagram test first, then the test that mounts one.
const mock = vi.hoisted(() => ({ factoryRuns: 0 }));

vi.mock("mermaid", () => {
  mock.factoryRuns++;
  return {
    default: {
      initialize: () => undefined,
      render: async () => ({ svg: "<svg></svg>" }),
    },
  };
});

afterEach(cleanup);

describe("lazy loading", () => {
  it("does not import mermaid when the components load or a document has no diagram", async () => {
    expect(mock.factoryRuns).toBe(0);
    render(
      <MermaidEnhancer>
        <div
          dangerouslySetInnerHTML={{ __html: '<pre><code class="language-ts">x</code></pre>' }}
        />
      </MermaidEnhancer>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(mock.factoryRuns).toBe(0);
  });

  it("imports mermaid once a diagram mounts", async () => {
    expect(mock.factoryRuns).toBe(0);
    render(<MermaidDiagram source="graph TD" />);
    await screen.findByRole("img");
    expect(mock.factoryRuns).toBe(1);
  });
});
