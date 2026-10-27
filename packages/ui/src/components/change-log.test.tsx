// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChangeLog } from "./change-log";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

describe("ChangeLog", () => {
  it("labels the section as a change log and keeps the body", () => {
    render(
      <ChangeLog>
        <div data-testid="body">entries</div>
      </ChangeLog>,
    );
    expect(screen.getByRole("region", { name: "Change log" })).toBeTruthy();
    expect(screen.getByTestId("change-log-badge").textContent).toBe("Change log");
    expect(screen.getByTestId("change-log").textContent).toContain("not a typed concept");
    expect(screen.getByTestId("body").closest(".change-log")).not.toBeNull();
  });
});
