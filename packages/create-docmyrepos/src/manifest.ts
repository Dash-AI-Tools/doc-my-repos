import { MANIFEST_TEMPLATE_JSON } from "./manifest-template.generated.js";

/** Path the app serves its GitHub webhook on. */
export const WEBHOOK_PATH = "/api/webhooks/github";
/** GitHub limits App names to 34 characters. */
const MAX_APP_NAME = 34;

export interface GithubAppManifest {
  readonly name: string;
  readonly url: string;
  readonly hook_attributes: { readonly url: string; readonly active: boolean };
  readonly redirect_url: string;
  readonly public: false;
  readonly default_permissions: { readonly contents: "read"; readonly metadata: "read" };
  readonly default_events: readonly string[];
}

export interface ManifestTemplate {
  readonly default_permissions: Readonly<Record<string, string>>;
  readonly default_events: readonly string[];
  readonly public: boolean;
}

export interface ManifestInput {
  readonly organization: string;
  /** The portal's normalized origin, for example `https://docs.example.com`. */
  readonly portalUrl: string;
  /** Where GitHub sends the browser after creation (the loopback callback). */
  readonly redirectUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses the bundled template and refuses anything other than the read-only, private shape. */
export function parseManifestTemplate(json: string): ManifestTemplate {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new Error("The manifest template is not an object.");
  const permissions = parsed.default_permissions;
  const events = parsed.default_events;
  if (
    !isRecord(permissions) ||
    Object.keys(permissions).sort().join() !== "contents,metadata" ||
    permissions.contents !== "read" ||
    permissions.metadata !== "read"
  ) {
    throw new Error(
      "The manifest template must request exactly contents: read and metadata: read.",
    );
  }
  if (parsed.public !== false) throw new Error("The manifest template must not be public.");
  if (!Array.isArray(events) || !events.every((e): e is string => typeof e === "string")) {
    throw new Error("The manifest template has no valid event list.");
  }
  return {
    default_permissions: { contents: "read", metadata: "read" },
    default_events: events,
    public: false,
  };
}

/** True for an `https` address on a public host: the only case where the webhook can work. */
export function isPublicHttpsAddress(portalUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(portalUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "[::1]" || host.startsWith("[")) return false;
  if (!host.includes(".")) return false;
  const octets = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (octets !== null) {
    const a = Number(octets[1]);
    const b = Number(octets[2]);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
}

export function buildManifestFrom(
  template: ManifestTemplate,
  input: ManifestInput,
): GithubAppManifest {
  const webhookActive = isPublicHttpsAddress(input.portalUrl);
  return {
    name: `DocMyRepos (${input.organization})`.slice(0, MAX_APP_NAME),
    url: input.portalUrl,
    hook_attributes: { url: `${input.portalUrl}${WEBHOOK_PATH}`, active: webhookActive },
    redirect_url: input.redirectUrl,
    public: false,
    default_permissions: { contents: "read", metadata: "read" },
    default_events: [...template.default_events],
  };
}

let template: ManifestTemplate | undefined;

/** The manifest to send to GitHub, built from `docs/github-app-manifest.json` as bundled. */
export function buildManifest(input: ManifestInput): GithubAppManifest {
  template ??= parseManifestTemplate(MANIFEST_TEMPLATE_JSON);
  return buildManifestFrom(template, input);
}
