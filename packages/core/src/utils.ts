/**
 * Joins class name fragments with single spaces, dropping falsy values
 * (`false`, `null`, `undefined` and empty strings) so callers can write
 * conditional classes inline.
 */
export function joinClassNames(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}
