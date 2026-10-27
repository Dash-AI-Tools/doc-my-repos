/**
 * The portal's own origin as the caller reached it, for the links in tool results: from the proxy's
 * `X-Forwarded-Host` and `X-Forwarded-Proto` when they hold a plausible host and scheme, else from
 * the request URL. The caller is a token holder, so a forged header can only change the links in
 * that caller's own answers; the characters are still checked so it cannot add anything but a host.
 */

const HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

function first(value: string | null): string | null {
  const text = value?.split(",")[0]?.trim() ?? "";
  return text === "" ? null : text;
}

export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = first(request.headers.get("x-forwarded-host")) ?? url.host;
  const proto = first(request.headers.get("x-forwarded-proto"))?.toLowerCase();
  const scheme = proto === "http" || proto === "https" ? proto : url.protocol.slice(0, -1);
  return HOST.test(host) ? `${scheme}://${host.toLowerCase()}` : url.origin;
}
