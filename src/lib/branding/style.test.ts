import { describe, expect, it } from "vitest";

import { deriveBrandTokens } from "./colors";
import { brandStyleBlock } from "./style";

const derived = deriveBrandTokens({ primary: "#2b59ff", accent: "#2b59ff" });

describe("brandStyleBlock", () => {
  it("is empty when nothing is set and no logo needs inversion", () => {
    expect(brandStyleBlock(null, { coloredHeader: false, invertLogo: false, hasLogo: false })).toBe(
      "",
    );
    expect(brandStyleBlock(null, { coloredHeader: false, invertLogo: true, hasLogo: false })).toBe(
      "",
    );
    expect(brandStyleBlock(null, { coloredHeader: false, invertLogo: false, hasLogo: true })).toBe(
      "",
    );
  });

  it("contains only expected properties and values", () => {
    const css = brandStyleBlock(derived, {
      coloredHeader: true,
      invertLogo: false,
      hasLogo: false,
    });
    expect(css).toContain("html:root{");
    expect(css).toContain("html.dark{");
    expect(css).toContain("--primary:#2b59ff;");
    expect(css).not.toContain("expression");
    expect(css).not.toContain("<");
    // Without a colored bar the dark header follows the tinted page; the light part is untouched.
    const plain = brandStyleBlock(derived, {
      coloredHeader: false,
      invertLogo: false,
      hasLogo: false,
    });
    expect(plain.split("html.dark{")[0]).not.toContain("--header");
    expect(plain).toContain(`--header:${derived.dark["background"]};`);
    expect(plain).toContain(`--header-foreground:${derived.dark["foreground"]};`);
  });

  it("emits the tinted dark surfaces and leaves the light ones to the palette", () => {
    const css = brandStyleBlock(derived, {
      coloredHeader: false,
      invertLogo: false,
      hasLogo: false,
    });
    const [light, dark = ""] = css.split("html.dark{");
    expect(light).not.toContain("--background:");
    expect(dark).toContain(`--background:${derived.dark["background"]};`);
    expect(dark).toContain(`--muted-foreground:${derived.dark["muted-foreground"]};`);
    expect(dark).toContain(`--card:${derived.dark["card"]};`);
  });

  it("inverts always in dark, in root only on a white-text colored bar", () => {
    const darkOnly = brandStyleBlock(null, {
      coloredHeader: false,
      invertLogo: true,
      hasLogo: true,
    });
    expect(darkOnly).toBe("html.dark{--logo-filter:invert(1);}");
    const colored = brandStyleBlock(derived, {
      coloredHeader: true,
      invertLogo: true,
      hasLogo: true,
    });
    expect(colored).toContain("html.dark{");
    expect(colored).toContain("--logo-filter:invert(1);");
    // #2b59ff bar has white text, so root inverts too.
    expect(colored).toContain("html:root{");
    const rootPart = colored.split("html.dark{")[0] ?? "";
    expect(rootPart).toContain("--logo-filter:invert(1);");
    const uncolored = brandStyleBlock(derived, {
      coloredHeader: false,
      invertLogo: true,
      hasLogo: true,
    });
    const uncoloredRoot = uncolored.split("html.dark{")[0] ?? "";
    expect(uncoloredRoot).not.toContain("--logo-filter");
  });

  it("emits nothing for inversion when off", () => {
    const css = brandStyleBlock(derived, { coloredHeader: true, invertLogo: false, hasLogo: true });
    expect(css).not.toContain("logo-filter");
  });

  it("cannot be influenced by hostile input strings", () => {
    const hostile = {
      light: { primary: "#fff;} body{display:none", link: "javascript:alert(1)", ring: "#2b59ff" },
      dark: { primary: "#2b59ff;--evil:1", "primary-foreground": "#ffffff" },
    };
    const css = brandStyleBlock(hostile, {
      coloredHeader: false,
      invertLogo: false,
      hasLogo: false,
    });
    expect(css).not.toContain("body");
    expect(css).not.toContain("javascript");
    expect(css).not.toContain("evil");
    expect(css).toContain("--ring:#2b59ff;");
    expect(css).toContain("--primary-foreground:#ffffff;");
  });
});
