// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveBrandTokens } from "@/lib/branding/colors";
import type { BrandingSettings } from "@/server/branding";

import { BrandingForm } from "./branding-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<typeof fetch>();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const DEFAULTS: BrandingSettings = {
  orgName: null,
  pageTitle: null,
  primaryColor: null,
  accentColor: null,
  coloredHeader: false,
  invertLogoOnDark: true,
  logoVersion: 0,
  hasLogo: false,
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

describe("branding form", () => {
  it("renders every control", () => {
    render(<BrandingForm initial={DEFAULTS} />);
    expect(screen.getByLabelText("Organization name")).toBeDefined();
    expect(screen.getByLabelText("Page title")).toBeDefined();
    expect(screen.getByLabelText("Primary color hex")).toBeDefined();
    expect(screen.getByLabelText("Accent color hex")).toBeDefined();
    expect(screen.getByLabelText("Primary color picker")).toBeDefined();
    expect(screen.getByLabelText("Color the top bar with the primary color")).toBeDefined();
    expect(screen.getByLabelText("Invert logo in dark theme")).toBeDefined();
    expect(screen.getByLabelText("Logo file")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Reset to defaults" })).toBeDefined();
  });

  it("shows validation messages without saving", async () => {
    render(<BrandingForm initial={DEFAULTS} />);
    fireEvent.change(screen.getByLabelText("Primary color hex"), { target: { value: "red" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("color must be exactly #rrggbb")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the form state when the save fails", async () => {
    render(<BrandingForm initial={DEFAULTS} />);
    fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText("Primary color hex"), { target: { value: "#2b59ff" } });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "color must be exactly #rrggbb", field: "accentColor" }, 400),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("color must be exactly #rrggbb")).toBeDefined();
    expect((screen.getByLabelText("Organization name") as HTMLInputElement).value).toBe("Acme");
    expect((screen.getByLabelText("Primary color hex") as HTMLInputElement).value).toBe("#2b59ff");
  });

  it("resets to defaults", async () => {
    render(
      <BrandingForm
        initial={{ ...DEFAULTS, orgName: "Acme", primaryColor: "#2b59ff", coloredHeader: true }}
      />,
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ branding: DEFAULTS }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() => {
      expect((screen.getByLabelText("Organization name") as HTMLInputElement).value).toBe("");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/branding", { method: "DELETE" });
    expect(await screen.findByText("Reset to defaults.")).toBeDefined();
  });

  it("previews the derived link color when it differs from the chosen one", () => {
    render(<BrandingForm initial={DEFAULTS} />);
    fireEvent.change(screen.getByLabelText("Primary color hex"), { target: { value: "#fef08a" } });
    fireEvent.change(screen.getByLabelText("Accent color hex"), { target: { value: "#fef08a" } });
    const expected = deriveBrandTokens({ primary: "#fef08a", accent: "#fef08a" }).light["link"];
    expect(expected).not.toBe("#fef08a");
    const link = screen.getByTestId("branding-preview-light-link");
    const rgb = `rgb(${parseInt((expected ?? "").slice(1, 3), 16)}, ${parseInt((expected ?? "").slice(3, 5), 16)}, ${parseInt((expected ?? "").slice(5, 7), 16)})`;
    expect(link.style.color).toBe(rgb);
  });

  it("inverts the preview logo in the dark panel only when the switch is on", () => {
    render(
      <BrandingForm
        initial={{
          ...DEFAULTS,
          primaryColor: "#2b59ff",
          accentColor: "#2b59ff",
          hasLogo: true,
          logoVersion: 2,
        }}
      />,
    );
    const darkLogo = screen.getByTestId("branding-preview-dark-logo");
    const lightLogo = screen.getByTestId("branding-preview-light-logo");
    expect(darkLogo.style.filter).toBe("invert(1)");
    expect(lightLogo.style.filter).toBe("none");
    fireEvent.click(screen.getByLabelText("Invert logo in dark theme"));
    expect(screen.getByTestId("branding-preview-dark-logo").style.filter).toBe("none");
  });
});
