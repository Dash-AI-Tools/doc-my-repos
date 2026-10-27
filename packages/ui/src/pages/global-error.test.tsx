// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  GLOBAL_ERROR_TOKENS,
  GlobalErrorContent,
  globalErrorCss,
} from "../components/global-error-view";
import {
  contrastRatio,
  THEME_TOKENS,
  type ThemeName,
} from "@docmyrepos/core/internal/theme-tokens";

import { GlobalErrorPage as GlobalError } from "./global-error";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const SECRET_ERROR = () =>
  Object.assign(new Error("connect failed to postgres://u:hunter2@10.0.0.5/db token=ghs_abc"), {
    digest: "dg-12345",
    stack: "Error: at /srv/app/secret.ts:1:1",
  });

describe("GlobalErrorContent", () => {
  it("shows a heading, the digest reference and nothing else from the error", () => {
    render(<GlobalErrorContent error={SECRET_ERROR()} reset={() => undefined} />);
    expect(screen.getByRole("heading", { level: 1, name: "Something went wrong" })).toBeTruthy();
    const text = screen.getByTestId("global-error").textContent ?? "";
    expect(screen.getByTestId("global-error-digest").textContent).toBe("dg-12345");
    expect(text).not.toMatch(/hunter2|10\.0\.0\.5|postgres:|ghs_|secret\.ts|connect failed/);
  });

  it("is an alert region labelled by its heading, inside <main>", () => {
    render(<GlobalErrorContent error={SECRET_ERROR()} reset={() => undefined} />);
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-labelledby")).toBe("global-error-heading");
    expect(screen.getByRole("main").contains(alert)).toBe(true);
  });

  it("omits the reference when there is no digest, and caps a long one", () => {
    const { unmount } = render(
      <GlobalErrorContent error={new Error("x")} reset={() => undefined} />,
    );
    expect(screen.queryByTestId("global-error-digest")).toBeNull();
    expect(screen.getByTestId("global-error").textContent).not.toContain("Reference");
    unmount();
    render(
      <GlobalErrorContent
        error={Object.assign(new Error("x"), { digest: "d".repeat(500) })}
        reset={() => undefined}
      />,
    );
    expect(screen.getByTestId("global-error-digest").textContent).toBe("d".repeat(64));
  });

  it("retries through reset and then reloads the page", () => {
    const calls: string[] = [];
    render(
      <GlobalErrorContent
        error={new Error("x")}
        reset={() => calls.push("reset")}
        reload={() => calls.push("reload")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(calls).toEqual(["reset", "reload"]);
  });

  it("links home with a plain anchor (a full page load)", () => {
    render(<GlobalErrorContent error={new Error("x")} reset={() => undefined} />);
    const home = screen.getByRole("link", { name: "Back to the home page" });
    expect(home.getAttribute("href")).toBe("/");
    expect(home.tagName).toBe("A");
  });

  it("escapes a hostile digest", () => {
    const digest = '"><img src=x onerror=alert(1)>';
    const html = renderToStaticMarkup(
      <GlobalErrorContent
        error={Object.assign(new Error("x"), { digest })}
        reset={() => undefined}
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("GlobalError document", () => {
  const html = renderToStaticMarkup(<GlobalError error={SECRET_ERROR()} reset={() => undefined} />);

  it("renders its own <html lang> and <body>, since it replaces the root layout", () => {
    expect(html.startsWith('<html lang="en">')).toBe(true);
    expect(html).toContain("<body>");
    expect(html).toContain("</body></html>");
  });

  it("declares both color schemes and carries its own stylesheet", () => {
    expect(html).toContain('<meta name="color-scheme" content="light dark"/>');
    expect(html).toMatch(/<style>[\s\S]+<\/style>/);
    expect(html).toContain("prefers-color-scheme:dark");
  });

  it("has a title and no script, no external request, no secret", () => {
    expect(html).toContain("<title>Something went wrong · DocMyRepos</title>");
    expect(html).not.toMatch(/<script|<link|<img|src=|url\(|@import|https?:\/\//);
    expect(html).not.toMatch(/hunter2|10\.0\.0\.5|postgres:|ghs_|secret\.ts/);
    expect(html).toContain("dg-12345");
  });
});

describe("globalErrorCss", () => {
  const css = globalErrorCss();
  const darkStart = css.indexOf("@media (prefers-color-scheme:dark)");

  it("defines every token for light first and for dark inside prefers-color-scheme", () => {
    expect(darkStart).toBeGreaterThan(0);
    const light = css.slice(0, darkStart);
    const dark = css.slice(darkStart, css.indexOf("\n", darkStart));
    for (const name of GLOBAL_ERROR_TOKENS) {
      expect(light).toContain(`--${name}:${THEME_TOKENS.light[name]};`);
      expect(dark).toContain(`--${name}:${THEME_TOKENS.dark[name]};`);
    }
  });

  it("uses only token colors: no literal color outside the custom property block", () => {
    const rules = css
      .split("\n")
      .slice(1)
      .join("\n")
      .replace(/@media[^\n]*\n?/, "");
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });

  it.each(["light", "dark"] as const satisfies readonly ThemeName[])(
    "meets text contrast in the %s theme",
    (theme) => {
      const t = THEME_TOKENS[theme];
      const pairs: [TokenNameLike, TokenNameLike][] = [
        ["foreground", "background"],
        ["destructive-muted-foreground", "destructive-muted"],
        ["primary-foreground", "primary"],
        ["secondary-foreground", "secondary"],
      ];
      for (const [fg, bg] of pairs) {
        expect(contrastRatio(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(t.ring, t.background)).toBeGreaterThanOrEqual(3);
    },
  );
});

type TokenNameLike = (typeof GLOBAL_ERROR_TOKENS)[number];
