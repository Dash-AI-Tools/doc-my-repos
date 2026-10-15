"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { deriveBrandTokens } from "@/lib/branding/colors";
import { brandStyleBlock } from "@/lib/branding/style";
import { parseBrandColor, parseOrgName, parsePageTitle } from "@/lib/branding/validate";
import type { BrandingSettings } from "@/server/branding";

/** Field-level problems, keyed by field. */
type FieldErrors = Partial<
  Record<"orgName" | "pageTitle" | "primaryColor" | "accentColor" | "logo", string>
>;

const inputClass = "rounded-md border border-input bg-background px-3 py-2";

/** Live preview of the bar, a button, a link, a badge and the logo in one theme. */
function BrandPreview({
  theme,
  bar,
  button,
  link,
  badge,
  logoSrc,
  logoFilter,
  testId,
}: {
  theme: "light" | "dark";
  bar: { background: string; foreground: string };
  button: { background: string; foreground: string };
  link: string;
  badge: { background: string; foreground: string };
  logoSrc: string | null;
  logoFilter: string;
  testId: string;
}) {
  const panel = (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid={testId}>
      <div
        className="flex items-center gap-2 rounded px-3 py-2 text-sm font-bold"
        style={{ backgroundColor: bar.background, color: bar.foreground }}
      >
        {logoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoSrc}
            alt=""
            className="h-6 max-w-32 object-contain"
            style={{ filter: logoFilter }}
            data-testid={`${testId}-logo`}
          />
        ) : null}
        <span>Acme</span>
      </div>
      <div className="flex items-center gap-3">
        <span
          className="rounded-md px-3 py-1 text-sm font-medium"
          style={{ backgroundColor: button.background, color: button.foreground }}
        >
          Button
        </span>
        <span className="text-sm underline" style={{ color: link }} data-testid={`${testId}-link`}>
          Link
        </span>
        <span
          className="rounded px-2 py-0.5 text-xs"
          style={{ backgroundColor: badge.background, color: badge.foreground }}
        >
          Badge
        </span>
      </div>
    </div>
  );
  return theme === "dark" ? <div className="dark">{panel}</div> : panel;
}

/**
 * Branding editor (org-branding 4.1): settings fields, logo upload, save/reset, and a live
 * preview in both themes derived with the same code the layout uses. A failed save keeps the
 * form state and names the field.
 */
export function BrandingForm({ initial }: { initial: BrandingSettings }) {
  const router = useRouter();
  const [orgName, setOrgName] = useState(initial.orgName ?? "");
  const [pageTitle, setPageTitle] = useState(initial.pageTitle ?? "");
  const [primaryColor, setPrimaryColor] = useState(initial.primaryColor ?? "");
  const [accentColor, setAccentColor] = useState(initial.accentColor ?? "");
  const [coloredHeader, setColoredHeader] = useState(initial.coloredHeader);
  const [invertLogo, setInvertLogo] = useState(initial.invertLogoOnDark);
  const [logoVersion, setLogoVersion] = useState(initial.logoVersion);
  const [hasLogo, setHasLogo] = useState(initial.hasLogo);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const derived = useMemo(() => {
    const primary = parseBrandColor(primaryColor);
    const accent = parseBrandColor(accentColor);
    if (!primary.ok || !accent.ok || primary.value === null || accent.value === null) {
      return null;
    }
    return deriveBrandTokens({ primary: primary.value, accent: accent.value });
  }, [primaryColor, accentColor]);

  // Keep the preview honest: the same style block the layout renders decides the inversion.
  const previewCss = useMemo(
    () =>
      brandStyleBlock(derived, {
        coloredHeader,
        invertLogo,
        hasLogo: hasLogo || logoFile !== null,
      }),
    [derived, coloredHeader, invertLogo, hasLogo, logoFile],
  );
  const darkInverts =
    previewCss.includes("html.dark{") && previewCss.includes("--logo-filter:invert(1);");
  const rootPart = previewCss.split("html.dark{")[0] ?? "";
  const lightInverts = rootPart.includes("--logo-filter:invert(1);");

  const logoSrc = useMemo(() => {
    if (logoFile !== null && typeof URL.createObjectURL === "function") {
      try {
        return URL.createObjectURL(logoFile);
      } catch {
        return null;
      }
    }
    return hasLogo ? `/api/branding/logo?v=${logoVersion}` : null;
  }, [logoFile, hasLogo, logoVersion]);

  function validate(): FieldErrors {
    const found: FieldErrors = {};
    const name = parseOrgName(orgName);
    if (!name.ok) found.orgName = name.error;
    const title = parsePageTitle(pageTitle);
    if (!title.ok) found.pageTitle = title.error;
    const primary = parseBrandColor(primaryColor);
    if (!primary.ok) found.primaryColor = primary.error;
    const accent = parseBrandColor(accentColor);
    if (!accent.ok) found.accentColor = accent.error;
    return found;
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgName: orgName.trim() === "" ? null : orgName,
          pageTitle: pageTitle.trim() === "" ? null : pageTitle,
          primaryColor: primaryColor.trim() === "" ? null : primaryColor,
          accentColor: accentColor.trim() === "" ? null : accentColor,
          coloredHeader,
          invertLogoOnDark: invertLogo,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        field?: string;
        branding?: BrandingSettings;
      };
      if (!response.ok) {
        if (typeof data.field === "string") {
          setErrors({ [data.field]: data.error ?? "Invalid value" } as FieldErrors);
        } else {
          setMessage(data.error ?? `Request failed (${response.status})`);
        }
        return;
      }
      if (logoFile !== null) {
        const upload = await fetch("/api/admin/branding/logo", {
          method: "PUT",
          body: logoFile,
        });
        if (!upload.ok) {
          const detail = (await upload.json().catch(() => ({}))) as { error?: string };
          setErrors({ logo: detail.error ?? `Upload failed (${upload.status})` });
          return;
        }
        setLogoFile(null);
      }
      const branding = data.branding;
      if (branding) {
        setLogoVersion(branding.logoVersion);
        setHasLogo(branding.hasLogo);
      }
      setMessage("Saved.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onRemoveLogo() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/branding/logo", { method: "DELETE" });
      if (!response.ok) {
        setMessage(`Remove failed (${response.status})`);
        return;
      }
      const data = (await response.json().catch(() => ({}))) as { branding?: BrandingSettings };
      setLogoFile(null);
      setHasLogo(false);
      if (data.branding) setLogoVersion(data.branding.logoVersion);
      setMessage("Logo removed.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onReset() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/branding", { method: "DELETE" });
      if (!response.ok) {
        setMessage(`Reset failed (${response.status})`);
        return;
      }
      setOrgName("");
      setPageTitle("");
      setPrimaryColor("");
      setAccentColor("");
      setColoredHeader(false);
      setInvertLogo(true);
      setLogoFile(null);
      setHasLogo(false);
      setLogoVersion(0);
      setErrors({});
      setMessage("Reset to defaults.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function colorValue(text: string): string {
    const parsed = parseBrandColor(text);
    return parsed.ok && parsed.value !== null ? parsed.value : "#000000";
  }

  const light = derived?.light;
  const dark = derived?.dark;
  const fallbackBar = { background: "var(--background)", foreground: "var(--foreground)" };
  const fallbackButton = { background: "var(--primary)", foreground: "var(--primary-foreground)" };
  const fallbackBadge = { background: "var(--accent)", foreground: "var(--accent-foreground)" };

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={onSave} className="flex max-w-md flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Organization name
          <input
            aria-label="Organization name"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            maxLength={60}
            className={inputClass}
          />
          {errors.orgName ? (
            <span role="alert" className="text-sm">
              {errors.orgName}
            </span>
          ) : null}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Page title
          <input
            aria-label="Page title"
            value={pageTitle}
            onChange={(e) => setPageTitle(e.target.value)}
            maxLength={70}
            className={inputClass}
          />
          {errors.pageTitle ? (
            <span role="alert" className="text-sm">
              {errors.pageTitle}
            </span>
          ) : null}
        </label>
        {(
          [
            ["Primary color", primaryColor, setPrimaryColor, "primaryColor", errors.primaryColor],
            ["Accent color", accentColor, setAccentColor, "accentColor", errors.accentColor],
          ] as const
        ).map(([label, value, setValue, field, error]) => (
          <fieldset key={field} className="flex flex-col gap-1 text-sm">
            <legend>{label}</legend>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label={`${label} picker`}
                value={colorValue(value)}
                onChange={(e) => setValue(e.target.value)}
                className="h-9 w-12"
              />
              <input
                aria-label={`${label} hex`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="#rrggbb"
                className={inputClass}
              />
            </div>
            {error ? (
              <span role="alert" className="text-sm">
                {error}
              </span>
            ) : null}
          </fieldset>
        ))}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={coloredHeader}
            onChange={(e) => setColoredHeader(e.target.checked)}
          />
          Color the top bar with the primary color
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={invertLogo}
            onChange={(e) => setInvertLogo(e.target.checked)}
          />
          Invert logo in dark theme
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Logo (PNG, JPEG, WebP or SVG, at most 512 KB)
          <input
            aria-label="Logo file"
            type="file"
            accept=".png,.jpg,.jpeg,.webp,.svg"
            onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
          />
          {errors.logo ? (
            <span role="alert" className="text-sm">
              {errors.logo}
            </span>
          ) : null}
        </label>
        {hasLogo || logoFile !== null ? (
          <button
            type="button"
            onClick={onRemoveLogo}
            disabled={busy}
            className="w-fit rounded-md border px-4 py-2 text-sm disabled:opacity-50"
          >
            Remove logo
          </button>
        ) : null}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="w-fit rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={onReset}
            disabled={busy}
            className="w-fit rounded-md border px-4 py-2 disabled:opacity-50"
          >
            Reset to defaults
          </button>
        </div>
      </form>

      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Preview</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Light</h3>
            <BrandPreview
              theme="light"
              bar={
                coloredHeader && light
                  ? {
                      background: light["header"] ?? "",
                      foreground: light["header-foreground"] ?? "",
                    }
                  : fallbackBar
              }
              button={
                light
                  ? {
                      background: light["primary"] ?? "",
                      foreground: light["primary-foreground"] ?? "",
                    }
                  : fallbackButton
              }
              link={light?.["link"] ?? "var(--link)"}
              badge={
                light
                  ? {
                      background: light["accent"] ?? "",
                      foreground: light["accent-foreground"] ?? "",
                    }
                  : fallbackBadge
              }
              logoSrc={logoSrc}
              logoFilter={lightInverts ? "invert(1)" : "none"}
              testId="branding-preview-light"
            />
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Dark</h3>
            <BrandPreview
              theme="dark"
              bar={
                coloredHeader && dark
                  ? {
                      background: dark["header"] ?? "",
                      foreground: dark["header-foreground"] ?? "",
                    }
                  : fallbackBar
              }
              button={
                dark
                  ? {
                      background: dark["primary"] ?? "",
                      foreground: dark["primary-foreground"] ?? "",
                    }
                  : fallbackButton
              }
              link={dark?.["link"] ?? "var(--link)"}
              badge={
                dark
                  ? {
                      background: dark["accent"] ?? "",
                      foreground: dark["accent-foreground"] ?? "",
                    }
                  : fallbackBadge
              }
              logoSrc={logoSrc}
              logoFilter={darkInverts ? "invert(1)" : "none"}
              testId="branding-preview-dark"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
