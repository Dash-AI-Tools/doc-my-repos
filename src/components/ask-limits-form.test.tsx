// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configSchema } from "@/server/config/schema";

import { AskLimitsForm } from "./ask-limits-form";
import type { SettingsView } from "./github-settings-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<typeof fetch>();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const VIEW: SettingsView = {
  version: 3,
  settings: configSchema.parse({ github: { appId: 1, installationId: 2 } }),
  secrets: {},
  problems: { missingGithub: [], encryptionKey: null, unreadable: [], invalidStored: false },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AskLimitsForm", () => {
  it("saves the edited limit with the loaded version and no secrets", async () => {
    fetchMock.mockResolvedValue(json(VIEW));
    render(<AskLimitsForm initial={VIEW} />);
    fireEvent.change(screen.getByLabelText("Questions per user per day"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.expectedVersion).toBe(3);
    expect(body.secrets).toEqual({});
    expect(body.settings.ask.questionsPerDay).toBe(7);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("names a bad number and does not call the server", () => {
    render(<AskLimitsForm initial={VIEW} />);
    fireEvent.change(screen.getByLabelText("Longest answer (tokens)"), {
      target: { value: "lots" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    expect(screen.getByTestId("ask-limits-problems").textContent).toContain("whole number");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
