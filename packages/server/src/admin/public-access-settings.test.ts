import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import type { CurrentUser } from "../auth/current-user";
import { publicAccessSettings, repos, settingsAudit, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { getPublicAccessState } from "../public-access/state";
import { recordingLogger } from "../test-logger";
import {
  handleGetPublicAccess,
  handleSavePublicAccess,
  type PublicAccessAdminDeps,
} from "./public-access";

type View = {
  error?: string;
  field?: string;
  settings: {
    searchEnabled: boolean;
    askEnabled: boolean;
    askQuestionsPerDay: number;
    askQuestionsPerTenMinutes: number;
  };
  anyPublic: boolean;
};

describeDb("admin public access settings API", () => {
  let t: TestDatabase;
  let adminId = 0;
  let recorder = recordingLogger();

  beforeAll(async () => {
    t = await createTestDatabase();
    const [row] = await t.db
      .insert(users)
      .values({ email: "admin@example.com", passwordHash: "x", role: "admin" })
      .returning({ id: users.id });
    adminId = row!.id;
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  }, 60_000);
  beforeEach(async () => {
    await t.db.delete(publicAccessSettings);
    await t.db.delete(settingsAudit);
    await t.db.delete(repos);
    recorder = recordingLogger();
  });

  const admin = (): CurrentUser => ({ id: adminId, email: "admin@example.com", role: "admin" });
  const deps = (over: Partial<PublicAccessAdminDeps> = {}): PublicAccessAdminDeps => ({
    db: t.db,
    admin: async () => admin(),
    log: recorder.log,
    ...over,
  });
  const forbidden = (status: 401 | 403): Partial<PublicAccessAdminDeps> => ({
    admin: async () => {
      throw Object.assign(new Error("denied"), { status });
    },
  });
  const put = (body: unknown, origin = "http://localhost") =>
    new Request("http://localhost/api/admin/public-access", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });

  it("reports the defaults and that nothing is public yet", async () => {
    const response = await handleGetPublicAccess(deps());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()) as View).toEqual({
      settings: {
        searchEnabled: true,
        askEnabled: false,
        askQuestionsPerDay: 200,
        askQuestionsPerTenMinutes: 20,
      },
      anyPublic: false,
    });
  });

  it("saves a partial change, keeps the rest, and says whether something is public", async () => {
    await t.db.insert(repos).values({
      githubId: 1,
      owner: "acme",
      name: "docs",
      defaultBranch: "main",
      visibility: "public",
      htmlUrl: "https://github.com/acme/docs",
      isPublic: true,
    });
    const response = await handleSavePublicAccess(
      put({ askEnabled: true, askQuestionsPerDay: 50 }),
      deps(),
    );
    expect(response.status).toBe(200);
    const view = (await response.json()) as View;
    expect(view.settings).toEqual({
      searchEnabled: true,
      askEnabled: true,
      askQuestionsPerDay: 50,
      askQuestionsPerTenMinutes: 20,
    });
    expect(view.anyPublic).toBe(true);
  });

  it("names the field of an invalid value with 400 and writes nothing", async () => {
    for (const [body, field] of [
      [{ askQuestionsPerDay: 0 }, "askQuestionsPerDay"],
      [{ askQuestionsPerTenMinutes: 2000 }, "askQuestionsPerTenMinutes"],
      [{ searchEnabled: "no" }, "searchEnabled"],
      [{ unknown: true }, "searchEnabled"],
    ] as const) {
      const response = await handleSavePublicAccess(put(body), deps());
      expect(response.status).toBe(400);
      expect(((await response.json()) as View).field).toBe(field);
    }
    expect((await handleSavePublicAccess(put({}), deps())).status).toBe(400);
    expect(await t.db.select().from(publicAccessSettings)).toEqual([]);
    expect(await t.db.select().from(settingsAudit)).toEqual([]);
  });

  it("records the field names, never the values, in the audit and the log", async () => {
    await handleSavePublicAccess(put({ askEnabled: true, askQuestionsPerDay: 4321 }), deps());
    const audit = await t.db.select().from(settingsAudit);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.userId).toBe(adminId);
    expect([...audit[0]!.fields].sort()).toEqual([
      "publicAccess.askEnabled",
      "publicAccess.askQuestionsPerDay",
    ]);
    expect(JSON.stringify(audit)).not.toContain("4321");
    expect(JSON.stringify(recorder.lines)).not.toContain("4321");
  });

  it("applies at once: the next read sees a save", async () => {
    const db = () => Promise.resolve(t.db);
    expect((await getPublicAccessState(db)).settings.searchEnabled).toBe(true);
    await handleSavePublicAccess(put({ searchEnabled: false }), deps());
    expect((await getPublicAccessState(db)).settings.searchEnabled).toBe(false);
  });

  it("answers 401 and 403 without reading or writing anything", async () => {
    for (const status of [401, 403] as const) {
      expect((await handleGetPublicAccess(deps(forbidden(status)))).status).toBe(status);
      expect(
        (await handleSavePublicAccess(put({ askEnabled: true }), deps(forbidden(status)))).status,
      ).toBe(status);
    }
    expect(await t.db.select().from(publicAccessSettings)).toEqual([]);
  });

  it("refuses a cross-origin write with 403", async () => {
    const response = await handleSavePublicAccess(
      put({ askEnabled: true }, "https://evil.example"),
      deps(),
    );
    expect(response.status).toBe(403);
    expect(
      await t.db.select().from(publicAccessSettings).where(eq(publicAccessSettings.id, 1)),
    ).toEqual([]);
  });
});
