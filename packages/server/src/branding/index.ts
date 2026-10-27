/**
 * Branding reads (org-branding 2.2). Server only: database access, no React components.
 * `getBranding` is per-request cached and never selects the logo bytes; invalid stored
 * values read as the default, so a bad row can never take the site down or reach the CSS.
 */

import { sql } from "drizzle-orm";
import { cache } from "react";

import type { TenantContext } from "@docmyrepos/core";
import {
  parseBrandColor,
  parseOrgName,
  parsePageTitle,
} from "@docmyrepos/core/internal/branding/validate";

import type { BlobStore, StoredBlob } from "../app/types";
import { CONTENT_TYPES } from "../assets/image-types";
import { resolveDb, type Db, type DbInput } from "../db/client";
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
  // Explicit column list: the logo bytes are never selected here (see `columnLogoStore`).
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
export const getBranding = cache(async (db: Db): Promise<BrandingSettings> => {
  return readBranding(db);
});

/** Uncached read for handlers: fresh after a write in the same request. */
export async function readBrandingSettings(db: Db): Promise<BrandingSettings> {
  return readBranding(db);
}

/** The blob name of the portal logo. */
export const LOGO_BLOB = "branding/logo";

/** The logo types, by the short name `site_branding.logo_type` holds. */
export const LOGO_CONTENT_TYPES = {
  png: CONTENT_TYPES.png,
  jpeg: CONTENT_TYPES.jpeg,
  webp: CONTENT_TYPES.webp,
  svg: CONTENT_TYPES.svg,
} as const;

export type LogoType = keyof typeof LOGO_CONTENT_TYPES;

/** The logo type of a MIME type, or null when it is not one. */
export function logoTypeOf(contentType: string): LogoType | null {
  const entry = Object.entries(LOGO_CONTENT_TYPES).find(([, mime]) => mime === contentType);
  return entry ? (entry[0] as LogoType) : null;
}

/** The logo file of one tenant, wherever its blob store keeps it. */
export interface LogoStore {
  get(): Promise<StoredBlob | null>;
  put(blob: StoredBlob): Promise<void>;
  delete(): Promise<void>;
}

/** The tenant's logo through a blob store. */
export function logoStoreOf(blobs: BlobStore, tenant: TenantContext): LogoStore {
  return {
    get: () => blobs.get(tenant, LOGO_BLOB),
    put: (blob) => blobs.put(tenant, LOGO_BLOB, blob),
    delete: () => blobs.delete(tenant, LOGO_BLOB),
  };
}

/**
 * The logo in the `site_branding` row, where it has always been stored: the default blob store's
 * `branding/logo`, and the store of code called without a request context.
 */
export function columnLogoStore(source: DbInput): LogoStore {
  return {
    async get() {
      const [row] = await (
        await resolveDb(source)
      )
        .select({ logo: siteBranding.logo, logoType: siteBranding.logoType })
        .from(siteBranding);
      const contentType = row?.logoType ? LOGO_CONTENT_TYPES[row.logoType as LogoType] : undefined;
      if (!row?.logo || contentType === undefined) return null;
      return { bytes: new Uint8Array(row.logo), contentType };
    },
    async put(blob) {
      const logoType = logoTypeOf(blob.contentType);
      if (logoType === null) throw new Error("The logo must be a PNG, JPEG, WebP or SVG image");
      const values = { logo: Buffer.from(blob.bytes), logoType, updatedAt: new Date() };
      await (
        await resolveDb(source)
      )
        .insert(siteBranding)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: siteBranding.id, set: values });
    },
    async delete() {
      await (
        await resolveDb(source)
      )
        .update(siteBranding)
        .set({ logo: null, logoType: null, updatedAt: new Date() });
    },
  };
}

/**
 * Records that the logo changed: its type (null once removed), which tells the pages there is
 * one, and a new `logoVersion`, which busts cached copies. The bytes are the blob store's.
 */
export async function recordLogoChange(db: Db, logoType: LogoType | null): Promise<void> {
  await db
    .insert(siteBranding)
    .values({ id: 1, logoType, logoVersion: 1, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: siteBranding.id,
      set: { logoType, logoVersion: sql`${siteBranding.logoVersion} + 1`, updatedAt: new Date() },
    });
}
