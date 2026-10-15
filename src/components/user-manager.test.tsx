// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserManager, type AdminUserView } from "./user-manager";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const users: AdminUserView[] = [
  { id: 1, email: "ada@example.com", role: "admin", disabled: false },
  { id: 2, email: "bob@example.com", role: "user", disabled: false },
  { id: 3, email: "cy@example.com", role: "user", disabled: true },
];

afterEach(cleanup);

describe("UserManager", () => {
  it("filters by search and by status", () => {
    render(<UserManager initialUsers={users} currentUserId={1} />);
    fireEvent.change(screen.getByLabelText("Search users by email"), { target: { value: "bob" } });
    expect(screen.queryByText("ada@example.com")).toBeNull();
    expect(screen.getByText("bob@example.com")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search users by email"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Disabled/ }));
    expect(screen.getByText("cy@example.com")).toBeTruthy();
    expect(screen.queryByText("bob@example.com")).toBeNull();
  });

  it("locks the signed-in admin's own role and disable action", () => {
    render(<UserManager initialUsers={users} currentUserId={1} />);
    const own = screen.getByLabelText("Role for ada@example.com") as HTMLSelectElement;
    expect(own.disabled).toBe(true);
    expect(screen.getAllByRole("button", { name: "Disable" })).toHaveLength(1);
  });

  it("asks for confirmation inline before disabling", () => {
    render(<UserManager initialUsers={users} currentUserId={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(screen.getByText(/Their sessions stop working immediately/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable user" })).toBeTruthy();
  });
});
