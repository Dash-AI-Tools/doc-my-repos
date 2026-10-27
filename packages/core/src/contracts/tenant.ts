/**
 * The tenant a request or job runs for. The open-source app has exactly one, `DEFAULT_TENANT`; a
 * host app that serves several (for example one database per tenant) resolves them with its
 * `resolveTenant` and `listTenants` hooks.
 */
export interface TenantContext {
  /** Stable id: a lowercase slug of at most 63 characters (`TENANT_ID_PATTERN`). */
  readonly id: string;
  /** Host-defined attributes (plan, region, database name, ...). The core never reads them. */
  readonly attributes: Readonly<Record<string, unknown>>;
}

export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The id of the single built-in tenant. */
export const DEFAULT_TENANT_ID = "default";

export const DEFAULT_TENANT: TenantContext = Object.freeze({
  id: DEFAULT_TENANT_ID,
  attributes: Object.freeze({}),
});

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID_PATTERN.test(value);
}

export function isDefaultTenant(tenant: Pick<TenantContext, "id">): boolean {
  return tenant.id === DEFAULT_TENANT_ID;
}
