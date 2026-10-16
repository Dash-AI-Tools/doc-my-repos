import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

import AdminAskRedirect from "./page";

describe("/admin/ask", () => {
  it("sends old links to the Ask tab of the Workspace configuration page", () => {
    expect(() => AdminAskRedirect()).toThrow("redirect:/admin/workspace?tab=ask");
  });
});
