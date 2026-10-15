import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import { DocReader } from "./doc-reader";
import { ReaderGrid } from "./reader-grid";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/api/docs/setup" }));

const html = renderToString(
  <DocReader>
    <ReaderGrid outline={[]} nav={null}>
      <p>body</p>
    </ReaderGrid>
  </DocReader>,
);

/** The grid element's class list, from the server render. */
const gridClasses = /<div class="([^"]*grid[^"]*)"/.exec(html)?.[1] ?? "";

describe("ReaderGrid track classes", () => {
  it("keeps the side tracks a constant pixel width at every text size", () => {
    expect(gridClasses).toContain("lg:grid-cols-[calc(15rem/var(--text-scale,1))_minmax(0,1fr)]");
    expect(gridClasses).toContain(
      "xl:grid-cols-[calc(16rem/var(--text-scale,1))_minmax(0,1fr)_calc(14rem/var(--text-scale,1))]",
    );
    expect(gridClasses).toContain(
      "2xl:grid-cols-[calc(18rem/var(--text-scale,1))_minmax(0,1fr)_calc(16rem/var(--text-scale,1))]",
    );
  });

  it("no longer uses fixed rem tracks", () => {
    expect(gridClasses).not.toMatch(/grid-cols-\[(15|16|18)rem_/);
  });
});

describe("ReaderGrid read mode hooks", () => {
  it("has the grid and content hooks the read mode layout keys on", () => {
    expect(gridClasses).toMatch(/\breader-grid\b/);
    expect(html).toMatch(/class="[^"]*\breader-content\b/);
  });

  it("marks the outline column for read mode to hide", () => {
    expect(html).toMatch(/data-testid="doc-sidebar"[^>]*data-read-hide/);
  });
});
