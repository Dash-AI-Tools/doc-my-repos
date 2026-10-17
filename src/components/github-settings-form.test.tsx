// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configSchema } from "@/server/config/schema";

import { GithubSettingsForm, type SettingsView } from "./github-settings-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<typeof fetch>();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nSENTINELKEYBODY\n-----END RSA PRIVATE KEY-----";
const WEBHOOK = "webhook-secret-SENTINEL-123";

const EMPTY: SettingsView = {
  version: 0,
  settings: configSchema.parse({}),
  secrets: {
    github_private_key: { set: false, updatedAt: null },
    github_webhook_secret: { set: false, updatedAt: null },
  },
  problems: {
    missingGithub: ["github.appId", "github.installationId", "github_private_key"],
    encryptionKey: null,
    unreadable: [],
    invalidStored: false,
  },
};

const CONFIGURED: SettingsView = {
  ...EMPTY,
  version: 5,
  settings: configSchema.parse({
    github: { appId: 123, installationId: 456 },
    repos: ["api", { name: "web", docsPath: "guide" }],
  }),
  secrets: {
    github_private_key: { set: true, updatedAt: "2026-10-16T09:30:00.000Z" },
    github_webhook_secret: { set: true, updatedAt: "2026-10-15T08:00:00.000Z" },
  },
  problems: { ...EMPTY.problems, missingGithub: [] },
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

const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
const click = (el: Element) => fireEvent.click(el);
const save = () => click(screen.getByRole("button", { name: "Save" }));
const result = () => screen.getByTestId("settings-result");
const sent = () => JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

describe("GithubSettingsForm: what it shows", () => {
  it("loads the stored values and shows secrets as set or not, never their value", () => {
    const { container } = render(<GithubSettingsForm initial={CONFIGURED} />);
    expect((screen.getByLabelText("App ID") as HTMLInputElement).value).toBe("123");
    expect((screen.getByLabelText("Installation ID") as HTMLInputElement).value).toBe("456");
    expect(screen.getByTestId("settings-private-key-state").textContent).toContain(
      "Set, changed 2026-10-16 09:30 UTC.",
    );
    expect((screen.getByLabelText("Private key (PEM)") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("Webhook secret") as HTMLInputElement).type).toBe("password");
    expect((screen.getByLabelText("Repositories to show") as HTMLTextAreaElement).value).toBe(
      "api\nweb docsPath=guide",
    );
    expect(container.innerHTML).not.toMatch(/PRIVATE KEY-----\n/);
  });

  it("says when nothing is set, and shows an encryption-key problem and unreadable secrets", () => {
    render(
      <GithubSettingsForm
        initial={{
          ...EMPTY,
          problems: {
            ...EMPTY.problems,
            encryptionKey: "SETTINGS_ENCRYPTION_KEY: is not set",
            unreadable: ["github_webhook_secret"],
          },
        }}
      />,
    );
    expect(screen.getByTestId("settings-private-key-state").textContent).toBe("Not set.");
    expect(screen.getByTestId("settings-key-problem").textContent).toContain(
      "SETTINGS_ENCRYPTION_KEY: is not set",
    );
    expect(screen.getByTestId("settings-unreadable")).toBeTruthy();
  });

  it("shows the repository list only when a list mode is chosen", () => {
    render(<GithubSettingsForm initial={EMPTY} />);
    expect(screen.queryByLabelText("Repositories to show")).toBeNull();
    click(screen.getByLabelText("Only these repositories"));
    expect(screen.getByLabelText("Repositories to show")).toBeTruthy();
    click(screen.getByLabelText("All except these repositories"));
    expect(screen.getByLabelText("Repositories to leave out")).toBeTruthy();
  });

  it("labels every control and uses native, tabbable elements", () => {
    const { container } = render(<GithubSettingsForm initial={CONFIGURED} />);
    for (const el of container.querySelectorAll("input, textarea, select")) {
      const id = el.getAttribute("id");
      const labelled =
        (id && container.querySelector(`label[for="${id}"]`)) || el.closest("label") !== null;
      expect(labelled, el.outerHTML.slice(0, 120)).toBeTruthy();
    }
    expect(container.querySelector("[tabindex]")).toBeNull();
    expect(result().getAttribute("role")).toBe("status");
  });
});

describe("GithubSettingsForm: connection summary", () => {
  it("says what is missing before anything is set", () => {
    render(<GithubSettingsForm initial={EMPTY} />);
    expect(screen.getByTestId("settings-connection-state").textContent).toBe("not ready to sync");
    const text = screen.getByTestId("settings-connection").textContent ?? "";
    for (const label of ["App ID", "Installation ID", "Private key", "Webhook secret"]) {
      expect(text, label).toContain(label);
    }
    expect(text.match(/missing/g)).toHaveLength(4);
  });

  it("is ready once the ids and the key are set, whether or not a webhook secret is", () => {
    render(
      <GithubSettingsForm
        initial={{
          ...CONFIGURED,
          secrets: {
            ...CONFIGURED.secrets,
            github_webhook_secret: { set: false, updatedAt: null },
          },
        }}
      />,
    );
    expect(screen.getByTestId("settings-connection-state").textContent).toBe("ready to sync");
    expect(
      (screen.getByTestId("settings-connection").textContent ?? "").match(/missing/g),
    ).toHaveLength(1);
  });

  it("follows a save: the new view replaces the summary", async () => {
    fetchMock.mockResolvedValue(json(CONFIGURED));
    render(<GithubSettingsForm initial={EMPTY} />);
    save();
    await waitFor(() =>
      expect(screen.getByTestId("settings-connection-state").textContent).toBe("ready to sync"),
    );
  });
});

describe("GithubSettingsForm: saving", () => {
  it("sends the version it was loaded from, the full settings and only the secrets typed", async () => {
    fetchMock.mockResolvedValue(json({ ...CONFIGURED, version: 6 }));
    render(<GithubSettingsForm initial={CONFIGURED} />);
    type(screen.getByLabelText("App ID"), "999");
    type(screen.getByLabelText("Private key (PEM)"), PEM);
    save();
    await waitFor(() => expect(result().textContent).toMatch(/^Saved\./));
    const body = sent();
    expect(body.expectedVersion).toBe(5);
    expect(body.settings.github).toEqual({ appId: 999, installationId: 456 });
    expect(body.settings.repos).toEqual(["api", { name: "web", docsPath: "guide" }]);
    expect(body.secrets).toEqual({ github_private_key: PEM });
    expect(refresh).toHaveBeenCalled();
    // The typed secret is gone from the form after a successful save.
    expect((screen.getByLabelText("Private key (PEM)") as HTMLTextAreaElement).value).toBe("");
  });

  it("shows the AI agent switch on by default and saves it when it is turned off", async () => {
    fetchMock.mockResolvedValue(json(EMPTY));
    render(<GithubSettingsForm initial={EMPTY} />);
    const toggle = screen.getByLabelText(
      "Allow AI agents to read the documentation over MCP",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText(/the \/api\/mcp endpoint, the AI agent access page/)).toBeDefined();
    click(toggle);
    save();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent().settings.mcp).toEqual({ enabled: false });
  });

  it("loads the AI agent switch from the stored settings", () => {
    const off: SettingsView = {
      ...CONFIGURED,
      settings: configSchema.parse({ ...CONFIGURED.settings, mcp: { enabled: false } }),
    };
    render(<GithubSettingsForm initial={off} />);
    expect(
      (
        screen.getByLabelText(
          "Allow AI agents to read the documentation over MCP",
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it("leaves empty secret fields out (keep) and sends null for Clear", async () => {
    // A fresh Response per call: a body can be read only once.
    fetchMock.mockImplementation(async () => json(CONFIGURED));
    render(<GithubSettingsForm initial={CONFIGURED} />);
    save();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent().secrets).toEqual({});

    fetchMock.mockClear();
    const clears = screen.getAllByLabelText("Clear this value when I save");
    click(clears[1]!);
    save();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent().secrets).toEqual({ github_webhook_secret: null });
  });

  it("sends exclusions, not repos, in the leave-out mode", async () => {
    fetchMock.mockResolvedValue(json(EMPTY));
    render(<GithubSettingsForm initial={EMPTY} />);
    click(screen.getByLabelText("All except these repositories"));
    type(screen.getByLabelText("Repositories to leave out"), "sandbox\nscratch");
    save();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sent().settings.exclude).toEqual(["sandbox", "scratch"]);
    expect(sent().settings.repos).toBeUndefined();
  });

  it("names a bad number or list line and does not call the server", async () => {
    render(<GithubSettingsForm initial={EMPTY} />);
    type(screen.getByLabelText("App ID"), "twelve");
    click(screen.getByLabelText("Only these repositories"));
    type(screen.getByLabelText("Repositories to show"), "api color=red");
    save();
    const list = await screen.findByTestId("settings-problems");
    expect(list.textContent).toContain("App ID must be a whole number.");
    expect(list.textContent).toContain('Line 1: "color" is not understood.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists the problems the server names and keeps the form", async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: "The settings are not valid",
          problems: [
            "limits.maxFileBytes: maxFileBytes must be at least 1024",
            "GitHub webhook secret: must be at least 16 characters",
          ],
        },
        400,
      ),
    );
    render(<GithubSettingsForm initial={CONFIGURED} />);
    type(screen.getByLabelText("Webhook secret"), "short");
    save();
    const list = await screen.findByTestId("settings-problems");
    expect(list.textContent).toContain("limits.maxFileBytes");
    expect(list.textContent).not.toContain("short\n");
    expect((screen.getByLabelText("App ID") as HTMLInputElement).value).toBe("123");
  });

  it("reports a conflict and stops saving until the page is reloaded", async () => {
    fetchMock.mockResolvedValue(
      json(
        { error: "The settings changed since you opened this page. Reload it.", code: "conflict" },
        409,
      ),
    );
    render(<GithubSettingsForm initial={CONFIGURED} />);
    save();
    await waitFor(() => expect(result().textContent).toContain("changed since you opened"));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });
});

describe("GithubSettingsForm: testing the connection", () => {
  it("sends the submitted values and reports the repository count", async () => {
    fetchMock.mockResolvedValue(json({ result: "ok", repositories: 12 }));
    render(<GithubSettingsForm initial={CONFIGURED} />);
    type(screen.getByLabelText("Private key (PEM)"), PEM);
    click(screen.getByRole("button", { name: "Test GitHub connection" }));
    await waitFor(() =>
      expect(result().textContent).toBe(
        "Test passed: the installation can access 12 repositories.",
      ),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/settings/test");
    expect(sent()).toEqual({ appId: 123, installationId: 456, privateKey: PEM });
  });

  it.each([
    ["rejected", /rejected the App credentials/],
    ["not_found", /did not find that installation/],
    ["unavailable", /could not be reached/],
    ["timeout", /did not answer in time/],
  ])("maps %s to a fixed message", async (word, pattern) => {
    fetchMock.mockResolvedValue(json({ result: word }));
    render(<GithubSettingsForm initial={CONFIGURED} />);
    click(screen.getByRole("button", { name: "Test GitHub connection" }));
    await waitFor(() => expect(result().textContent).toMatch(pattern));
  });

  it("says when to try again after a rate limit", async () => {
    fetchMock.mockResolvedValue(json({ error: "Too many tests", retryAfterSeconds: 42 }, 429));
    render(<GithubSettingsForm initial={CONFIGURED} />);
    click(screen.getByRole("button", { name: "Test GitHub connection" }));
    await waitFor(() =>
      expect(result().textContent).toBe("Too many tests. Try again in 42 seconds."),
    );
  });

  it("never shows a secret in the result", async () => {
    fetchMock.mockResolvedValue(json({ result: "rejected" }));
    render(<GithubSettingsForm initial={CONFIGURED} />);
    type(screen.getByLabelText("Webhook secret"), WEBHOOK);
    click(screen.getByRole("button", { name: "Test GitHub connection" }));
    await waitFor(() => expect(result().textContent).toMatch(/rejected/));
    expect(result().textContent).not.toContain(WEBHOOK);
  });
});
