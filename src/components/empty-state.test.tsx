// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EmptyState } from "./empty-state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

describe("EmptyState", () => {
  it("explains how to configure and run a first sync with the real names", () => {
    render(<EmptyState />);
    expect(screen.getByRole("heading", { name: "Nothing synced yet" })).toBeTruthy();
    const text = screen.getByTestId("empty-state").textContent ?? "";
    for (const name of [
      "DATABASE_URL",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_PRIVATE_KEY_PATH",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_WEBHOOK_SECRET",
      "SYNC_SECRET",
      "docmyrepos.config.yml",
      "docs/github-app-setup.md",
    ]) {
      expect(text, name).toContain(name);
    }
    expect(text).toContain(
      'curl -X POST -H "Authorization: Bearer $SYNC_SECRET" <your-app-url>/api/sync',
    );
  });

  it("is an ordered list of steps", () => {
    render(<EmptyState />);
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
  });
});
