import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { Secret } from "../config/secret";
import { documents, repos, type Heading } from "../db/schema";
import { createTestDatabase, describeDb, type TestDatabase } from "../db/test-db";
import { createProvider, type ProviderAdapter } from "./providers";
import { retrieve } from "./retrieve";
import { startFakeProvider, type FakeProvider } from "../../../../tests/support/fake-provider";

/** A document as a list of `[heading, text]` sections after an intro. */
type Spec = { path: string; title: string; intro: string; sections: [string, string][] };

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function body(spec: Spec): { body: string; headings: Heading[] } {
  const headings = spec.sections.map(([text]) => ({ depth: 2, text, slug: slug(text) }));
  const parts = [spec.intro, ...spec.sections.map(([h, t]) => `## ${h}\n\n${t}`)];
  return { body: parts.join("\n\n"), headings };
}

const API: Spec[] = [
  {
    path: "docs/auth/signing-keys.md",
    title: "Signing keys",
    intro: "Tokens are signed with a key pair that you manage.",
    sections: [
      [
        "Rotate the signing key",
        "To rotate the signing key run `keys rotate`. The old key keeps verifying tokens for 24 hours.",
      ],
      ["Key storage", "Private keys live in the vault and never on disk."],
    ],
  },
  {
    path: "docs/deploy.md",
    title: "Deploying the service",
    intro: "The service ships as a container image.",
    sections: [
      [
        "Deploy with Docker",
        "Run `docker run -p 8080:8080 acme/api` and pass the environment variables below.",
      ],
      ["Deploy to Kubernetes", "Apply the manifest in `deploy/k8s` and set the replica count."],
      ["Environment variables", "DATABASE_URL and SESSION_SECRET are required."],
    ],
  },
  {
    path: "docs/rate-limits.md",
    title: "Rate limits",
    intro: "The API protects itself with request limits.",
    sections: [
      ["Default limits", "Each token may send 100 requests per minute by default."],
      ["Raising limits", "Ask support to raise the limit for your account."],
    ],
  },
  {
    path: "docs/webhooks.md",
    title: "Webhooks",
    intro: "Webhooks notify your server about events.",
    sections: [
      [
        "Verify signatures",
        "Compute an HMAC of the raw body and compare it with the signature header.",
      ],
      ["Retries", "Failed deliveries are retried with exponential backoff."],
    ],
  },
];

const HANDBOOK: Spec[] = [
  {
    path: "docs/onboarding.md",
    title: "Onboarding checklist",
    intro: "Welcome to the team.",
    sections: [
      [
        "First week",
        "In your first week meet your buddy, read the handbook and set up your laptop.",
      ],
      ["Accounts and access", "IT creates your accounts on day one."],
    ],
  },
  {
    path: "docs/vacation.md",
    title: "Vacation policy",
    intro: "Everyone gets 25 days of paid leave.",
    sections: [
      ["Requesting time off", "Request time off in the HR tool at least two weeks ahead."],
      ["Public holidays", "Public holidays do not count against your leave."],
    ],
  },
  {
    path: "docs/security/incident-response.md",
    title: "Incident response",
    intro: "How we handle production incidents.",
    sections: [
      ["Severity levels", "Sev1 means customers are down. Sev2 means degraded service."],
      [
        "Paging the on-call engineer",
        "For a sev1 page the on-call engineer through the incident tool.",
      ],
    ],
  },
];

const OPS: Spec[] = [
  {
    path: "docs/backups.md",
    title: "Database backups",
    intro: "We back up every production database.",
    sections: [
      ["Nightly backup schedule", "Backups run at 02:00 UTC and are kept for 30 days."],
      [
        "Restoring from a backup",
        "To restore the database from a backup run `pgrestore` with the snapshot id.",
      ],
    ],
  },
  {
    path: "docs/monitoring.md",
    title: "Monitoring and alerts",
    intro: "Dashboards and alerts cover every service.",
    sections: [
      ["Dashboards", "Open the overview dashboard for latency and errors."],
      ["Alert thresholds", "Alerts fire when error rate exceeds 2 percent for five minutes."],
    ],
  },
  {
    path: "docs/ssl-certificates.md",
    title: "TLS certificates",
    intro: "Certificates are issued automatically.",
    sections: [
      [
        "Renewing certificates",
        "Certificates renew 30 days before expiry. Force a renewal with `certs renew`.",
      ],
      ["Troubleshooting expiry", "If a certificate has expired, renew it and restart the proxy."],
    ],
  },
];

const SECRET: Spec[] = [
  {
    path: "docs/launch-plan.md",
    title: "Launch plan",
    intro: "CODENAME-FALCON stays confidential.",
    sections: [
      ["Rotate the signing key", "CODENAME-FALCON: rotate the signing key before launch day."],
    ],
  },
];

/** Question, the queries a model would write for it, and the document that answers it. */
const FIXTURES: { question: string; queries: string[]; expected: string }[] = [
  {
    question: "How do I rotate the signing key?",
    queries: ["rotate signing key"],
    expected: "docs/auth/signing-keys.md",
  },
  {
    question: "How can I deploy with Docker?",
    queries: ["deploy docker"],
    expected: "docs/deploy.md",
  },
  {
    question: "What are the default API rate limits?",
    queries: ["rate limits default"],
    expected: "docs/rate-limits.md",
  },
  {
    question: "How do I verify a webhook signature?",
    queries: ["webhook verify signature"],
    expected: "docs/webhooks.md",
  },
  {
    question: "What should I do in my first week?",
    queries: ["first week onboarding"],
    expected: "docs/onboarding.md",
  },
  {
    question: "How do I request time off?",
    queries: ["request time off vacation"],
    expected: "docs/vacation.md",
  },
  {
    question: "Who do I page for a sev1 outage?",
    queries: ["page on-call sev1"],
    expected: "docs/security/incident-response.md",
  },
  {
    question: "How do I restore the database from a backup?",
    queries: ["restore database backup"],
    expected: "docs/backups.md",
  },
  {
    question: "When do the alerts fire?",
    queries: ["alert thresholds", "alerts error rate"],
    expected: "docs/monitoring.md",
  },
  {
    question: "My certificate expired, what now?",
    queries: ["certificate expiry renew", "renew certificate"],
    expected: "docs/ssl-certificates.md",
  },
];

/** Recall bars: the share of fixture questions whose answering document reaches the excerpts. */
const MIN_RECALL_WITH_MODEL_QUERIES = 0.9;
const MIN_RECALL_WITH_RAW_QUESTION = 0.4;

describeDb("retrieve against a seeded database", () => {
  let t: TestDatabase;
  let fake: FakeProvider;
  let adapter: ProviderAdapter;

  beforeAll(async () => {
    t = await createTestDatabase();
    fake = await startFakeProvider();
    adapter = createProvider(
      {
        provider: "openai-compatible",
        baseUrl: new URL(fake.openAiBaseUrl),
        apiKey: new Secret("k"),
      },
      "m",
      { sleep: async () => undefined },
    );
    const seed = async (githubId: number, name: string, specs: Spec[], isAllowed = true) => {
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
          isAllowed,
        })
        .returning({ id: repos.id });
      for (const spec of specs) {
        const { body: text, headings } = body(spec);
        await t.db.insert(documents).values({
          repoId: repo!.id,
          path: spec.path,
          title: spec.title,
          blobSha: `sha-${spec.path}`,
          sizeBytes: text.length,
          body: text,
          headings,
        });
      }
    };
    await seed(1, "api", API);
    await seed(2, "handbook", HANDBOOK);
    await seed(3, "ops", OPS);
    await seed(4, "secret", SECRET, false);
  }, 60_000);

  afterAll(async () => {
    await fake?.close();
    await t?.drop();
  }, 60_000);

  beforeEach(() => fake.reset());

  /** The fake model answers the query call with the fixture's queries, found by its question. */
  function scriptModel(mode: "queries" | "broken") {
    fake.setDefault((request) => {
      if (mode === "broken") return { kind: "status", status: 500 };
      const messages = request.body.messages as { role: string; content: string }[];
      const user = messages.at(-1)?.content ?? "";
      const fixture = FIXTURES.find((f) => user.endsWith(f.question));
      return { kind: "text", chunks: [JSON.stringify(fixture?.queries ?? [])] };
    });
  }

  async function recall(): Promise<{ hits: number; missed: string[] }> {
    const missed: string[] = [];
    let hits = 0;
    for (const f of FIXTURES) {
      const result = await retrieve(
        { db: t.db, provider: adapter },
        { question: f.question, history: [] },
      );
      if (result.excerpts.some((e) => e.path === f.expected)) hits += 1;
      else missed.push(f.question);
    }
    return { hits, missed };
  }

  it("reaches the stated recall with model-written queries", async () => {
    scriptModel("queries");
    const { hits, missed } = await recall();
    expect(hits / FIXTURES.length, `missed: ${missed.join(" | ")}`).toBeGreaterThanOrEqual(
      MIN_RECALL_WITH_MODEL_QUERIES,
    );
  });

  it("still finds many answers from the raw question when the model call fails", async () => {
    scriptModel("broken");
    const { hits, missed } = await recall();
    expect(hits / FIXTURES.length, `missed: ${missed.join(" | ")}`).toBeGreaterThanOrEqual(
      MIN_RECALL_WITH_RAW_QUESTION,
    );
  });

  it("puts the answering section first and numbers excerpts from 1", async () => {
    scriptModel("queries");
    const result = await retrieve(
      { db: t.db, provider: adapter },
      { question: "How do I rotate the signing key?", history: [] },
    );
    expect(result.excerpts.map((e) => e.n)).toEqual(result.excerpts.map((_, i) => i + 1));
    expect(result.excerpts[0]).toMatchObject({
      path: "docs/auth/signing-keys.md",
      title: "Signing keys",
      repo: { owner: "acme", name: "api", docsPath: "docs" },
      heading: { text: "Rotate the signing key", slug: "rotate-the-signing-key" },
    });
    expect(result.excerpts[0]?.text).toContain("keys rotate");
  });

  it("never uses a blocked repository, though its text matches best", async () => {
    scriptModel("queries");
    const result = await retrieve(
      { db: t.db, provider: adapter },
      { question: "How do I rotate the signing key?", history: [] },
    );
    expect(JSON.stringify(result)).not.toContain("CODENAME-FALCON");
    expect(result.excerpts.every((e) => e.repo.name !== "secret")).toBe(true);
    // Asking for it by name does not help either.
    const scoped = await retrieve(
      { db: t.db, provider: adapter },
      { question: "How do I rotate the signing key?", history: [], repo: "acme/secret" },
    );
    expect(scoped.scope).toBeNull();
    expect(JSON.stringify(scoped)).not.toContain("CODENAME-FALCON");
  });

  it("limits excerpts to the scoped repository", async () => {
    fake.setDefault({
      kind: "text",
      chunks: ['["time off", "page on-call", "restore backup", "deploy docker"]'],
    });
    const result = await retrieve(
      { db: t.db, provider: adapter },
      { question: "anything", history: [], repo: "ACME/Handbook" },
    );
    expect(result.scope).toBe("acme/handbook");
    expect(result.excerpts.length).toBeGreaterThan(0);
    expect(result.excerpts.every((e) => e.repo.name === "handbook")).toBe(true);
  });

  it("treats an unknown scope as unscoped", async () => {
    scriptModel("queries");
    const result = await retrieve(
      { db: t.db, provider: adapter },
      { question: "How can I deploy with Docker?", history: [], repo: "acme/nope" },
    );
    expect(result.scope).toBeNull();
    expect(result.excerpts.some((e) => e.path === "docs/deploy.md")).toBe(true);
  });

  it("returns no excerpts when no document matches", async () => {
    fake.setDefault({ kind: "text", chunks: ['["zzzxqy"]'] });
    const result = await retrieve(
      { db: t.db, provider: adapter },
      { question: "Tell me about zzzxqy", history: [] },
    );
    expect(result.excerpts).toEqual([]);
  });

  it("sends the query call no document text", async () => {
    scriptModel("queries");
    await retrieve(
      { db: t.db, provider: adapter },
      {
        question: "How do I rotate the signing key?",
        history: [{ question: "earlier?", answer: "secret answer text" }],
      },
    );
    const sent = JSON.stringify(fake.requests[0]?.body);
    expect(sent).toContain("earlier?");
    expect(sent).not.toContain("secret answer text");
    expect(sent).not.toContain("keys rotate");
  });
});
