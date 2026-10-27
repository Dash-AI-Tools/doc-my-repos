import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import type { Access } from "../auth/access";
import { users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { handleUpdateUser } from "./service";

/**
 * The user-management invariants hold after `authorize` allows the change, whatever the host's
 * hook decides (extension-hooks "Authorization keeps data invariants").
 */
describeDb("admin invariants under a permissive authorize", () => {
  let t: TestDatabase;
  let adminId: number;

  beforeAll(async () => {
    t = await createTestDatabase();
    const [row] = await t.db
      .insert(users)
      .values({ email: "only-admin@example.com", passwordHash: "x", role: "admin" })
      .returning({ id: users.id });
    adminId = row!.id;
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  const allowEverything = (): Access => {
    const me = { id: adminId, email: "only-admin@example.com", role: "admin" as const };
    return { user: async () => me, admin: async () => me, can: async () => true, emit: () => {} };
  };

  const patch = (body: unknown) =>
    new Request("http://localhost/api/admin/users/1", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify(body),
    });

  it("still refuses the only admin demoting or disabling themselves", async () => {
    for (const body of [{ role: "user" }, { disabled: true }]) {
      const response = await handleUpdateUser(adminId, patch(body), t.db, allowEverything());
      expect(response.status, JSON.stringify(body)).toBe(409);
    }
    const [row] = await t.db.select().from(users).where(eq(users.id, adminId));
    expect(row).toMatchObject({ role: "admin", disabled: false });
  });
});
