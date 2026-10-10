// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { renderMarkdown } from "@/server/markdown/pipeline";

import { MermaidDiagram, resetMermaidForTests } from "./mermaid-diagram";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Dogfood check (task 13.5): every Mermaid diagram in the repository's own `docs/` folder is
 * extracted the way the portal does it (through the markdown pipeline, which tags the fences) and
 * drawn with the real Mermaid library, in both themes, exactly like `mermaid-diagram.real.test.tsx`
 * draws its samples. A diagram with a syntax error fails here, not in a reader's browser.
 */

// Vitest runs from the repository root; `import.meta.url` is not a file URL under jsdom.
const DOCS = join(process.cwd(), "docs");

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(path, out);
    else if (/\.md$/i.test(entry.name)) out.push(path);
  }
  return out.sort();
}

beforeAll(() => {
  const proto = SVGElement.prototype as unknown as Record<string, unknown>;
  proto.getBBox = () => ({ x: 0, y: 0, width: 80, height: 20 });
  proto.getComputedTextLength = () => 80;
});

afterEach(() => {
  cleanup();
  resetMermaidForTests();
});

interface Diagram {
  readonly file: string;
  readonly index: number;
  readonly source: string;
}

async function loadDiagrams(): Promise<Diagram[]> {
  const out: Diagram[] = [];
  for (const path of markdownFiles(DOCS)) {
    const { html, warnings } = await renderMarkdown(readFileSync(path, "utf8"));
    const file = path.slice(DOCS.length - "docs".length);
    // Mermaid fences must all become diagrams: none left over the size or count caps.
    expect(warnings, file).toEqual([]);
    const host = document.createElement("div");
    host.innerHTML = html;
    const blocks = [...host.querySelectorAll("pre.dmr-mermaid code")];
    blocks.forEach((code, index) => out.push({ file, index, source: code.textContent ?? "" }));
  }
  return out;
}

describe("the diagrams of docs/ draw with the real Mermaid library", () => {
  it("finds at least four diagrams", async () => {
    const diagrams = await loadDiagrams();
    expect(diagrams.length).toBeGreaterThanOrEqual(4);
    for (const diagram of diagrams) expect(diagram.source.trim().length).toBeGreaterThan(20);
  });

  it("draws every diagram as an SVG in the light and the dark theme", async () => {
    const diagrams = await loadDiagrams();
    for (const theme of ["light", "dark"] as const) {
      for (const diagram of diagrams) {
        const name = `${diagram.file} #${diagram.index + 1} (${theme})`;
        render(<MermaidDiagram source={diagram.source} theme={theme} />);
        // Either the SVG or the error fallback appears; only the SVG is a pass.
        await waitFor(
          () => {
            const done = screen.queryByRole("img", { name: "Mermaid diagram" });
            const failed = screen.queryByRole("alert");
            expect(done !== null || failed !== null, name).toBe(true);
          },
          { timeout: 30_000 },
        );
        const failed = screen.queryByRole("alert");
        expect(failed?.textContent ?? null, `${name} failed to render`).toBeNull();
        const img = screen.getByRole("img", { name: "Mermaid diagram" });
        expect(img.querySelector("svg"), name).not.toBeNull();
        expect(img.querySelector("foreignObject, img, script"), name).toBeNull();
        expect((img.textContent ?? "").trim().length, `${name} has labels`).toBeGreaterThan(5);
        cleanup();
        resetMermaidForTests();
      }
    }
  }, 180_000);
});
