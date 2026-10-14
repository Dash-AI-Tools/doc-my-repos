import { eq } from "drizzle-orm";

import type { Db } from "@/server/db/client";
import { users } from "@/server/db/schema";

import { hashPassword, verifyPassword } from "./password";

export type LoginRole = "admin" | "user";

export interface LoginUser {
  id: number;
  email: string;
  role: LoginRole;
  pwVersion: number;
}

export interface BootstrapAdmin {
  email: string;
  /** Plaintext bootstrap password from env; only used while `users` is empty. */
  password: string;
}

// Cost of one hash on a miss, so a wrong email takes about as long as a wrong password.
let dummyHash: Promise<string> | null = null;

function dummyHashForTiming(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword("dummy-password-for-timing");
  return dummyHash;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Checks email + password against `users`. Returns the user on success, null otherwise (generic:
 * callers must not distinguish "unknown email" from "wrong password").
 *
 * When `users` is empty and `bootstrap` is set, matching bootstrap credentials creates the first
 * admin. Afterwards the env bootstrap is ignored.
 */
export async function authenticate(
  db: Db,
  email: string,
  password: string,
  bootstrap: BootstrapAdmin | null,
): Promise<LoginUser | null> {
  const normalized = normalizeEmail(email);
  if (normalized === "" || password === "") return null;
  const rows = await db.select().from(users).where(eq(users.email, normalized)).limit(1);
  const row = rows[0];
  if (!row) {
    if (bootstrap && normalized === bootstrap.email && password !== "") {
      const count = await db.select({ id: users.id }).from(users).limit(1);
      // Rare path (empty users table only): hash the env password once, then compare in
      // constant time via scrypt verify. Afterwards the env bootstrap is ignored.
      if (
        count.length === 0 &&
        (await verifyPassword(password, await hashPassword(bootstrap.password)))
      ) {
        const created = await db
          .insert(users)
          .values({
            email: normalized,
            passwordHash: await hashPassword(password),
            role: "admin",
          })
          .returning({
            id: users.id,
            email: users.email,
            role: users.role,
            pwVersion: users.pwVersion,
          });
        const user = created[0];
        return user
          ? { id: user.id, email: user.email, role: user.role, pwVersion: user.pwVersion }
          : null;
      }
    }
    // Same-ish cost as a real check, and no early shape difference for enumeration.
    await verifyPassword(password, await dummyHashForTiming());
    return null;
  }
  if (row.disabled) {
    await verifyPassword(password, await dummyHashForTiming());
    return null;
  }
  if (!(await verifyPassword(password, row.passwordHash))) return null;
  return { id: row.id, email: row.email, role: row.role, pwVersion: row.pwVersion };
}
