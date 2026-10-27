// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SetupGuide } from "./setup-guide";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const dialog = () => screen.getByTestId("onboarding-dialog") as HTMLDialogElement;
const info = () => screen.getByRole("button", { name: "Setup instructions" });

describe("SetupGuide: the info button", () => {
  it("is a labelled button that stays closed until it is pressed", () => {
    render(<SetupGuide autoOpen={false} encryptionKeyProblem={null} />);
    expect(info().getAttribute("aria-haspopup")).toBe("dialog");
    expect(dialog().hasAttribute("open")).toBe(false);
    fireEvent.click(info());
    expect(dialog().hasAttribute("open")).toBe(true);
    expect(screen.getByRole("heading", { name: "Connect DocMyRepos to GitHub" })).toBeTruthy();
  });

  it("opens again after being closed, as often as asked", () => {
    render(<SetupGuide autoOpen={false} encryptionKeyProblem={null} />);
    for (let i = 0; i < 2; i++) {
      fireEvent.click(info());
      expect(dialog().hasAttribute("open")).toBe(true);
      fireEvent.click(screen.getByTestId("onboarding-skip"));
      expect(dialog().hasAttribute("open")).toBe(false);
    }
  });
});

describe("SetupGuide: first run", () => {
  it("opens on its own when asked to", () => {
    render(<SetupGuide autoOpen encryptionKeyProblem={null} />);
    expect(dialog().hasAttribute("open")).toBe(true);
    expect(dialog().getAttribute("aria-labelledby")).toBe("setup-guide-title");
  });
});

describe("SetupGuide: the instructions", () => {
  it("lists the steps to take on GitHub, with the real settings", () => {
    render(<SetupGuide autoOpen encryptionKeyProblem={null} />);
    const steps = screen.getByTestId("setup-guide-github-steps");
    expect(steps.querySelectorAll("li").length).toBeGreaterThanOrEqual(7);
    const text = steps.textContent ?? "";
    for (const word of [
      "Developer settings",
      "Webhook",
      "Active",
      "Contents",
      "Metadata",
      "Push",
      "Repository",
      "Create GitHub App",
      "App ID",
      "Generate a private key",
      "Installation ID",
    ]) {
      expect(text, word).toContain(word);
    }
  });

  it("lists what to do in the app", () => {
    render(<SetupGuide autoOpen encryptionKeyProblem={null} />);
    const text = screen.getByTestId("setup-guide-here-steps").textContent ?? "";
    for (const word of ["Test GitHub connection", "Save", "/api/sync", "webhook secret"]) {
      expect(text, word).toContain(word);
    }
  });

  it("shows this site's own address as the webhook URL once it is known", async () => {
    render(<SetupGuide autoOpen={false} encryptionKeyProblem={null} />);
    expect(screen.getByTestId("setup-guide-webhook-url").textContent).toBe(
      `${window.location.origin}/api/webhooks/github`,
    );
  });
});

describe("SetupGuide: the encryption key notice", () => {
  it("appears only when there is a problem with the key", () => {
    const { rerender } = render(<SetupGuide autoOpen={false} encryptionKeyProblem={null} />);
    expect(screen.queryByTestId("onboarding-key-problem")).toBeNull();
    rerender(
      <SetupGuide autoOpen={false} encryptionKeyProblem="SETTINGS_ENCRYPTION_KEY: is not set" />,
    );
    expect(screen.getByTestId("onboarding-key-problem").textContent).toContain(
      "SETTINGS_ENCRYPTION_KEY: is not set",
    );
  });
});

describe("SetupGuide: closing", () => {
  it.each([["onboarding-start"], ["onboarding-skip"]])("closes with %s", (id) => {
    render(<SetupGuide autoOpen encryptionKeyProblem={null} />);
    fireEvent.click(screen.getByTestId(id));
    expect(dialog().hasAttribute("open")).toBe(false);
  });

  it("moves focus to the App ID field when setup starts", () => {
    render(
      <>
        <input data-testid="settings-app-id" />
        <SetupGuide autoOpen encryptionKeyProblem={null} />
      </>,
    );
    fireEvent.click(screen.getByTestId("onboarding-start"));
    expect(document.activeElement).toBe(screen.getByTestId("settings-app-id"));
  });
});
