// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiReference } from "./api-reference";
import { API_REFERENCE_OPTIONS } from "./api-reference-config";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mock = vi.hoisted(() => ({ props: [] as Record<string, unknown>[], boom: false }));

vi.mock("swagger-ui-react", () => ({
  default: (props: Record<string, unknown>) => {
    mock.props.push(props);
    if (mock.boom) throw new Error("secret spec text");
    return <div data-testid="swagger" />;
  },
}));
vi.mock("swagger-ui-react/swagger-ui.css", () => ({}));

const SPEC = { openapi: "3.1.0", info: { title: "T", version: "1" }, paths: {} };
const SOURCE = "https://github.com/acme/api/blob/main/openapi.yaml";

beforeEach(() => {
  mock.props = [];
  mock.boom = false;
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("ApiReference", () => {
  it("renders the widget with the spec and exactly the locked-down options", async () => {
    render(<ApiReference spec={SPEC} sourceUrl={SOURCE} />);
    await screen.findByTestId("swagger");
    const props = mock.props.at(-1) as Record<string, unknown>;
    expect(props).toEqual({ ...API_REFERENCE_OPTIONS, spec: SPEC });
    expect(props.spec).toBe(SPEC);
  });

  it("ignores url and configUrl in the address", async () => {
    window.history.replaceState(
      null,
      "",
      "/x?url=https://evil.example/x.json&configUrl=https://evil.example/c.json",
    );
    render(<ApiReference spec={SPEC} sourceUrl={SOURCE} />);
    await screen.findByTestId("swagger");
    const props = mock.props.at(-1) as Record<string, unknown>;
    expect(props.url).toBeUndefined();
    expect(props.urls).toBeUndefined();
    expect(props.configUrl).toBeUndefined();
    expect(props.queryConfigEnabled).toBe(false);
  });

  it("shows the fallback with the source link when the widget throws", async () => {
    mock.boom = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ApiReference spec={SPEC} sourceUrl={SOURCE} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not be displayed");
    expect(screen.getByRole("link", { name: /view source on github/i }).getAttribute("href")).toBe(
      SOURCE,
    );
    expect(document.body.textContent).not.toContain("secret spec text");
  });

  it("shows the fallback without a link when there is no source URL", async () => {
    mock.boom = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ApiReference spec={SPEC} sourceUrl={null} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
