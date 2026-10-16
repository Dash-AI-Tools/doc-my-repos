// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EmptyState } from "./empty-state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

describe("EmptyState", () => {
  it("explains how to configure in the admin interface and run a first sync", () => {
    render(<EmptyState />);
    expect(screen.getByRole("heading", { name: "Nothing synced yet" })).toBeTruthy();
    const text = screen.getByTestId("empty-state").textContent ?? "";
    for (const name of ["/admin/workspace", "SYNC_SECRET", "docs/github-app-setup.md"]) {
      expect(text, name).toContain(name);
    }
    expect(text).toContain(
      'curl -X POST -H "Authorization: Bearer $SYNC_SECRET" <your-app-url>/api/sync',
    );
  });

  it("no longer sends the reader to environment variables or a config file for GitHub", () => {
    render(<EmptyState />);
    const text = screen.getByTestId("empty-state").textContent ?? "";
    for (const retired of ["GITHUB_APP_ID", "GITHUB_WEBHOOK_SECRET", "docmyrepos.config.yml"]) {
      expect(text, retired).not.toContain(retired);
    }
  });

  it("is an ordered list of steps", () => {
    render(<EmptyState />);
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
  });
});
