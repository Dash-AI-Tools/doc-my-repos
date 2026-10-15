/**
 * Branding reads (org-branding 2.2). Server only: database access, no React components.
 * `getBranding` is per-request cached and never selects the logo bytes; invalid stored
 * values read as the default, so a bad row can never take the site down or reach the CSS.
 */

import { cache } from "react";

import { parseBrandColor, parseOrgName, parsePageTitle } from "@/lib/branding/validate";

import { getDb, type Db } from "../db/client";
import { siteBranding } from "../db/schema";

export interface BrandingSettings {
  readonly orgName: string | null;
  readonly pageTitle: string | null;
  readonly primaryColor: string | null;
  readonly accentColor: string | null;
  readonly coloredHeader: boolean;
  readonly invertLogoOnDark: boolean;
  readonly logoVersion: number;
  readonly hasLogo: boolean;
}

export const DEFAULT_BRANDING: BrandingSettings = {
  orgName: null,
  pageTitle: null,
  primaryColor: null,
  accentColor: null,
  coloredHeader: false,
  invertLogoOnDark: true,
  logoVersion: 0,
  hasLogo: false,
};

function validOrNull(
  parsed: { readonly ok: true; readonly value: string | null } | { readonly ok: false },
): string | null {
  return parsed.ok ? parsed.value : null;
}

async function readBranding(db: Db): Promise<BrandingSettings> {
  // Explicit column list: the logo bytes are never selected here (see `getLogo`).
  const rows = await db
    .select({
      orgName: siteBranding.orgName,
      pageTitle: siteBranding.pageTitle,
      primaryColor: siteBranding.primaryColor,
      accentColor: siteBranding.accentColor,
      coloredHeader: siteBranding.coloredHeader,
      invertLogoOnDark: siteBranding.invertLogoOnDark,
      logoType: siteBranding.logoType,
      logoVersion: siteBranding.logoVersion,
    })
    .from(siteBranding);
  const row = rows[0];
  if (!row) return DEFAULT_BRANDING;
  return {
    orgName: validOrNull(parseOrgName(row.orgName)),
    pageTitle: validOrNull(parsePageTitle(row.pageTitle)),
    primaryColor: validOrNull(parseBrandColor(row.primaryColor)),
    accentColor: validOrNull(parseBrandColor(row.accentColor)),
    coloredHeader: row.coloredHeader,
    invertLogoOnDark: row.invertLogoOnDark,
    logoVersion: row.logoVersion,
    hasLogo: row.logoType !== null,
  };
}

/** Portal branding for this request (cached): settings without the logo bytes. */
export const getBranding = cache(async (db: Db | null = null): Promise<BrandingSettings> => {
  return readBranding(db ?? getDb().db);
});

export interface BrandingLogo {
  readonly bytes: Buffer;
  readonly type: string;
  readonly version: number;
}

/** The stored logo bytes, or null when none. Uncached: uploads bump the version. */
export async function getLogo(db: Db | null = null): Promise<BrandingLogo | null> {
  const target = db ?? getDb().db;
  const rows = await target
    .select({
      logo: siteBranding.logo,
      logoType: siteBranding.logoType,
      logoVersion: siteBranding.logoVersion,
    })
    .from(siteBranding);
  const row = rows[0];
  if (!row || !row.logo || !row.logoType) return null;
  return { bytes: row.logo, type: row.logoType, version: row.logoVersion };
}
