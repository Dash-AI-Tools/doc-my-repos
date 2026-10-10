import { describe, expect, it } from "vitest";

import { acknowledgeOnly } from "./endpoint";
import { getWebhookDispatch, readConfiguredWebhookSecret } from "./service";

describe("readConfiguredWebhookSecret", () => {
  it("returns the trimmed secret from the environment", () => {
    expect(readConfiguredWebhookSecret({ GITHUB_WEBHOOK_SECRET: " SENTINEL-webhook-0123 " })).toBe(
      "SENTINEL-webhook-0123",
    );
  });

  it("returns null when the secret is missing or too short", () => {
    expect(readConfiguredWebhookSecret({})).toBeNull();
    expect(readConfiguredWebhookSecret({ GITHUB_WEBHOOK_SECRET: "short" })).toBeNull();
  });
});

describe("getWebhookDispatch", () => {
  it("acknowledges every event until the event router lands", () => {
    expect(getWebhookDispatch()).toBe(acknowledgeOnly);
  });
});
