/** Features the core can switch off per tenant through `checkEntitlement`. */
export const CORE_FEATURES = ["ask", "mcp", "comments"] as const;

export type CoreFeature = (typeof CORE_FEATURES)[number];

/** A core feature or a plugin's own feature name. */
export type Feature = CoreFeature | (string & {});
