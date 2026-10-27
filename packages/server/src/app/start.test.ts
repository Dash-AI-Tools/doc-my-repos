import { describe, expect, it, vi } from "vitest";

import type { bootSyncScheduler } from "../sync/schedule-runtime";
import { recordingLogger } from "../test-logger";
import { parseEncryptionKey } from "../settings/crypto";
import { loadConfig } from "./config";
import { startApp } from "./start";
import type { SecretsAdapter } from "./types";

const ENV = {
  DATABASE_URL: "postgres://docmyrepos:db-password@127.0.0.1:5432/docmyrepos",
  SYNC_SECRET: "sync-secret-0123456",
  SESSION_SECRET: "session-secret-01234567890",
  SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

function setup(env: Record<string, string | undefined>, secrets?: SecretsAdapter) {
  const recorder = recordingLogger();
  const bootScheduler = vi.fn<typeof bootSyncScheduler>(async () => null);
  const runtime = { started: false };
  const start = () =>
    startApp(loadConfig(env), runtime, {
      log: recorder.log,
      bootScheduler,
      ...(secrets ? { secrets } : {}),
    });
  return { recorder, bootScheduler, start };
}

describe("app start", () => {
  it("boots the scheduler with the startup configuration and logs nothing when all is valid", async () => {
    const { recorder, bootScheduler, start } = setup(ENV);
    await start();
    expect(bootScheduler).toHaveBeenCalledTimes(1);
    expect(bootScheduler.mock.calls[0]?.[0]).toMatchObject({ env: ENV });
    expect(recorder.events()).toEqual([]);
  });

  it("does its work once per process however often it is called", async () => {
    const { bootScheduler, start } = setup(ENV);
    await Promise.all([start(), start()]);
    await start();
    expect(bootScheduler).toHaveBeenCalledTimes(1);
  });

  it("names invalid settings, a missing key and retired variables, without values", async () => {
    const env = {
      ...ENV,
      SESSION_SECRET: "replace-with-session-secret",
      SETTINGS_ENCRYPTION_KEY: undefined,
      GITHUB_WEBHOOK_SECRET: "an-old-secret-value",
    };
    const { recorder, bootScheduler, start } = setup(env);
    await start();
    expect(recorder.events()).toEqual([
      "config.env_invalid",
      "config.encryption_key_invalid",
      "config.retired_variables_ignored",
    ]);
    expect(recorder.find("config.retired_variables_ignored")[0]?.variables).toEqual([
      "GITHUB_WEBHOOK_SECRET",
    ]);
    expect(recorder.lines.join("")).not.toContain("an-old-secret-value");
    // The server keeps serving: the scheduler still boots (and decides for itself).
    expect(bootScheduler).toHaveBeenCalledTimes(1);
  });

  it("asks the secrets adapter for the built-in tenant's key, not the environment", async () => {
    const hostKey = parseEncryptionKey(Buffer.alloc(32, 9).toString("base64"));
    const encryptionKey = vi.fn<SecretsAdapter["encryptionKey"]>(async () => hostKey);
    const { recorder, start } = setup(
      { ...ENV, SETTINGS_ENCRYPTION_KEY: undefined },
      {
        encryptionKey,
      },
    );
    await start();
    expect(encryptionKey).toHaveBeenCalledWith(expect.objectContaining({ id: "default" }));
    expect(recorder.events()).toEqual([]);
  });

  it("reports a key the adapter cannot give, or an adapter that throws, and keeps serving", async () => {
    const missing = setup(ENV, {
      encryptionKey: async () => ({ key: null, problem: "no key for this tenant" }),
    });
    await missing.start();
    expect(missing.recorder.events()).toEqual(["config.encryption_key_invalid"]);
    const failing = setup(ENV, {
      encryptionKey: async () => {
        throw new Error("vault down: token=abc");
      },
    });
    await failing.start();
    expect(failing.recorder.events()).toEqual(["adapter.failed"]);
    expect(failing.recorder.lines.join("")).not.toContain("token=abc");
    expect(failing.bootScheduler).toHaveBeenCalledTimes(1);
  });
});
