/** The credential of an `Authorization: Bearer <token>` header, or null. */
export function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match === null ? null : (match[1] as string);
}
