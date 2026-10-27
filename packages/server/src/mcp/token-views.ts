import "server-only";

import type { AdminTokenRow, TokenRow } from "@docmyrepos/core/internal/agent-access";

import { type Db } from "../db/client";
import { listAllTokens, listTokens, type TokenView } from "./tokens";

/**
 * The token rows the AI agent pages send to the browser: dates as ISO strings, and only what a
 * list shows (name, prefix, dates, status), never a token or a hash. Lives here, not in the page
 * files, because pages may not import the database layer (`packages/server/src/queries/enforcement.test.ts`).
 * Both throw when the database is unavailable; the pages show a fixed message.
 */

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

function row(token: TokenView): TokenRow {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt.toISOString(),
    lastUsedAt: iso(token.lastUsedAt),
    revokedAt: iso(token.revokedAt),
    status: token.status,
  };
}

/** A user's own tokens, newest first. */
export async function loadOwnTokenRows(userId: number, db: Db): Promise<TokenRow[]> {
  return (await listTokens(db, userId)).map(row);
}

/** Every user's tokens with the owner, newest first. For administrators only. */
export async function loadAllTokenRows(db: Db): Promise<AdminTokenRow[]> {
  return (await listAllTokens(db)).map((t) => ({ ...row(t), owner: t.owner }));
}
