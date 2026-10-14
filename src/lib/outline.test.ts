import { describe, expect, it } from "vitest";

import { buildOutline, outlineIds, startsWithTitleHeading, type OutlineHeading } from "./outline";

const h = (depth: number, text: string, slug = text.toLowerCase().replace(/\s+/g, "-")) => ({
  depth,
  text,
  slug,
});
const same = (slug: string) => slug;

describe("buildOutline", () => {
  it("lists h2 to h4, nested by level, in document order", () => {
    const out = buildOutline(
      [h(1, "Title"), h(2, "Install"), h(3, "Linux"), h(3, "Mac"), h(2, "Use"), h(4, "Flags")],
      same,
    );
    expect(out).toEqual([
      {
        text: "Install",
        id: "install",
        depth: 2,
        children: [
          { text: "Linux", id: "linux", depth: 3, children: [] },
          { text: "Mac", id: "mac", depth: 3, children: [] },
        ],
      },
      {
        text: "Use",
        id: "use",
        depth: 2,
        children: [{ text: "Flags", id: "flags", depth: 4, children: [] }],
      },
    ]);
  });

  it("leaves out h1, h5 and h6", () => {
    expect(buildOutline([h(1, "A"), h(5, "B"), h(6, "C")], same)).toEqual([]);
  });

  it("nests a level that skips one under the nearest shallower heading", () => {
    const out = buildOutline([h(2, "A"), h(4, "B")], same);
    expect(out).toHaveLength(1);
    expect(out[0]?.children.map((c) => c.text)).toEqual(["B"]);
  });

  it("makes siblings of a heading that returns to a shallower level", () => {
    const out = buildOutline([h(3, "A"), h(2, "B"), h(3, "C")], same);
    expect(out.map((i) => i.text)).toEqual(["A", "B"]);
    expect(out[1]?.children.map((c) => c.text)).toEqual(["C"]);
  });

  it("uses the id function, so renamed ids match the page", () => {
    const out = buildOutline([h(2, "Proto", "__proto__")], (slug) => `user-content-${slug}`);
    expect(out[0]?.id).toBe("user-content-__proto__");
  });

  it("skips headings without a slug or text, and repeated ids", () => {
    const out = buildOutline(
      [h(2, "A", ""), h(2, "", "x"), h(2, "B", "b"), h(3, "B again", "b")],
      same,
    );
    expect(outlineIds(out)).toEqual(["b"]);
  });

  it("keeps the text as plain data for the component to escape", () => {
    const out = buildOutline([h(2, "<img src=x onerror=alert(1)>", "img")], same);
    expect(out[0]?.text).toBe("<img src=x onerror=alert(1)>");
  });

  it("lists ids in document order, depth first", () => {
    const out = buildOutline([h(2, "A"), h(3, "B"), h(2, "C")], same);
    expect(outlineIds(out)).toEqual(["a", "b", "c"]);
  });

  it("copes with 2000 headings", () => {
    const many: OutlineHeading[] = Array.from({ length: 2000 }, (_, i) =>
      h(2 + (i % 3), `H${i}`, `h${i}`),
    );
    expect(outlineIds(buildOutline(many, same))).toHaveLength(2000);
  });
});

describe("startsWithTitleHeading", () => {
  const html = '<h1 id="setup">Setup</h1><p>x</p>';

  it("is true when the body opens with an h1 that repeats the title", () => {
    expect(startsWithTitleHeading(html, [h(1, "Setup")], "Setup")).toBe(true);
    expect(startsWithTitleHeading(`\n${html}`, [h(1, "  setup ")], "Setup")).toBe(true);
  });

  it("is false when the h1 differs, is not first, or there is none", () => {
    expect(startsWithTitleHeading(html, [h(1, "Setup")], "Other")).toBe(false);
    expect(startsWithTitleHeading(`<p>x</p>${html}`, [h(1, "Setup")], "Setup")).toBe(false);
    expect(startsWithTitleHeading('<h2 id="a">A</h2>', [h(2, "A")], "A")).toBe(false);
    expect(startsWithTitleHeading("<p>x</p>", [], "Setup")).toBe(false);
  });
});
