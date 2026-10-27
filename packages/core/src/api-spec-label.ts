/**
 * Text label of a stored spec's format and version, for badges and lists: "OpenAPI 3.1" for
 * `openapi` / "3.1.0", "Swagger 2.0" for `swagger` / "2.0". Only the major and minor numbers are
 * shown; a version string that has none is shown as stored. Always text, never colour alone.
 */
export function apiSpecFormatLabel(format: "openapi" | "swagger", specVersion: string): string {
  const name = format === "openapi" ? "OpenAPI" : "Swagger";
  const match = /^(\d+)\.(\d+)/.exec(specVersion);
  const version = match ? `${match[1]}.${match[2]}` : specVersion;
  return `${name} ${version}`.trim();
}
