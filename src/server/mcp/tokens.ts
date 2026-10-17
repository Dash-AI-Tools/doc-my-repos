import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client";
import { apiTokens, users } from "../db/schema";

/**
 * Personal API tokens for the MCP endpoint (mcp-agent-access design decision 2, spec
 * `agent-tokens`). A token is a bearer secret: `dmr_` plus 32 random bytes in base64url. Only its
 * SHA-256 hash and the first characters (for display) are stored, so the full token exists only in
 * the answer to `createToken`; no other function here returns it, and no message or log line here
 * can contain one. The secret has 256 bits of entropy, so a fast hash is enough and lookups are an
 * equality probe on a unique index (nothing secret-dependent to time); the digests are still
 * compared in constant time after the fetch as defence in depth.
 *
 * A token acts as its user and nothing more: `verifyToken` joins `users` and rejects a disabled
 * user and a token created before the user's `tokens_valid_after` (set when a password is reset).
 * Rows that were revoked or expired more than `RETENTION_DAYS` ago are not listed and are deleted
 * when a token is created.
 */

export const TOKEN_PREFIX = "dmr_";
/** 32 random bytes in base64url (no padding) are 43 characters. */
const SECRET_LENGTH = 43;
const TOKEN_PATTERN = new RegExp(`^dmr_[A-Za-z0-9_-]{${SECRET_LENGTH}}$`);
const DISPLAY_PREFIX_LENGTH = 8;

export const MAX_ACTIVE_TOKENS = 10;
export const EXPIRY_CHOICES_DAYS = [30, 90, 365] as const;
export type ExpiryDays = (typeof EXPIRY_CHOICES_DAYS)[number];
export const MAX_NAME_LENGTH = 60;
export const RETENTION_DAYS = 30;
/** `last_used_at` is written at most this often per token, to keep authenticated reads cheap. */
export const LAST_USED_INTERVAL_SECONDS = 60;
/** Old rows removed per creation, so cleanup is bounded work spread over normal use. */
const CLEANUP_BATCH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const CONTROL = new RegExp("[\\p{Cc}\\p{Cf}\\u2028\\u2029]", "u");

export type TokenStatus = "active" | "expired" | "revoked";

/** What a list shows about a token. Never the token itself or its hash. */
export interface TokenView {
  readonly id: number;
  readonly name: string;
  /** The first characters after `dmr_`, enough to recognize a token in the list. */
  readonly prefix: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly status: TokenStatus;
}

export interface AdminTokenView extends TokenView {
  readonly owner: { readonly id: number; readonly email: string };
}

// ---------------------------------------------------------------------------------------------
// The token itself

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A fresh token with its hash and display prefix. The caller must show the token once and drop it. */
export function generateToken(): { token: string; hash: string; prefix: string } {
  const secret = randomBytes(32).toString("base64url");
  const token = `${TOKEN_PREFIX}${secret}`;
  return { token, hash: hashToken(token), prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH) };
}

/** True for a string shaped like a token. Checked before any database work. */
export function isWellFormedToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

function status(row: { revokedAt: Date | null; expiresAt: Date }, now: Date): TokenStatus {
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() <= now.getTime() ? "expired" : "active";
}

type TokenRow = typeof apiTokens.$inferSelect;

function view(row: TokenRow, now: Date): TokenView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    status: status(row, now),
  };
}

/** The moment a token stopped working: its revocation or its expiry, whichever came first. */
const endedAt = sql`least(coalesce(${apiTokens.revokedAt}, ${apiTokens.expiresAt}), ${apiTokens.expiresAt})`;
const stillListed: SQL = sql`${endedAt} > now() - make_interval(days => ${RETENTION_DAYS})`;

// ---------------------------------------------------------------------------------------------
// Create

export type CreateTokenInput = { readonly name: unknown; readonly expiryDays: unknown };

export type CreateTokenResult =
  | { readonly ok: true; readonly token: string; readonly view: TokenView }
  | {
      readonly ok: false;
      readonly status: 400 | 409;
      /** A fixed message naming the field or the limit. */
      readonly error: string;
    };

/** The name as stored: trimmed, 1 to 60 characters, plain text. Null when it is not acceptable. */
export function parseTokenName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_NAME_LENGTH) return null;
  return CONTROL.test(name) ? null : name;
}

function parseExpiry(value: unknown): ExpiryDays | null {
  return EXPIRY_CHOICES_DAYS.find((d) => d === value) ?? null;
}

/**
 * Creates a token for `userId` and returns the full token once. Refuses a bad name or expiry (400)
 * and an eleventh active token (409). The per-user limit is counted while holding the user's row
 * lock, so two simultaneous requests cannot both pass it. Old revoked and expired rows are purged.
 */
export async function createToken(
  db: Db,
  userId: number,
  input: CreateTokenInput,
  now: Date = new Date(),
): Promise<CreateTokenResult> {
  const name = parseTokenName(input.name);
  if (name === null) {
    return {
      ok: false,
      status: 400,
      error: `name: must be 1 to ${MAX_NAME_LENGTH} plain-text characters`,
    };
  }
  const days = parseExpiry(input.expiryDays);
  if (days === null) {
    return {
      ok: false,
      status: 400,
      error: `expiryDays: must be one of ${EXPIRY_CHOICES_DAYS.join(", ")}`,
    };
  }

  return db.transaction(async (tx): Promise<CreateTokenResult> => {
    // Serializes creations for one user; the row exists for any signed-in user.
    const locked = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (locked.length === 0) return { ok: false, status: 400, error: "user: not found" };

    const active = await tx
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.userId, userId),
          isNull(apiTokens.revokedAt),
          sql`${apiTokens.expiresAt} > ${now}`,
        ),
      );
    if (active.length >= MAX_ACTIVE_TOKENS) {
      return {
        ok: false,
        status: 409,
        error: `limit: at most ${MAX_ACTIVE_TOKENS} active tokens; revoke one first`,
      };
    }

    await tx.delete(apiTokens).where(
      inArray(
        apiTokens.id,
        tx
          .select({ id: apiTokens.id })
          .from(apiTokens)
          .where(sql`not (${stillListed})`)
          .limit(CLEANUP_BATCH),
      ),
    );

    const { token, hash, prefix } = generateToken();
    const [row] = await tx
      .insert(apiTokens)
      .values({
        userId,
        name,
        tokenHash: hash,
        prefix,
        expiresAt: new Date(now.getTime() + days * DAY_MS),
      })
      .returning();
    if (!row) return { ok: false, status: 400, error: "token could not be created" };
    return { ok: true, token, view: view(row, now) };
  });
}

// ---------------------------------------------------------------------------------------------
// List and revoke

/** A user's own tokens, newest first, including revoked and expired ones for 30 days. */
export async function listTokens(
  db: Db,
  userId: number,
  now: Date = new Date(),
): Promise<TokenView[]> {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), stillListed))
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
  return rows.map((row) => view(row, now));
}

/** Every user's tokens with their owner, for administrators. Newest first. */
export async function listAllTokens(db: Db, now: Date = new Date()): Promise<AdminTokenView[]> {
  const rows = await db
    .select({ token: apiTokens, ownerId: users.id, ownerEmail: users.email })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(stillListed)
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
  return rows.map((r) => ({
    ...view(r.token, now),
    owner: { id: r.ownerId, email: r.ownerEmail },
  }));
}

export interface TokenActor {
  readonly id: number;
  readonly role: "admin" | "user";
}

/**
 * Revokes a token: effective on the next request. A user can revoke only their own (another
 * user's token id is "not found"); an admin can revoke any. Revoking twice keeps the first time.
 */
export async function revokeToken(
  db: Db,
  tokenId: number,
  actor: TokenActor,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly status: 404 }> {
  const scope =
    actor.role === "admin"
      ? eq(apiTokens.id, tokenId)
      : and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, actor.id));
  const found = await db.select({ id: apiTokens.id }).from(apiTokens).where(scope).limit(1);
  if (found.length === 0) return { ok: false, status: 404 };
  await db
    .update(apiTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(apiTokens.id, tokenId), isNull(apiTokens.revokedAt)));
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Verify

export type VerifyFailure = "malformed" | "unknown" | "revoked" | "expired" | "disabled" | "reset";

export type VerifyResult =
  | {
      readonly ok: true;
      readonly tokenId: number;
      readonly user: {
        readonly id: number;
        readonly email: string;
        readonly role: "admin" | "user";
      };
    }
  | { readonly ok: false; readonly reason: VerifyFailure };

/**
 * Checks a presented bearer token. A caller answers 401 for every failure and may log the fixed
 * `reason` word, never the token. On success, `last_used_at` is refreshed at most once a minute
 * (a failure to write it never fails the request).
 */
export async function verifyToken(
  db: Db,
  presented: string,
  now: Date = new Date(),
): Promise<VerifyResult> {
  if (!isWellFormedToken(presented)) return { ok: false, reason: "malformed" };
  const hash = hashToken(presented);
  const rows = await db
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, hash))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "unknown" };
  if (!timingSafeEqual(Buffer.from(row.token.tokenHash, "hex"), Buffer.from(hash, "hex"))) {
    return { ok: false, reason: "unknown" };
  }
  if (row.token.revokedAt) return { ok: false, reason: "revoked" };
  if (row.token.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (row.user.disabled) return { ok: false, reason: "disabled" };
  const validAfter = row.user.tokensValidAfter;
  if (validAfter && row.token.createdAt.getTime() < validAfter.getTime()) {
    return { ok: false, reason: "reset" };
  }

  try {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          eq(apiTokens.id, row.token.id),
          sql`(${apiTokens.lastUsedAt} is null or ${apiTokens.lastUsedAt} < now() - make_interval(secs => ${LAST_USED_INTERVAL_SECONDS}))`,
        ),
      );
  } catch {
    // Bookkeeping only.
  }
  return {
    ok: true,
    tokenId: row.token.id,
    user: { id: row.user.id, email: row.user.email, role: row.user.role },
  };
}
