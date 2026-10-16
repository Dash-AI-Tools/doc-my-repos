// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AskSettingsForm, type AskSettingsView } from "./ask-settings-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<typeof fetch>();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const VIEW: AskSettingsView = {
  settings: { enabled: false, provider: null, model: null },
  providers: {
    anthropic: { configured: true, missing: [] },
    "openai-compatible": { configured: true, missing: [], host: "models.internal" },
  },
  state: { state: "off" },
};

const MISSING: AskSettingsView = {
  ...VIEW,
  providers: {
    anthropic: { configured: false, missing: ["AI_ANTHROPIC_API_KEY"] },
    "openai-compatible": {
      configured: false,
      missing: [],
      problem: "AI_OPENAI_BASE_URL: must be an https URL",
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Event helpers over `fireEvent`: the project has no user-event library. */
const click = (el: Element) => fireEvent.click(el);
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
const choose = (el: Element, value: string) => fireEvent.change(el, { target: { value } });

const provider = () => screen.getByLabelText("Provider") as HTMLSelectElement;
const model = () => screen.getByLabelText("Model name") as HTMLInputElement;
const toggle = () => screen.getByRole("switch", { name: "Turn Ask on" }) as HTMLInputElement;
const result = () => screen.getByTestId("ask-admin-result");

describe("AskSettingsForm", () => {
  it("renders the controls with Ask off and nothing chosen", () => {
    render(<AskSettingsForm initial={VIEW} />);
    expect(toggle().checked).toBe(false);
    expect(provider().value).toBe("");
    expect(model().value).toBe("");
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDefined();
    expect(screen.getByTestId("ask-admin-state").textContent).toContain("Off");
    expect(screen.getByText(/sent to the provider you choose/)).toBeDefined();
  });

  it("offers only the two fixed providers, each annotated with its credentials", () => {
    render(<AskSettingsForm initial={VIEW} />);
    const options = within(provider())
      .getAllByRole("option")
      .map((o) => [(o as HTMLOptionElement).value, o.textContent]);
    expect(options).toEqual([
      ["", "Choose a provider"],
      ["anthropic", "Anthropic (configured)"],
      ["openai-compatible", "OpenAI-compatible endpoint (configured, models.internal)"],
    ]);
  });

  it("loads the saved choice and the current state", () => {
    render(
      <AskSettingsForm
        initial={{
          ...VIEW,
          settings: { enabled: true, provider: "anthropic", model: "saved-model" },
          state: { state: "ready", provider: "anthropic", model: "saved-model" },
        }}
      />,
    );
    expect(toggle().checked).toBe(true);
    expect(provider().value).toBe("anthropic");
    expect(model().value).toBe("saved-model");
    expect(screen.getByTestId("ask-admin-state").textContent).toContain("Ready");
    expect(screen.getByTestId("ask-admin-state").textContent).toContain("saved-model");
  });

  it("annotates a provider with missing variables and cannot choose it", () => {
    render(<AskSettingsForm initial={MISSING} />);
    const options = within(provider()).getAllByRole("option") as HTMLOptionElement[];
    expect(options[1]).toMatchObject({ disabled: true });
    expect(options[1]?.textContent).toBe("Anthropic (missing AI_ANTHROPIC_API_KEY)");
    expect(options[2]).toMatchObject({ disabled: true });
    expect(options[2]?.textContent).toBe("OpenAI-compatible endpoint (not usable)");
  });

  it("shows a saved provider that lost its credentials, and refuses to turn it on", async () => {
    render(
      <AskSettingsForm
        initial={{
          ...MISSING,
          settings: { enabled: false, provider: "anthropic", model: "m" },
          state: { state: "off" },
        }}
      />,
    );
    expect(provider().value).toBe("anthropic");
    expect(
      screen.getByText(/operator must set AI_ANTHROPIC_API_KEY before this provider/),
    ).toBeDefined();
    click(toggle());
    click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This provider is not configured.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the variable of a unusable state", () => {
    render(
      <AskSettingsForm
        initial={{
          ...MISSING,
          settings: { enabled: true, provider: "anthropic", model: "m" },
          state: { state: "unavailable", missing: ["AI_ANTHROPIC_API_KEY"] },
        }}
      />,
    );
    expect(screen.getByTestId("ask-admin-state").textContent).toContain("Unavailable");
    expect(screen.getByTestId("ask-admin-state").textContent).toContain("AI_ANTHROPIC_API_KEY");
  });

  it("shows the endpoint host for the OpenAI-compatible provider only", async () => {
    render(<AskSettingsForm initial={VIEW} />);
    expect(screen.queryByTestId("ask-endpoint-host")).toBeNull();
    choose(provider(), "openai-compatible");
    expect(screen.getByTestId("ask-endpoint-host").textContent).toBe(
      "Requests go to models.internal.",
    );
    choose(provider(), "anthropic");
    expect(screen.queryByTestId("ask-endpoint-host")).toBeNull();
  });

  it("gives a per-provider hint for the model and no default value", async () => {
    render(<AskSettingsForm initial={VIEW} />);
    expect(model().value).toBe("");
    choose(provider(), "anthropic");
    expect(screen.getByText(/as your Anthropic account lists it/)).toBeDefined();
    choose(provider(), "openai-compatible");
    expect(screen.getByText(/exactly as your endpoint expects it/)).toBeDefined();
    expect(model().value).toBe("");
  });

  it("validates beside the field and does not call the server", async () => {
    render(<AskSettingsForm initial={VIEW} />);
    choose(provider(), "anthropic");
    type(model(), "has space");
    click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/^The model name may contain only/);
    expect(model().getAttribute("aria-invalid")).toBe("true");
    expect(model().getAttribute("aria-describedby")).toContain(alert.id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("will not turn Ask on without a provider or a model", async () => {
    render(<AskSettingsForm initial={VIEW} />);
    click(toggle());
    click(screen.getByRole("button", { name: "Save" }));
    const alerts = (await screen.findAllByRole("alert")).map((a) => a.textContent);
    expect(alerts).toEqual([
      "Choose a provider before turning Ask on.",
      "Enter a model name before turning Ask on.",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves the choice, shows the new state and refreshes the page", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ...VIEW,
        settings: { enabled: true, provider: "anthropic", model: "claude-test" },
        state: { state: "ready", provider: "anthropic", model: "claude-test" },
      }),
    );
    render(<AskSettingsForm initial={VIEW} />);
    choose(provider(), "anthropic");
    type(model(), "  claude-test ");
    click(toggle());
    click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(result().textContent).toBe("Saved. Ask is on."));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/ask");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      enabled: true,
      provider: "anthropic",
      model: "claude-test",
    });
    expect(screen.getByTestId("ask-admin-state").textContent).toContain("Ready");
    expect(refresh).toHaveBeenCalled();
  });

  it("saves Ask off without a provider or model", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VIEW));
    render(
      <AskSettingsForm
        initial={{ ...VIEW, settings: { enabled: true, provider: "anthropic", model: "m" } }}
      />,
    );
    click(toggle());
    click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(result().textContent).toBe("Saved. Ask is off."));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ enabled: false });
  });

  it("shows a server message that names a field beside that field", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: "This provider is not configured: AI_ANTHROPIC_API_KEY not set",
          field: "provider",
        },
        400,
      ),
    );
    render(<AskSettingsForm initial={VIEW} />);
    choose(provider(), "anthropic");
    type(model(), "m");
    click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("AI_ANTHROPIC_API_KEY");
  });

  it("tests the connection without saving, for each fixed result", async () => {
    render(<AskSettingsForm initial={VIEW} />);
    choose(provider(), "openai-compatible");
    type(model(), "llama3.1:8b");
    const cases: [string, RegExp][] = [
      ["ok", /^Test passed/],
      ["rejected", /rejected the credentials/],
      ["not_found", /does not know that model/],
      ["unavailable", /could not be reached/],
      ["timeout", /did not answer in time/],
    ];
    for (const [word, text] of cases) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ result: word }));
      click(screen.getByRole("button", { name: "Test connection" }));
      await waitFor(() => expect(result().textContent).toMatch(text));
    }
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("/api/admin/ask/test");
      expect(JSON.parse(String(call[1]?.body))).toEqual({
        provider: "openai-compatible",
        model: "llama3.1:8b",
      });
    }
    expect(fetchMock.mock.calls.every((c) => c[0] !== "/api/admin/ask")).toBe(true); // never saved
    expect(refresh).not.toHaveBeenCalled();
  });

  it("explains a rate-limited test and a failed request with fixed text", async () => {
    render(<AskSettingsForm initial={VIEW} />);
    choose(provider(), "anthropic");
    type(model(), "m");
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "x", retryAfterSeconds: 42 }, 429));
    click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(result().textContent).toBe("Too many tests. Try again in 42 seconds."),
    );
    fetchMock.mockRejectedValueOnce(new TypeError("network down with key sk-secret"));
    click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(result().textContent).toMatch(/could not be reached/));
    expect(result().textContent).not.toContain("sk-secret");
  });

  it("needs a provider and a model to test, and says so beside the fields", async () => {
    render(<AskSettingsForm initial={VIEW} />);
    click(screen.getByRole("button", { name: "Test connection" }));
    expect((await screen.findAllByRole("alert")).length).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("announces results in a polite status region", () => {
    render(<AskSettingsForm initial={VIEW} />);
    expect(result().getAttribute("role")).toBe("status");
  });

  it("uses native controls in a sensible tab order, with every control labelled", () => {
    const { container } = render(<AskSettingsForm initial={VIEW} />);
    // Document order is the Tab order (nothing carries a tabindex).
    const order = [...container.querySelectorAll("input, select, button")].map((el) => {
      const id = el.getAttribute("id");
      const label = id ? container.querySelector(`label[for="${id}"]`)?.textContent : null;
      return label ?? el.closest("label")?.textContent ?? el.textContent;
    });
    expect(order).toEqual(["Turn Ask on", "Provider", "Model name", "Save", "Test connection"]);
    expect(container.querySelector("[tabindex]")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("type")).toBe("submit");
  });

  it("submits with Enter in the model field (the form's own submit)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VIEW));
    const { container } = render(<AskSettingsForm initial={VIEW} />);
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(result().textContent).toBe("Saved. Ask is off."));
  });

  it("renders no credential field at all", () => {
    render(<AskSettingsForm initial={VIEW} />);
    expect(screen.queryByLabelText(/key|secret|token|password|url|endpoint address/i)).toBeNull();
    expect(document.querySelectorAll('input[type="password"], input[type="url"]')).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Save" })); // harmless: nothing chosen, off
  });
});
