import { formatAbsoluteTime } from "./time";

/**
 * Pure helpers for the AI agent access pages (mcp-agent-access spec `agent-tokens`, "Connection
 * help"): the connection snippets, and the display of a token row from the token APIs. No
 * secrets are produced here: a snippet carries `YOUR_TOKEN` unless the caller passes the token it
 * was just given, which only the creation panel does, in the browser.
 */

export const TOKEN_PLACEHOLDER = "YOUR_TOKEN";
export const MCP_PATH = "/api/mcp";
export const SERVER_NAME = "docmyrepos";

/** A token as the APIs send it (dates are ISO strings). Never the token itself. */
export interface TokenRow {
  readonly id: number;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly status: "active" | "expired" | "revoked";
}

export interface AdminTokenRow extends TokenRow {
  readonly owner: { readonly id: number; readonly email: string };
}

/** The MCP address for a portal origin, or the bare path while the origin is not known yet. */
export function mcpAddress(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${MCP_PATH}`;
}

export interface ConnectionSnippets {
  /** A shell command that registers the server with Claude Code. */
  readonly commandLine: string;
  /** A JSON block for agents configured by file (Cursor and similar). */
  readonly json: string;
}

/** Quotes for a POSIX shell: single quotes, with embedded quotes closed and reopened. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export function connectionSnippets(
  address: string,
  token: string = TOKEN_PLACEHOLDER,
): ConnectionSnippets {
  const header = `Authorization: Bearer ${token}`;
  return {
    commandLine: `claude mcp add --transport http ${SERVER_NAME} ${shellQuote(address)} --header ${shellQuote(header)}`,
    json: JSON.stringify(
      {
        mcpServers: {
          [SERVER_NAME]: { url: address, headers: { Authorization: `Bearer ${token}` } },
        },
      },
      null,
      2,
    ),
  };
}

/** `dmr_abcd1234…`: enough to recognize a token in the list. */
export function displayPrefix(prefix: string): string {
  return `dmr_${prefix}…`;
}

export function formatWhen(iso: string | null): string {
  if (iso === null) return "";
  return formatAbsoluteTime(new Date(iso));
}

export const STATUS_LABEL: Readonly<Record<TokenRow["status"], string>> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
};

export const EXPIRY_OPTIONS = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
] as const;
