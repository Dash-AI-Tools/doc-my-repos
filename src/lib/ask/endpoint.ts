/**
 * The rules for an OpenAI-compatible base URL (ai-provider-config "Endpoints must be secure"):
 * `https`, or `http` on a loopback address; no user name or password in the address. Pure, so the
 * settings schema, the admin form and the provider setup agree. Messages never include the value.
 */

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || LOOPBACK_V4.test(host);
}

export type EndpointCheck =
  | { readonly ok: true; readonly url: URL; readonly loopback: boolean }
  | { readonly ok: false; readonly problem: string };

export function checkOpenAiBaseUrl(raw: string): EndpointCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // The URL error carries the input; drop it.
    return { ok: false, problem: "is not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, problem: "must be an http(s) URL" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, problem: "must not contain a username or password; use the API key field" };
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    return {
      ok: false,
      problem: "must be an https URL (http is allowed only for localhost addresses)",
    };
  }
  return { ok: true, url, loopback };
}
