import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TenantContext } from "@docmyrepos/core";
import {
  parseEncryptionKey,
  type BlobStore,
  type EmailMessage,
  type SecretsAdapter,
  type StoredBlob,
} from "@docmyrepos/server";

import { ORIGIN, twoTenants, type TwoTenants } from "./support/tenants";

/**
 * A host's secrets, blob and email adapters receive the core's work for each tenant: stored
 * secrets are encrypted with the tenant's own key, the logo goes to the host's store, and mail a
 * plugin sends through its request context reaches the host's transport.
 */
const KEYS: Record<string, string> = {
  a: Buffer.alloc(32, 0xa1).toString("base64"),
  b: Buffer.alloc(32, 0xb2).toString("base64"),
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

let t: TwoTenants;
let host: ReturnType<TwoTenants["app"]>;
const admins: Record<string, number> = {};
const keyRequests: string[] = [];
const blobs = new Map<string, StoredBlob>();
const mail: { tenant: TenantContext; message: EmailMessage }[] = [];

const secrets: SecretsAdapter = {
  async encryptionKey(tenant) {
    keyRequests.push(tenant.id);
    return parseEncryptionKey(KEYS[tenant.id]);
  },
};
const blobStore: BlobStore = {
  get: async (tenant, name) => blobs.get(`${tenant.id}:${name}`) ?? null,
  put: async (tenant, name, blob) => void blobs.set(`${tenant.id}:${name}`, blob),
  delete: async (tenant, name) => void blobs.delete(`${tenant.id}:${name}`),
};

beforeAll(async () => {
  t = await twoTenants();
  for (const tenant of ["a", "b"] as const) {
    const [admin] = await t.sql<{ id: number }>(
      tenant,
      `INSERT INTO users (email, password_hash, role) VALUES ('root@${tenant}.example', 'x', 'admin') RETURNING id`,
    );
    admins[tenant] = admin!.id;
  }
  host = t.app({
    adapters: {
      secrets,
      blobs: blobStore,
      email: { send: async (tenant, message) => void mail.push({ tenant, message }) },
    },
  });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

async function adminOf(tenant: "a" | "b") {
  const ctx = await host.context(t.request("/", tenant));
  return (await host.issueSession(ctx!, admins[tenant]!, { secure: false })).split(";")[0]!;
}

async function settingsOf(tenant: "a" | "b") {
  const cookie = await adminOf(tenant);
  const response = await host.routes.adminSettings.GET(
    t.request("/api/admin/settings", tenant, { headers: { cookie } }),
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function saveWebhookSecret(tenant: "a" | "b", value: string) {
  const cookie = await adminOf(tenant);
  const view = await settingsOf(tenant);
  const response = await host.routes.adminSettings.PUT(
    t.request("/api/admin/settings", tenant, {
      method: "PUT",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: view.version,
        settings: view.settings,
        secrets: { github_webhook_secret: value },
      }),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

describe("a host secrets adapter", () => {
  it("encrypts each tenant's secrets with that tenant's key", async () => {
    await saveWebhookSecret("a", "webhook-secret-of-tenant-a-0123456789");
    expect(keyRequests).toContain("a");
    expect((await settingsOf("a")).problems.unreadable).toEqual([]);

    // Tenant a's stored value, copied into tenant b's database, cannot be read with b's key.
    const [row] = await t.sql<{ ciphertext: string; nonce: string }>(
      "a",
      "select ciphertext, nonce from workspace_secrets where name = 'github_webhook_secret'",
    );
    await t.sql(
      "b",
      "insert into workspace_secrets (name, ciphertext, nonce) values ('github_webhook_secret', $1, $2)",
      [row!.ciphertext, row!.nonce],
    );
    expect((await settingsOf("b")).problems.unreadable).toEqual(["github_webhook_secret"]);
    expect(keyRequests).toContain("b");

    // Saved through b's own key, it reads again; a's is untouched.
    await saveWebhookSecret("b", "webhook-secret-of-tenant-b-0123456789");
    expect((await settingsOf("b")).problems.unreadable).toEqual([]);
    expect((await settingsOf("a")).problems.unreadable).toEqual([]);
  });
});

describe("a host blob store", () => {
  const upload = async (tenant: "a" | "b") =>
    host.routes.adminBrandingLogo.PUT(
      t.request("/api/admin/branding/logo", tenant, {
        method: "PUT",
        headers: {
          cookie: await adminOf(tenant),
          origin: ORIGIN,
          "content-type": "image/png",
          "content-length": String(PNG.length),
        },
        body: PNG,
      }),
    );
  const served = (tenant: "a" | "b") =>
    host.routes.brandingLogo.GET(t.request("/api/branding/logo", tenant));

  it("receives the logo upload for the request's tenant, and serves it from there", async () => {
    const response = await upload("a");
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).branding).toMatchObject({ hasLogo: true, logoVersion: 1 });
    expect(blobs.get("a:branding/logo")).toEqual({ bytes: PNG, contentType: "image/png" });
    // The bytes are the store's; the row keeps only the type and the version.
    const [row] = await t.sql<{ logo: Buffer | null; logo_type: string }>(
      "a",
      "select logo, logo_type from site_branding",
    );
    expect(row).toEqual({ logo: null, logo_type: "png" });

    const logo = await served("a");
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(PNG);
    expect((await served("b")).status).toBe(404);
  });

  it("removes the logo from the store", async () => {
    const response = await host.routes.adminBrandingLogo.DELETE(
      t.request("/api/admin/branding/logo", "a", {
        method: "DELETE",
        headers: { cookie: await adminOf("a"), origin: ORIGIN },
      }),
    );
    expect(response.status).toBe(200);
    expect(blobs.has("a:branding/logo")).toBe(false);
    expect((await served("a")).status).toBe(404);
  });
});

describe("a host email adapter", () => {
  it("receives a message sent through the request context, with its tenant", async () => {
    const ctx = await host.context(t.request("/", "b"));
    const message = { to: "ana@b.example", subject: "Welcome", text: "Hello." };
    await ctx!.adapters.email.send(ctx!.tenant, message);
    expect(mail).toEqual([{ tenant: expect.objectContaining({ id: "b" }), message }]);
  });
});
