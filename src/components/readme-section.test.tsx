// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReadmeSection } from "./readme-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const HTML =
  '<h1 id="title">Title<a class="heading-anchor" href="#title" aria-label="Link to section: Title"></a></h1>' +
  '<p>Hello <a href="/acme/api/docs/guide">guide</a>.</p>' +
  '<pre class="shiki shiki-themes" tabindex="0"><code class="language-ts"><span class="line">const a = 1;</span></code></pre>';

describe("ReadmeSection with a README", () => {
  it("renders the pipeline HTML inside .markdown-body under a README heading", () => {
    render(<ReadmeSection readme={{ status: "rendered", html: HTML }} path="README.md" />);
    expect(screen.getByRole("heading", { level: 2, name: /README/ })).toBeTruthy();
    const body = screen.getByTestId("readme-body").querySelector(".markdown-body");
    expect(body).not.toBeNull();
    expect(body?.querySelector("h1")?.id).toBe("title");
    expect(body?.querySelector('a[href="/acme/api/docs/guide"]')?.textContent).toBe("guide");
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.queryByTestId("readme-empty")).toBeNull();
    expect(screen.queryByTestId("readme-notice")).toBeNull();
  });

  it("adds the copy button to code blocks (same wrappers as every document)", async () => {
    render(<ReadmeSection readme={{ status: "rendered", html: HTML }} />);
    expect(await screen.findByRole("button", { name: "Copy code" })).toBeTruthy();
  });

  it("shows a notice next to rendered content", () => {
    render(<ReadmeSection readme={{ status: "rendered", html: HTML, notice: "Cut short." }} />);
    expect(screen.getByTestId("readme-notice").textContent).toBe("Cut short.");
    expect(screen.getByTestId("readme-body").querySelector(".markdown-body")).not.toBeNull();
  });

  it("shows the Markdown as escaped plain text, with a notice, when rendering failed", () => {
    const text = '# Title\n\n<img src=x onerror="alert(1)"> <script>alert(2)</script>';
    const { container } = render(
      <ReadmeSection readme={{ status: "plain", text, notice: "Could not render." }} />,
    );
    expect(screen.getByTestId("readme-notice").textContent).toBe("Could not render.");
    const pre = screen.getByTestId("readme-plain");
    expect(pre.textContent).toBe(text);
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.querySelector(".markdown-body")).toBeNull();
  });
});

describe("ReadmeSection without a README", () => {
  it("shows an empty state that says how to add one", () => {
    const { container } = render(<ReadmeSection readme={{ status: "missing" }} />);
    expect(screen.getByRole("heading", { level: 2, name: "README" })).toBeTruthy();
    const empty = screen.getByTestId("readme-empty");
    expect(empty.textContent).toContain("No README found");
    expect(empty.textContent).toContain("README.md");
    expect(empty.textContent).toContain("next sync");
    expect(container.querySelector(".markdown-body")).toBeNull();
    expect(screen.queryByTestId("readme-body")).toBeNull();
  });

  it("does not claim there is no README before the first sync", () => {
    render(<ReadmeSection readme={{ status: "missing" }} awaitingSync />);
    const empty = screen.getByTestId("readme-empty");
    expect(empty.textContent).toContain("after the first sync");
    expect(empty.textContent).not.toContain("No README found");
  });
});
