import * as crypto from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SIGNATURE_HEADER, verifyWebhookSignature } from "./verify";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const SECRET = "SENTINEL-webhook-secret-7d21b0";
const BODY = Buffer.from('{"zen":"Keep it logically awesome.","hook_id":1}', "utf8");

function sign(body: Uint8Array, secret = SECRET): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

beforeEach(() => {
  vi.mocked(crypto.timingSafeEqual).mockClear();
});

describe("verifyWebhookSignature", () => {
  it("uses the lower-case X-Hub-Signature-256 header name", () => {
    expect(SIGNATURE_HEADER).toBe("x-hub-signature-256");
  });

  it("accepts GitHub's signature of the exact bytes", () => {
    expect(verifyWebhookSignature(BODY, sign(BODY), SECRET)).toBe(true);
    expect(verifyWebhookSignature(new Uint8Array(BODY), sign(BODY), SECRET)).toBe(true);
  });

  it("matches the example from GitHub's documentation", () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
    const body = Buffer.from("Hello, World!", "utf8");
    const header = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(verifyWebhookSignature(body, header, "It's a Secret to Everybody")).toBe(true);
  });

  it("compares digests with timingSafeEqual on equal-length buffers", () => {
    expect(verifyWebhookSignature(BODY, sign(BODY), SECRET)).toBe(true);
    expect(verifyWebhookSignature(BODY, sign(BODY, `${SECRET}x`), SECRET)).toBe(false);
    const calls = vi.mocked(crypto.timingSafeEqual).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [a, b] of calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });

  it("rejects a body changed by one byte", () => {
    const tampered = Buffer.from(BODY);
    tampered[5] = (tampered[5] as number) ^ 1;
    expect(verifyWebhookSignature(tampered, sign(BODY), SECRET)).toBe(false);
    expect(
      verifyWebhookSignature(Buffer.concat([BODY, Buffer.from(" ")]), sign(BODY), SECRET),
    ).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifyWebhookSignature(BODY, sign(BODY, "another-secret-0123456"), SECRET)).toBe(false);
  });

  it("rejects the signature of a re-serialised body", () => {
    const pretty = Buffer.from(JSON.stringify(JSON.parse(BODY.toString("utf8")), null, 2));
    expect(verifyWebhookSignature(BODY, sign(pretty), SECRET)).toBe(false);
    expect(verifyWebhookSignature(pretty, sign(BODY), SECRET)).toBe(false);
  });

  it("hashes raw bytes, including a BOM and bytes that are not valid UTF-8", () => {
    const body = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"a":"é\u{1f600}"}', "utf8"),
      Buffer.from([0x00, 0xff, 0xfe, 0xc3]),
    ]);
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
    // Decoding and re-encoding replaces the invalid bytes, and the signature no longer matches.
    const reencoded = Buffer.from(body.toString("utf8"), "utf8");
    expect(verifyWebhookSignature(reencoded, sign(body), SECRET)).toBe(false);
  });

  it("verifies an empty body", () => {
    const empty = new Uint8Array(0);
    expect(verifyWebhookSignature(empty, sign(empty), SECRET)).toBe(true);
  });

  it.each([
    ["missing", null],
    ["undefined", undefined],
    ["empty", ""],
    ["prefix only", "sha256="],
  ])("rejects a %s header", (_name, header) => {
    expect(verifyWebhookSignature(BODY, header, SECRET)).toBe(false);
  });

  it("rejects the legacy sha1 signature", () => {
    const sha1 = `sha1=${crypto.createHmac("sha1", SECRET).update(BODY).digest("hex")}`;
    expect(verifyWebhookSignature(BODY, sha1, SECRET)).toBe(false);
  });

  it("rejects malformed signatures without throwing", () => {
    const hex = sign(BODY).slice("sha256=".length);
    const headers = [
      hex, // no prefix
      `SHA256=${hex}`, // wrong prefix case
      `sha512=${hex}`, // wrong algorithm
      `sha256:${hex}`, // wrong separator
      `sha256= ${hex}`, // space inside
      `sha256=${hex.slice(1)}`, // odd length
      `sha256=${hex.slice(2)}`, // too short
      `sha256=${hex}00`, // too long
      `sha256=${hex.slice(0, -1)}g`, // not hex
      `sha256=${"z".repeat(64)}`,
      `${sign(BODY)}, ${sign(BODY)}`, // a repeated header, as Headers joins it
      `sha256=${hex}\n`,
      "x".repeat(100_000),
    ];
    for (const header of headers) {
      expect(() => verifyWebhookSignature(BODY, header, SECRET)).not.toThrow();
      expect(verifyWebhookSignature(BODY, header, SECRET), header.slice(0, 80)).toBe(false);
    }
  });

  it("accepts lower-case hex only (GitHub's form), not upper case", () => {
    const upper = `sha256=${sign(BODY).slice("sha256=".length).toUpperCase()}`;
    expect(verifyWebhookSignature(BODY, upper, SECRET)).toBe(false);
  });

  it("never verifies with an empty or short secret, even when the signature matches it", () => {
    for (const secret of ["", "short", "0123456789abcde"]) {
      expect(verifyWebhookSignature(BODY, sign(BODY, secret), secret)).toBe(false);
    }
    const sixteen = "0123456789abcdef";
    expect(verifyWebhookSignature(BODY, sign(BODY, sixteen), sixteen)).toBe(true);
  });

  it("rejects inputs of the wrong type without throwing", () => {
    const loose = verifyWebhookSignature as (
      body: unknown,
      header: unknown,
      secret: unknown,
    ) => boolean;
    expect(loose(BODY.toString("utf8"), sign(BODY), SECRET)).toBe(false);
    expect(loose(BODY, 123, SECRET)).toBe(false);
    expect(loose(BODY, sign(BODY), undefined)).toBe(false);
    expect(loose(null, sign(BODY), SECRET)).toBe(false);
  });
});
