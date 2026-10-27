import { generateKeyPairSync } from "node:crypto";

import type { Db } from "../../packages/server/src/db/client";
import { configSchema } from "../../packages/core/src/config/schema";
import { parseEncryptionKey } from "../../packages/server/src/settings/crypto";
import { saveWorkspace } from "../../packages/server/src/settings/store";
import { E2E_ENCRYPTION_KEY, fakeProviderUrl, type DatabaseKind } from "./stack";

/**
 * The workspace settings an e2e database starts with (workspace-settings: they live in the
 * database now, not in a config file). Saved through the same code an administrator's save uses.
 *
 * Every database starts with a GitHub App configured (placeholder ids and a throwaway key), so an
 * administrator is not sent to the first-run setup page; only `settings` starts with nothing, for
 * the specs that walk through that setup.
 *
 * - `commentsoff`: comments are off.
 * - `agentoff`: the MCP endpoint for AI agents is off.
 * - `ask`: small Ask limits so the specs can reach them (per user: 4 questions in ten minutes, 2
 *   answers at once), and the fake model provider as the OpenAI-compatible endpoint, so an admin
 *   can turn Ask on there. No other database has a provider.
 */
export async function seedSettings(db: Db, kind: DatabaseKind): Promise<void> {
  if (kind === "settings") return;
  const key = parseEncryptionKey(E2E_ENCRYPTION_KEY).key;
  if (key === null) throw new Error("The e2e encryption key is invalid");

  const extra: Record<string, unknown> =
    kind === "commentsoff"
      ? { comments: { enabled: false } }
      : kind === "agentoff"
        ? { mcp: { enabled: false } }
        : kind === "ask"
          ? {
              ask: { questionsPerTenMinutes: 4, maxConcurrent: 2 },
              providers: { openaiBaseUrl: `${fakeProviderUrl}/v1` },
            }
          : {};
  const settings = configSchema.parse({ github: { appId: 1, installationId: 1 }, ...extra });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const saved = await saveWorkspace(db, key, {
    userId: null,
    expectedVersion: 0,
    settings,
    secrets: { github_private_key: privateKey },
  });
  if (!saved.ok) throw new Error("Seeding the e2e workspace settings was refused");
}
