// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublicAccessSettings, type PublicAccessView } from "./public-access-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const view = (over: Partial<PublicAccessView> = {}): PublicAccessView => ({
  settings: {
    searchEnabled: true,
    askEnabled: false,
    askQuestionsPerDay: 200,
    askQuestionsPerTenMinutes: 20,
  },
  anyPublic: true,
  ...over,
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number, error: string) => ({
  ok: false,
  status,
  json: async () => ({ error }),
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockClear();
});

describe("PublicAccessSettings", () => {
  it("shows the stored settings: search on, Ask off, the caps", () => {
    render(<PublicAccessSettings initial={view()} />);
    expect((screen.getByRole("switch", { name: "Allow search" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      (screen.getByRole("switch", { name: "Allow Ask the docs" }) as HTMLInputElement).checked,
    ).toBe(false);
    expect((screen.getByLabelText("Anonymous questions per day") as HTMLInputElement).value).toBe(
      "200",
    );
    expect(
      (screen.getByLabelText("Anonymous questions per ten minutes") as HTMLInputElement).value,
    ).toBe("20");
    expect(screen.queryByTestId("public-access-nothing")).toBeNull();
  });

  it("says the switches matter once something is public, while nothing is", () => {
    render(<PublicAccessSettings initial={view({ anyPublic: false })} />);
    expect(screen.getByTestId("public-access-nothing").textContent).toContain(
      "Nothing is public yet",
    );
  });

  it("saves every setting and announces it", async () => {
    const next = view({
      settings: {
        searchEnabled: false,
        askEnabled: true,
        askQuestionsPerDay: 50,
        askQuestionsPerTenMinutes: 5,
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(ok(next));
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicAccessSettings initial={view()} />);
    fireEvent.click(screen.getByRole("switch", { name: "Allow search" }));
    fireEvent.click(screen.getByRole("switch", { name: "Allow Ask the docs" }));
    fireEvent.change(screen.getByLabelText("Anonymous questions per day"), {
      target: { value: "50" },
    });
    fireEvent.change(screen.getByLabelText("Anonymous questions per ten minutes"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save public access" }));
    await waitFor(() =>
      expect(screen.getByTestId("public-access-result").textContent).toContain("Saved"),
    );
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admin/public-access");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      searchEnabled: false,
      askEnabled: true,
      askQuestionsPerDay: 50,
      askQuestionsPerTenMinutes: 5,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("refuses a cap out of range without calling the server", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicAccessSettings initial={view()} />);
    fireEvent.change(screen.getByLabelText("Anonymous questions per day"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save public access" }));
    expect(screen.getByTestId("public-access-problem").textContent).toContain("from 1 to 10000");
    fireEvent.change(screen.getByLabelText("Anonymous questions per day"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("Anonymous questions per ten minutes"), {
      target: { value: "2000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save public access" }));
    expect(screen.getByTestId("public-access-problem").textContent).toContain("from 1 to 1000");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's refusal and keeps what was typed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(403, "Forbidden")));
    render(<PublicAccessSettings initial={view()} />);
    fireEvent.change(screen.getByLabelText("Anonymous questions per day"), {
      target: { value: "75" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save public access" }));
    await waitFor(() =>
      expect(screen.getByTestId("public-access-problem").textContent).toBe("Forbidden"),
    );
    expect((screen.getByLabelText("Anonymous questions per day") as HTMLInputElement).value).toBe(
      "75",
    );
  });

  it("names the switches and describes them for screen readers", () => {
    render(<PublicAccessSettings initial={view()} />);
    for (const name of ["Allow search", "Allow Ask the docs"]) {
      const input = screen.getByRole("switch", { name });
      expect(input.getAttribute("aria-describedby")).toBeTruthy();
    }
  });
});
