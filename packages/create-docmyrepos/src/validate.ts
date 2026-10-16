/**
 * Answer validators. Small re-implementations of the rules the app enforces at startup
 * (`src/server/config/env.ts`); `tests/unit/installer-agreement.test.ts` proves they agree.
 * Reasons are plain sentences and never include the value (it may be a secret).
 */

export type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T>(value: T): Check<T> => ({ ok: true, value });
const fail = (reason: string): Check<never> => ({ ok: false, reason });

/** Shortest accepted shared secret, as in the app (`MIN_SECRET_LENGTH`). */
export const MIN_SECRET_LENGTH = 16;
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

/** GitHub organization or user login: 1-39 letters, digits and single hyphens, not at either end. */
export function validateOrganization(input: string): Check<string> {
  const value = input.trim();
  if (value === "") return fail("Enter the GitHub organization name.");
  if (value.length > 39) return fail("A GitHub name has at most 39 characters.");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/.test(value)) {
    return fail(
      "Use only letters, digits and single hyphens, and do not start or end with a hyphen.",
    );
  }
  return ok(value);
}

export interface Address {
  /** Normalized origin without a trailing slash, for example `https://docs.example.com`. */
  readonly url: string;
  /** `localhost`, `*.localhost`, `127.x.x.x` or `[::1]`. */
  readonly loopback: boolean;
  /** Set when the address is valid but needs attention (a public address needs TLS in front). */
  readonly warning?: string;
}

export function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "[::1]") return true;
  return /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(hostname);
}

/** The address the portal is reached at. Plain `http` is only allowed for loopback hosts. */
export function validateAddress(input: string): Check<Address> {
  const value = input.trim();
  if (value === "") return fail("Enter the address, for example http://localhost:3000.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("That is not a valid address. Start with http:// or https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("The address must start with http:// or https://.");
  }
  if (url.hostname === "") return fail("The address needs a host name.");
  if (url.username !== "" || url.password !== "") {
    return fail("Do not put a user name or password in the address.");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return fail("Use the address without a path, query or fragment.");
  }
  const loopback = isLoopbackHost(url.hostname);
  if (!loopback && url.protocol === "http:") {
    return fail(
      "A public address needs https. Put a TLS reverse proxy in front and use its https address.",
    );
  }
  const normalized = `${url.protocol}//${url.host}`;
  return ok(
    loopback
      ? { url: normalized, loopback }
      : {
          url: normalized,
          loopback,
          warning:
            "The portal does not terminate TLS itself: put a TLS reverse proxy in front of it for this address.",
        },
  );
}

/** A TCP port, from a number or a string of digits. */
export function validatePort(input: string | number): Check<number> {
  const text = typeof input === "number" ? String(input) : input.trim();
  if (!/^\d{1,5}$/.test(text)) return fail("Enter a port number between 1 and 65535.");
  const port = Number(text);
  if (port < 1 || port > 65535) return fail("Enter a port number between 1 and 65535.");
  return ok(port);
}

// Same pattern as zod 4's `z.string().email()`, which the app uses for ADMIN_EMAIL.
const EMAIL =
  /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

export function validateEmail(input: string): Check<string> {
  const value = input.trim();
  if (value === "") return fail("Enter an email address.");
  if (value.length > 254 || !EMAIL.test(value)) {
    return fail("That is not a valid email address, for example admin@example.com.");
  }
  return ok(value);
}

/**
 * The first administrator's password. At least 12 characters (as the app requires). Leading and
 * trailing spaces, line breaks and single quotes are refused: the app trims environment values and
 * the value is written to `.env` between single quotes.
 */
export function validatePassword(input: string): Check<string> {
  if (input.length < MIN_PASSWORD_LENGTH) {
    return fail(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (input.length > MAX_PASSWORD_LENGTH) {
    return fail(`The password can have at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (input !== input.trim()) {
    return fail("The password must not start or end with a space.");
  }
  if (/[\u0000-\u001f\u007f']/.test(input)) {
    return fail("The password must not contain a single quote or a line break.");
  }
  return ok(input);
}

/** GitHub repository name without the owner, as accepted by `docmyrepos.config.yml`. */
export function validateRepositoryName(input: string): Check<string> {
  const value = input.trim();
  if (value === "") return fail("A repository name must not be empty.");
  if (value.length > 100) return fail("A repository name has at most 100 characters.");
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    return fail(
      "Use bare repository names (letters, digits, '.', '_' and '-') without the owner prefix.",
    );
  }
  if (value === "." || value === "..") return fail("That is not a valid repository name.");
  return ok(value);
}

/** A list of bare repository names: at least one, no duplicates (compared exactly, as the app does). */
export function validateRepositoryNames(inputs: readonly string[]): Check<string[]> {
  if (inputs.length === 0) return fail("Choose at least one repository.");
  const names: string[] = [];
  for (const input of inputs) {
    const checked = validateRepositoryName(input);
    if (!checked.ok) return checked;
    if (names.includes(checked.value)) return fail("A repository is listed twice.");
    names.push(checked.value);
  }
  return ok(names);
}

/** A comma-separated `--repos a,b,c` value. */
export function parseRepositoryList(input: string): Check<string[]> {
  return validateRepositoryNames(input.split(",").map((part) => part.trim()));
}

const PLACEHOLDER_SECRET = /^replace-with-/i;

/** A shared secret (webhook, sync, session): trimmed, at least 16 characters, not a placeholder. */
export function validateSharedSecret(input: string): Check<string> {
  const value = input.trim();
  if (value === "") return fail("The secret is empty.");
  if (value.length < MIN_SECRET_LENGTH) {
    return fail(`The secret needs at least ${MIN_SECRET_LENGTH} characters.`);
  }
  if (PLACEHOLDER_SECRET.test(value)) return fail("The secret is a placeholder value.");
  return ok(value);
}

/** GitHub App id or installation id: a positive integer. */
export function validateNumericId(input: string): Check<number> {
  const value = input.trim();
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return fail("Enter a positive whole number.");
  }
  return ok(Number(value));
}

/** A Docker image tag (also the installer version). */
export function validateImageTag(input: string): Check<string> {
  const value = input.trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    return fail("An image tag has letters, digits, '_', '.' and '-', and at most 128 characters.");
  }
  return ok(value);
}
