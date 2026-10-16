import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { repos, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { createUser, listUsers, updateUser } from "./users";
import { reorderStarredRepos, setRepoAllowed, setRepoStarred } from "./repos";

describeDb("admin user management", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("creates, lists, disables, and resets users without ever exposing hashes", async () => {
    expect(await listUsers(t.db)).toEqual([]);

    const created = await createUser(t.db, {
      email: "Admin@Example.com",
      password: "admin-pass-1234",
      role: "admin",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.user).toMatchObject({
      email: "admin@example.com",
      role: "admin",
      disabled: false,
    });
    expect(JSON.stringify(await listUsers(t.db))).not.toContain("scrypt");
    const backup = await createUser(t.db, {
      email: "backup@example.com",
      password: "backup-pass-1234",
      role: "admin",
    });
    expect(backup.ok).toBe(true);

    const duplicate = await createUser(t.db, {
      email: "admin@example.com",
      password: "other-pass-1234",
      role: "user",
    });
    expect(duplicate).toMatchObject({ ok: false, status: 409 });

    const bad = await createUser(t.db, { email: "not-an-email", password: "short", role: "owner" });
    expect(bad).toMatchObject({ ok: false, status: 400 });

    const before = await t.db.select().from(users).limit(1);
    const disabled = await updateUser(t.db, created.user.id, { disabled: true });
    expect(disabled).toMatchObject({ ok: true, user: { disabled: true } });
    const afterDisable = await t.db
      .select()
      .from(users)
      .where(eq(users.id, created.user.id))
      .limit(1);
    expect(afterDisable[0]?.pwVersion).toBe((before[0]?.pwVersion ?? 0) + 1);

    const reset = await updateUser(t.db, created.user.id, {
      disabled: false,
      password: "brand-new-pass-1",
    });
    expect(reset).toMatchObject({ ok: true, user: { disabled: false } });

    expect(await updateUser(t.db, 999999, { disabled: true })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("keeps an admin in charge: no self-demotion, no removing the last enabled admin", async () => {
    const [first, second] = await listUsers(t.db);
    if (!first || !second) throw new Error("expected two seeded admins");
    expect(await updateUser(t.db, first.id, { role: "user" }, first.id)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(await updateUser(t.db, first.id, { disabled: true }, first.id)).toMatchObject({
      status: 409,
    });
    expect(await updateUser(t.db, second.id, { disabled: true }, first.id)).toMatchObject({
      ok: true,
    });
    expect(await updateUser(t.db, first.id, { role: "user" })).toMatchObject({
      ok: false,
      status: 409,
      error: "At least one enabled admin must remain",
    });
    await updateUser(t.db, second.id, { disabled: false }, first.id);
  });
});

describeDb("admin repo allow/block", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
    await t.db.insert(repos).values({
      githubId: 1,
      owner: "Acme",
      name: "Handbook",
      defaultBranch: "main",
      visibility: "public",
      htmlUrl: "https://github.com/Acme/Handbook",
    });
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("toggles isAllowed case-insensitively and 404s unknown repos", async () => {
    expect(await setRepoAllowed(t.db, "acme", "handbook", false)).toMatchObject({
      ok: true,
      owner: "Acme",
      isAllowed: false,
    });
    const row = await t.db.select().from(repos).limit(1);
    expect(row[0]?.isAllowed).toBe(false);

    expect(await setRepoAllowed(t.db, "ACME", "HANDBOOK", true)).toMatchObject({
      ok: true,
      isAllowed: true,
    });
    expect(await setRepoAllowed(t.db, "acme", "missing", false)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await setRepoAllowed(t.db, "", "handbook", false)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await setRepoAllowed(t.db, "acme", "handbook", "yes")).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("stars at the end, keeps the place on a repeat, and unstars in the middle", async () => {
    await t.db.insert(repos).values(
      ["one", "two", "three"].map((name, i) => ({
        githubId: 70 + i,
        owner: "Star",
        name,
        defaultBranch: "main",
        visibility: "public" as const,
        htmlUrl: `https://github.com/Star/${name}`,
      })),
    );
    const places = async () =>
      Object.fromEntries(
        (await t.db.select().from(repos))
          .filter((r) => r.owner === "Star")
          .map((r) => [r.name, r.starPosition]),
      );
    expect(await places()).toEqual({ one: null, two: null, three: null });

    expect(await setRepoStarred(t.db, "star", "ONE", true)).toMatchObject({
      ok: true,
      owner: "Star",
      isStarred: true,
      starPosition: 0,
    });
    await setRepoStarred(t.db, "star", "two", true);
    await setRepoStarred(t.db, "star", "three", true);
    expect(await places()).toEqual({ one: 0, two: 1, three: 2 });
    // Repeat: same place, not moved to the end.
    expect(await setRepoStarred(t.db, "star", "one", true)).toMatchObject({ starPosition: 0 });
    // Unstar in the middle, then star again: it goes last; the others keep their order.
    expect(await setRepoStarred(t.db, "star", "two", false)).toMatchObject({
      ok: true,
      isStarred: false,
      starPosition: null,
    });
    expect(await places()).toEqual({ one: 0, two: null, three: 2 });
    await setRepoStarred(t.db, "star", "two", true);
    expect(await places()).toEqual({ one: 0, two: 3, three: 2 });
    // Blocking and re-allowing never touch the place.
    await setRepoAllowed(t.db, "star", "three", false);
    await setRepoAllowed(t.db, "star", "three", true);
    expect((await places()).three).toBe(2);

    expect(await setRepoStarred(t.db, "", "one", true)).toMatchObject({ ok: false, status: 400 });
    expect(await setRepoStarred(t.db, "star", "one", "yes")).toMatchObject({ status: 400 });
    expect(await setRepoStarred(t.db, "star", "one", undefined)).toMatchObject({ status: 400 });
    expect(await setRepoStarred(t.db, "star", "missing", true)).toMatchObject({ status: 404 });

    // Reorder rewrites the places to 0..n-1 (closing the gap) and never writes on failure.
    const entry = (name: string) => ({ owner: "star", name });
    expect(
      await reorderStarredRepos(t.db, [entry("two"), entry("one"), entry("three")]),
    ).toMatchObject({ ok: true });
    expect(await places()).toEqual({ two: 0, one: 1, three: 2 });
    expect(await reorderStarredRepos(t.db, [entry("two"), entry("one")])).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(
      await reorderStarredRepos(t.db, [entry("two"), entry("one"), entry("three"), entry("two")]),
    ).toMatchObject({ ok: false, status: 400 });
    expect(await reorderStarredRepos(t.db, [entry("two"), entry("nope")])).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await places()).toEqual({ two: 0, one: 1, three: 2 });
  });
});

describeDb("blocked repos disappear from the shared read layer", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
    await t.db.insert(repos).values([
      {
        githubId: 11,
        owner: "acme",
        name: "shown",
        defaultBranch: "main",
        visibility: "public",
        htmlUrl: "https://github.com/acme/shown",
      },
      {
        githubId: 12,
        owner: "acme",
        name: "hidden",
        defaultBranch: "main",
        visibility: "public",
        htmlUrl: "https://github.com/acme/hidden",
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  }, 60_000);

  it("hides a blocked repo from listRepos/getRepo until re-allowed, content kept", async () => {
    const { getRepo, listRepos } = await import("../queries/repos");
    const { allowAllRepos } = await import("../queries/visibility");
    expect((await listRepos(t.db)).map((r) => r.name)).toEqual(["hidden", "shown"]);

    expect(await setRepoAllowed(t.db, "acme", "hidden", false)).toMatchObject({ ok: true });
    expect((await listRepos(t.db)).map((r) => r.name)).toEqual(["shown"]);
    expect(await getRepo(t.db, "acme", "hidden")).toBeNull();
    // Admins still see it with the explicit full filter; the row itself is untouched.
    expect((await listRepos(t.db, {}, { visibility: allowAllRepos })).map((r) => r.name)).toEqual([
      "hidden",
      "shown",
    ]);

    expect(await setRepoAllowed(t.db, "acme", "hidden", true)).toMatchObject({ ok: true });
    expect((await listRepos(t.db)).map((r) => r.name)).toEqual(["hidden", "shown"]);
    expect(await getRepo(t.db, "acme", "hidden")).not.toBeNull();
  });
});
