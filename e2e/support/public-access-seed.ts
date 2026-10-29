import type { Db } from "../../packages/server/src/db/client";
import { hashPassword } from "../../packages/server/src/auth/password";
import { users } from "../../packages/server/src/db/schema";
import { PUBLIC_USERS } from "./public-access-data";

/** The two users of the `publicaccess` e2e data, with real password hashes. */
export async function seedPublicAccessUsers(db: Db): Promise<void> {
  for (const user of Object.values(PUBLIC_USERS)) {
    await db.insert(users).values({
      email: user.email,
      passwordHash: await hashPassword(user.password),
      role: user.role,
    });
  }
}
