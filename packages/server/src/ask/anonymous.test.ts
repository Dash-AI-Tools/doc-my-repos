import { Secret } from "../config/secret";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { decodeEvent, type AskEvent } from "@docmyrepos/core/internal/ask/events";

import { askUsage, documents, repos, users } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import type { PublicAccessSettings } from "../public-access/settings";
import { ANONYMOUS, anonymousReposOnly } from "../queries/visibility";
import { recordingLogger } from "../test-logger";
import { handleAsk, type AskHandlerDeps } from "./handler";
import { AskGate } from "./limits";
import { saveAskSettings } from "./settings";
import { startFakeProvider, type FakeProvider } from "../../../../tests/support/fake-provider";

/**
 * Anonymous Ask (public access): a visitor without a session asks when an admin allowed it, is
 * answered from public repositories only, and is counted against shared caps without being
 * identified, recorded or logged.
 */

const KEY = "sk-anonymous-test-KEYVALUE-123456";
const QUESTION = "How do I rotate the signing key? ANON-QUESTION-TEXT";
const OPEN_TEXT = "Run `keys rotate` to rotate the signing key. OPEN-EXCERPT";
const CLOSED_TEXT = "CLOSED-SENTINEL rotate the signing key";

describeDb("POST /api/ask as a visitor without a session", () => {
  let t: TestDatabase;
  let fake: FakeProvider;
  let memberId = 0;
  let gate: AskGate;
  let recorder = recordingLogger();
  let settings: PublicAccessSettings;

  beforeAll(async () => {
    t = await createTestDatabase();
    fake = await startFakeProvider();
    const [member] = await t.db
      .insert(users)
      .values({ email: "member@example.com", passwordHash: "x" })
      .returning({ id: users.id });
    memberId = member!.id;
    const seed = async (githubId: number, name: string, isPublic: boolean, text: string) => {
      const [repo] = await t.db
        .insert(repos)
        .values({
          githubId,
          owner: "acme",
          name,
          defaultBranch: "main",
          visibility: "private",
          htmlUrl: `https://github.com/acme/${name}`,
          docsPath: "docs",
          isPublic,
        })
        .returning({ id: repos.id });
      const body = `Intro.\n\n## Rotate the signing key\n\n${text}`;
      await t.db.insert(documents).values({
        repoId: repo!.id,
        path: "docs/keys.md",
        title: "Signing keys",
        blobSha: `sha-${name}`,
        sizeBytes: body.length,
        body,
        headings: [{ depth: 2, text: "Rotate the signing key", slug: "rotate-the-signing-key" }],
      });
    };
    await seed(1, "open", true, OPEN_TEXT);
    await seed(2, "closed", false, CLOSED_TEXT);
  }, 60_000);
  afterAll(async () => {
    await fake?.close();
    await t?.drop();
  }, 60_000);

  beforeEach(async () => {
    fake.reset();
    fake.setDefault((request) =>
      request.stream
        ? {
            kind: "text",
            chunks: ["Run the rotate command ", "to rotate it [1]."],
            usage: { input: 500, output: 20 },
          }
        : { kind: "text", chunks: [JSON.stringify(["rotate signing key"])] },
    );
    await t.db.delete(askUsage);
    await saveAskSettings(
      t.db,
      { enabled: true, provider: "openai-compatible", model: "test-model" },
      null,
    );
    gate = new AskGate();
    recorder = recordingLogger();
    settings = {
      searchEnabled: true,
      askEnabled: true,
      askQuestionsPerDay: 100,
      askQuestionsPerTenMinutes: 20,
    };
  });

  const workspace = async () => ({
    providers: {
      anthropicKey: null,
      openaiBaseUrl: fake.openAiBaseUrl,
      openaiKey: new Secret(KEY),
    },
    config: {
      ask: {
        questionsPerDay: 100,
        questionsPerTenMinutes: 20,
        maxOutputTokens: 500,
        maxConcurrent: 8,
      },
    },
  });
  const deps = (over: Partial<AskHandlerDeps> = {}): AskHandlerDeps => ({
    db: t.db,
    workspace,
    log: recorder.log,
    gate,
    reader: ANONYMOUS,
    options: { visibility: anonymousReposOnly },
    publicAccess: async () => settings,
    limits: () => ({
      questionsPerDay: 100,
      questionsPerTenMinutes: 20,
      maxOutputTokens: 500,
      maxConcurrent: 8,
    }),
    providerDeps: { sleep: async () => undefined },
    ...over,
  });
  const post = (body: unknown = { question: QUESTION }, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost", ...headers },
      body: JSON.stringify(body),
    });
  const events = async (response: Response): Promise<AskEvent[]> =>
    (await response.text())
      .split("\n\n")
      .filter((frame) => frame.trim() !== "")
      .map((frame) => decodeEvent(frame))
      .filter((e): e is AskEvent => e !== null);
  const usage = () => t.db.select().from(askUsage);

  it("answers 401 while anonymous Ask is off, and never calls the provider or records anything", async () => {
    settings = { ...settings, askEnabled: false };
    const response = await handleAsk(post(), deps());
    expect(response.status).toBe(401);
    expect(fake.requests).toHaveLength(0);
    expect(await usage()).toEqual([]);
  });

  it("answers from public repositories only, and no excerpt of another repository reaches the model", async () => {
    const response = await handleAsk(post(), deps());
    expect(response.status).toBe(200);
    const list = await events(response);
    expect(list.map((e) => e.event)).toContain("done");
    const references = list.find((e) => e.event === "references");
    expect(JSON.stringify(references)).toContain("acme/open");
    expect(JSON.stringify(references)).not.toContain("acme/closed");
    const sent = JSON.stringify(fake.requests.map((r) => r.body));
    expect(sent).toContain("OPEN-EXCERPT");
    expect(sent).not.toContain("CLOSED-SENTINEL");
  });

  it("records only a count and an outcome: no identity, no question text, in the row or the logs", async () => {
    await (await handleAsk(post(), deps())).text();
    const rows = await usage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ anonymous: true, userId: null, outcome: "ok" });
    expect(rows[0]!.inputTokens).toBeGreaterThan(0);
    const dump = JSON.stringify(rows) + JSON.stringify(recorder.lines);
    expect(dump).not.toContain("ANON-QUESTION-TEXT");
    expect(dump).not.toContain("OPEN-EXCERPT");
    // The log lines say nothing about who asked: no user id, no address.
    expect(JSON.stringify(recorder.lines)).not.toMatch(/userId|ip|address/i);
  });

  it("counts a question that finds nothing against the cap too, as a no_results row", async () => {
    fake.setDefault((request) =>
      request.stream
        ? { kind: "text", chunks: ["unused"] }
        : { kind: "text", chunks: [JSON.stringify(["zzqqxx nothing matches"])] },
    );
    const response = await handleAsk(post({ question: "zzqqxx nothing matches" }), deps());
    const list = await events(response);
    expect(list.find((e) => e.event === "done")).toMatchObject({ data: { outcome: "no_results" } });
    const rows = await usage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ anonymous: true, outcome: "no_results" });
  });

  it("refuses over the shared ten-minute cap with 429 and Retry-After, calling no model", async () => {
    settings = { ...settings, askQuestionsPerTenMinutes: 2 };
    for (let i = 0; i < 2; i++) await (await handleAsk(post(), deps())).text();
    const calls = fake.requests.length;
    const refused = await handleAsk(post(), deps());
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ code: "rate_limited", limit: "ten_minutes" });
    expect(fake.requests).toHaveLength(calls);
    expect(await usage()).toHaveLength(2);
  });

  it("refuses over the shared daily cap, and the caps are the admin's, not the per-user ones", async () => {
    settings = { ...settings, askQuestionsPerDay: 1 };
    await (await handleAsk(post(), deps())).text();
    const refused = await handleAsk(post(), deps());
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ limit: "daily" });
  });

  it("keeps signed-in users' limits apart from the anonymous count, in both directions", async () => {
    settings = { ...settings, askQuestionsPerTenMinutes: 1 };
    await (await handleAsk(post(), deps())).text();
    expect((await handleAsk(post(), deps())).status).toBe(429);
    const member = await handleAsk(post(), {
      ...deps(),
      reader: undefined,
      options: undefined,
      user: async () => ({ id: memberId, email: "member@example.com", role: "user" as const }),
    });
    expect(member.status).toBe(200);
    await member.text();
    const rows = await usage();
    expect(rows.filter((r) => r.anonymous)).toHaveLength(1);
    expect(rows.filter((r) => r.userId === memberId)).toHaveLength(1);
  });

  it("does not count the rows of deleted users as anonymous questions", async () => {
    settings = { ...settings, askQuestionsPerTenMinutes: 1 };
    await t.db
      .insert(askUsage)
      .values({ userId: null, anonymous: false, provider: "x", outcome: "ok" });
    expect((await handleAsk(post(), deps())).status).toBe(200);
  });

  it("answers several anonymous visitors at once up to the process cap, and 503 beyond it", async () => {
    const limits = () => ({
      questionsPerDay: 100,
      questionsPerTenMinutes: 20,
      maxOutputTokens: 500,
      maxConcurrent: 2,
    });
    const held = [gate.tryEnterAnonymous(2), gate.tryEnterAnonymous(2)];
    expect(held.every((slot) => slot.ok)).toBe(true);
    const busy = await handleAsk(post(), deps({ limits }));
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBeTruthy();
    for (const slot of held) if (slot.ok) slot.release();
    const ok = await handleAsk(post(), deps({ limits }));
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it("refuses a cross-origin question with 403, calling no model and recording nothing", async () => {
    const response = await handleAsk(
      post({ question: QUESTION }, { origin: "https://evil.example" }),
      deps(),
    );
    expect(response.status).toBe(403);
    expect(fake.requests).toHaveLength(0);
    expect(await usage()).toEqual([]);
  });
});
