import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { hashPassword } from "@/server/auth/password";

export interface AdminUserView {
  id: number;
  email: string;
  role: "admin" | "user";
  disabled: boolean;
}

const emailSchema = z.string().trim().toLowerCase().email("must be a valid email").max(254);
const passwordSchema = z.string().min(12, "must be at least 12 characters").max(256);
const roleSchema = z.enum(["admin", "user"]);

function toView(row: typeof users.$inferSelect): AdminUserView {
  return { id: row.id, email: row.email, role: row.role, disabled: row.disabled };
}

/** All users, oldest first. Never includes password hashes. */
export async function listUsers(db: Db): Promise<AdminUserView[]> {
  const rows = await db.select().from(users).orderBy(asc(users.id));
  return rows.map(toView);
}

export interface CreateUserInput {
  email: unknown;
  password: unknown;
  role: unknown;
}

export type CreateUserResult =
  { ok: true; user: AdminUserView } | { ok: false; status: 400 | 409; error: string };

/** Creates a user. 409 on duplicate email; messages never include secrets. */
export async function createUser(db: Db, input: CreateUserInput): Promise<CreateUserResult> {
  const email = emailSchema.safeParse(input.email);
  const password = passwordSchema.safeParse(input.password);
  const role = roleSchema.safeParse(input.role);
  if (!email.success) return { ok: false, status: 400, error: "email: must be a valid email" };
  if (!password.success) {
    return { ok: false, status: 400, error: "password: must be at least 12 characters" };
  }
  if (!role.success) return { ok: false, status: 400, error: "role: must be admin or user" };
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.data))
    .limit(1);
  if (existing.length > 0) {
    return { ok: false, status: 409, error: `email: ${email.data} is already registered` };
  }
  const created = await db
    .insert(users)
    .values({ email: email.data, passwordHash: await hashPassword(password.data), role: role.data })
    .returning();
  const row = created[0];
  if (!row) return { ok: false, status: 400, error: "user could not be created" };
  return { ok: true, user: toView(row) };
}

export interface UpdateUserInput {
  role?: unknown;
  disabled?: unknown;
  password?: unknown;
}

export type UpdateUserResult =
  { ok: true; user: AdminUserView } | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Updates role, disabled flag, or password. Password changes and disabling bump `pwVersion`,
 * so outstanding sessions stop working; a password change also invalidates every API token the
 * user created before it. Enabling does not need a bump. An admin cannot demote or
 * disable themselves (`actorId`), and the last enabled admin can never lose admin access (409).
 */
export async function updateUser(
  db: Db,
  id: number,
  input: UpdateUserInput,
  actorId?: number,
): Promise<UpdateUserResult> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "user not found" };

  const patch: Partial<typeof users.$inferInsert> = {};
  let bumpVersion = false;
  let resetTokens = false;
  if (input.role !== undefined) {
    const role = roleSchema.safeParse(input.role);
    if (!role.success) return { ok: false, status: 400, error: "role: must be admin or user" };
    patch.role = role.data;
  }
  if (input.disabled !== undefined) {
    if (typeof input.disabled !== "boolean") {
      return { ok: false, status: 400, error: "disabled: must be a boolean" };
    }
    patch.disabled = input.disabled;
    if (input.disabled && !row.disabled) bumpVersion = true;
  }
  if (input.password !== undefined) {
    const password = passwordSchema.safeParse(input.password);
    if (!password.success) {
      return { ok: false, status: 400, error: "password: must be at least 12 characters" };
    }
    patch.passwordHash = await hashPassword(password.data);
    bumpVersion = true;
    resetTokens = true;
  }
  const losesAdmin =
    row.role === "admin" && !row.disabled && (patch.role === "user" || patch.disabled === true);
  if (losesAdmin) {
    if (actorId === id) {
      return { ok: false, status: 409, error: "You cannot demote or disable your own account" };
    }
    const others = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.disabled, false), ne(users.id, id)));
    if ((others[0]?.n ?? 0) === 0) {
      return { ok: false, status: 409, error: "At least one enabled admin must remain" };
    }
  }
  if (bumpVersion) patch.pwVersion = row.pwVersion + 1;

  const updated = await db
    .update(users)
    .set({
      ...patch,
      // API tokens created before a password reset stop working (spec `agent-tokens`). The
      // database clock sets this, as it stamps `api_tokens.created_at`, so the two compare exactly.
      ...(resetTokens ? { tokensValidAfter: sql`now()` } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .returning();
  const next = updated[0];
  if (!next) return { ok: false, status: 404, error: "user not found" };
  return { ok: true, user: toView(next) };
}
