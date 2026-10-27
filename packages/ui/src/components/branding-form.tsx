"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { deriveBrandTokens } from "@docmyrepos/core/internal/branding/colors";
import { brandStyleBlock } from "@docmyrepos/core/internal/branding/style";
import {
  parseBrandColor,
  parseOrgName,
  parsePageTitle,
  COLOR_INPUT_FALLBACK,
} from "@docmyrepos/core/internal/branding/validate";
import { fieldClass } from "@docmyrepos/core/internal/ui";
import type { BrandingSettings } from "@docmyrepos/server/internal/branding/index";

/** Field-level problems, keyed by field. */
type FieldErrors = Partial<
  Record<"orgName" | "pageTitle" | "primaryColor" | "accentColor" | "logo", string>
>;

/** Live preview of the bar, a button, a link, a badge and the logo in one theme. */
function BrandPreview({
  theme,
  name,
  bar,
  button,
  link,
  badge,
  logoSrc,
  logoFilter,
  testId,
  surface,
}: {
  theme: "light" | "dark";
  /** The name shown in the bar: the organization name, or a sample until one is typed. */
  name: string;
  bar: { background: string; foreground: string };
  button: { background: string; foreground: string };
  link: string;
  badge: { background: string; foreground: string };
  logoSrc: string | null;
  logoFilter: string;
  testId: string;
  /** The derived dark page surface, so the dark preview sits on the tinted background. */
  surface?: { background: string; foreground: string };
}) {
  const stage = (
    <div
      className="overflow-hidden rounded-md border border-border"
      data-testid={testId}
      style={
        surface ? { backgroundColor: surface.background, color: surface.foreground } : undefined
      }
    >
      <div
        className="flex items-center gap-2 px-4 py-3 text-sm font-bold"
        style={{ backgroundColor: bar.background, color: bar.foreground }}
      >
        {logoSrc ? (
          // A plain img: this previews the logo as stored or as picked, a blob or data URL that
          // next/image cannot optimize.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoSrc}
            alt=""
            className="h-6 max-w-32 object-contain"
            style={{ filter: logoFilter }}
            data-testid={`${testId}-logo`}
          />
        ) : null}
        <span className="min-w-0 truncate">{name}</span>
      </div>
      <div className="flex flex-wrap items-center gap-4 px-4 py-4">
        <span
          className="rounded-md px-3 py-1.5 text-sm font-medium"
          style={{ backgroundColor: button.background, color: button.foreground }}
        >
          Button
        </span>
        <span
          className="text-sm underline underline-offset-4"
          style={{ color: link }}
          data-testid={`${testId}-link`}
        >
          Link
        </span>
        <span
          className="rounded-full px-2.5 py-0.5 text-xs"
          style={{ backgroundColor: badge.background, color: badge.foreground }}
        >
          Badge
        </span>
      </div>
    </div>
  );
  return theme === "dark" ? <div className="dark">{stage}</div> : stage;
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
    return parsed.ok && parsed.value !== null ? parsed.value : COLOR_INPUT_FALLBACK;
  }

  const light = derived?.light;
  const dark = derived?.dark;
  const fallbackBar = { background: "var(--background)", foreground: "var(--foreground)" };
  const fallbackButton = { background: "var(--primary)", foreground: "var(--primary-foreground)" };
  const fallbackBadge = { background: "var(--accent)", foreground: "var(--accent-foreground)" };

  const previewName = orgName.trim() === "" ? "Acme" : orgName.trim();

  return (
    <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <form onSubmit={onSave} className="flex max-w-lg flex-col gap-10">
        <section className="flex flex-col gap-5 border-t border-foreground pt-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-bold">Identity</h2>
            <p className="text-sm text-muted-foreground">
              What the portal calls itself: the fallback name beside the logo, and the browser tab
              title.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="branding-org-name" className="text-sm">
              Organization name
            </label>
            <input
              id="branding-org-name"
              aria-label="Organization name"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              maxLength={60}
              placeholder="Acme"
              className={fieldClass}
            />
            {errors.orgName ? (
              <p role="alert" className="text-sm text-destructive">
                {errors.orgName}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="branding-page-title" className="text-sm">
              Page title
            </label>
            <input
              id="branding-page-title"
              aria-label="Page title"
              value={pageTitle}
              onChange={(e) => setPageTitle(e.target.value)}
              maxLength={70}
              placeholder="Acme Docs"
              className={fieldClass}
            />
            {errors.pageTitle ? (
              <p role="alert" className="text-sm text-destructive">
                {errors.pageTitle}
              </p>
            ) : null}
          </div>
        </section>

        <section className="flex flex-col gap-5 border-t border-foreground pt-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-bold">Colors</h2>
            <p className="text-sm text-muted-foreground">
              Two brand colors. Every other shade, in both themes, is derived from them to keep its
              contrast. Leave a field empty to keep the portal default.
            </p>
          </div>
          {(
            [
              ["Primary color", primaryColor, setPrimaryColor, "primaryColor", errors.primaryColor],
              ["Accent color", accentColor, setAccentColor, "accentColor", errors.accentColor],
            ] as const
          ).map(([label, value, setValue, field, error]) => (
            <div key={field} className="flex flex-col gap-1.5">
              <label htmlFor={`branding-${field}-hex`} className="text-sm">
                {label}
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  aria-label={`${label} picker`}
                  value={colorValue(value)}
                  onChange={(e) => setValue(e.target.value)}
                  className="h-9 w-9 shrink-0 cursor-pointer rounded-sm border border-input bg-transparent p-1 [&::-moz-color-swatch]:rounded-[2px] [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-[2px] [&::-webkit-color-swatch]:border-0"
                />
                <input
                  id={`branding-${field}-hex`}
                  aria-label={`${label} hex`}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="#rrggbb"
                  className={fieldClass}
                />
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={coloredHeader}
                onChange={(e) => setColoredHeader(e.target.checked)}
                aria-describedby="branding-colored-header-hint"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span>Color the top bar with the primary color</span>
            </label>
            <p id="branding-colored-header-hint" className="pl-7 text-sm text-muted-foreground">
              Off, the bar keeps the page background and only the logo and title change.
            </p>
          </div>
        </section>

        <section className="flex flex-col gap-5 border-t border-foreground pt-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-bold">Logo</h2>
            <p className="text-sm text-muted-foreground">Shown beside the page title in the bar.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="branding-logo" className="text-sm">
              Logo
            </label>
            <input
              id="branding-logo"
              aria-label="Logo file"
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.svg"
              onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
              className="text-sm file:mr-4 file:cursor-pointer file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:border-foreground"
            />
            <p className="text-sm text-muted-foreground">
              PNG, JPEG, WebP or SVG, at most 512 KB.
              {logoFile ? ` Selected: ${logoFile.name}.` : hasLogo ? " A logo is set." : ""}
            </p>
            {errors.logo ? (
              <p role="alert" className="text-sm text-destructive">
                {errors.logo}
              </p>
            ) : null}
          </div>
          {hasLogo || logoFile !== null ? (
            <button
              type="button"
              onClick={onRemoveLogo}
              disabled={busy}
              className="w-fit rounded-md border border-input px-3 py-1.5 text-sm transition-colors hover:border-foreground disabled:opacity-50"
            >
              Remove logo
            </button>
          ) : null}
          <div className="flex flex-col gap-1">
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={invertLogo}
                onChange={(e) => setInvertLogo(e.target.checked)}
                aria-describedby="branding-invert-logo-hint"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span>Invert logo in dark theme</span>
            </label>
            <p id="branding-invert-logo-hint" className="pl-7 text-sm text-muted-foreground">
              Use for a dark logo drawn for a light background.
            </p>
          </div>
        </section>

        <div className="flex flex-col gap-3 border-t border-foreground pt-5">
          <div className="flex flex-wrap items-center gap-3">
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
              className="w-fit rounded-md border border-input px-4 py-2 transition-colors hover:border-foreground disabled:opacity-50"
            >
              Reset to defaults
            </button>
          </div>
          {message ? (
            <p role="status" className="text-sm text-muted-foreground">
              {message}
            </p>
          ) : null}
        </div>
      </form>

      <aside
        aria-label="Live preview"
        className="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start"
      >
        <div className="flex flex-col gap-1 border-t border-foreground pt-5">
          <h2 className="text-sm font-bold">Live preview</h2>
          <p className="text-sm text-muted-foreground">
            The bar, a button, a link and a badge, derived with the same rules the portal applies.
          </p>
        </div>
        <figure className="flex flex-col gap-2">
          <figcaption className="text-sm font-bold">Light</figcaption>
          <BrandPreview
            theme="light"
            name={previewName}
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
        </figure>
        <figure className="flex flex-col gap-2">
          <figcaption className="text-sm font-bold">Dark</figcaption>
          <BrandPreview
            theme="dark"
            name={previewName}
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
            surface={
              dark
                ? {
                    background: dark["background"] ?? "",
                    foreground: dark["foreground"] ?? "",
                  }
                : undefined
            }
          />
        </figure>
      </aside>
    </div>
  );
}
