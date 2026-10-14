import { asc, eq } from "drizzle-orm";
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
  { ok: true; user: AdminUserView } | { ok: false; status: 400 | 404; error: string };

/**
 * Updates role, disabled flag, or password. Password changes and disabling bump `pwVersion`,
 * so outstanding sessions stop working. Enabling does not need a bump.
 */
export async function updateUser(
  db: Db,
  id: number,
  input: UpdateUserInput,
): Promise<UpdateUserResult> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "user not found" };

  const patch: Partial<typeof users.$inferInsert> = {};
  let bumpVersion = false;
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
  }
  if (bumpVersion) patch.pwVersion = row.pwVersion + 1;

  const updated = await db
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  const next = updated[0];
  if (!next) return { ok: false, status: 404, error: "user not found" };
  return { ok: true, user: toView(next) };
}
