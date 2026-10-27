import { afterAll, beforeAll, expect, it } from "vitest";

import { users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { hashPassword } from "./password";
import { authenticate } from "./login";

describeDb("authenticate", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
    await t.db.insert(users).values([
      {
        email: "admin@example.com",
        passwordHash: await hashPassword("admin-pass-123"),
        role: "admin",
      },
      {
        email: "viewer@example.com",
        passwordHash: await hashPassword("viewer-pass-123"),
        role: "user",
      },
      {
        email: "off@example.com",
        passwordHash: await hashPassword("off-pass-123"),
        role: "user",
        disabled: true,
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("logs in with valid credentials regardless of email case", async () => {
    const user = await authenticate(t.db, "Viewer@Example.com ", "viewer-pass-123", null);
    expect(user).toMatchObject({ email: "viewer@example.com", role: "user" });
  });

  it("returns null for wrong passwords, unknown emails, and blanks alike", async () => {
    expect(await authenticate(t.db, "viewer@example.com", "wrong", null)).toBeNull();
    expect(await authenticate(t.db, "nobody@example.com", "viewer-pass-123", null)).toBeNull();
    expect(await authenticate(t.db, "", "x", null)).toBeNull();
    expect(await authenticate(t.db, "viewer@example.com", "", null)).toBeNull();
  });

  it("refuses disabled users", async () => {
    expect(await authenticate(t.db, "off@example.com", "off-pass-123", null)).toBeNull();
  });

  it("bootstraps the first admin from env credentials when users is empty", async () => {
    const fresh = await createTestDatabase();
    try {
      const user = await fresh.db.select().from(users).limit(1);
      expect(user).toHaveLength(0);
      const created = await authenticate(fresh.db, "root@example.com", "bootstrap-pass-123", {
        email: "root@example.com",
        password: "bootstrap-pass-123",
      });
      expect(created).toMatchObject({ email: "root@example.com", role: "admin" });
      // Bootstrap is one-shot: a second miss does not recreate or bypass.
      expect(
        await authenticate(fresh.db, "root@example.com", "wrong", {
          email: "root@example.com",
          password: "bootstrap-pass-123",
        }),
      ).toBeNull();
      expect(
        await authenticate(fresh.db, "root@example.com", "bootstrap-pass-123", {
          email: "root@example.com",
          password: "bootstrap-pass-123",
        }),
      ).toMatchObject({ role: "admin" });
    } finally {
      await fresh.drop();
    }
  }, 60_000);
});
