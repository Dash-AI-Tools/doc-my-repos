import { describe, expect, it } from "vitest";

import { ASK_ERROR_MESSAGES, formatWait, messageForHttp } from "./messages";

describe("formatWait", () => {
  it("reads naturally at each scale", () => {
    expect(formatWait(1)).toBe("1 second");
    expect(formatWait(45)).toBe("45 seconds");
    expect(formatWait(60)).toBe("1 minute");
    expect(formatWait(61)).toBe("2 minutes");
    expect(formatWait(3600)).toBe("1 hour");
    expect(formatWait(19 * 3600 + 1)).toBe("20 hours");
    expect(formatWait(0)).toBe("1 second");
  });
});

describe("messageForHttp", () => {
  it("says when a rate-limited user can ask again", () => {
    expect(messageForHttp(429, { code: "rate_limited", retryAfterSeconds: 300 })).toBe(
      "You have reached your question limit. You can ask again in 5 minutes.",
    );
    expect(messageForHttp(429, { code: "rate_limited" })).toMatch(/Try again later/);
  });

  it("tells a user with a question in flight to wait", () => {
    expect(messageForHttp(429, { code: "user_busy" })).toMatch(/current question/);
  });

  it("maps the other statuses to fixed text", () => {
    expect(messageForHttp(503, {})).toBe(ASK_ERROR_MESSAGES.busy);
    expect(messageForHttp(401, {})).toMatch(/Sign in again/);
    expect(messageForHttp(404, {})).toBe("Ask is not available.");
    expect(messageForHttp(400, {})).toMatch(/Shorten/);
    expect(messageForHttp(413, {})).toMatch(/Shorten/);
    expect(messageForHttp(500, {})).toBe(ASK_ERROR_MESSAGES.unavailable);
  });

  it("never echoes anything from the body", () => {
    const text = messageForHttp(429, {
      code: "rate_limited",
      retryAfterSeconds: 60,
      error: "SECRET",
    } as never);
    expect(text).not.toContain("SECRET");
  });
});
