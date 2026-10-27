import { describe, expect, it } from "vitest";

import { ProviderError } from "./shared";
import { MAX_SSE_EVENT_BYTES, parseSse, type SseMessage } from "./sse";

function bodyOf(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function collect(parts: string[]): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const message of parseSse(bodyOf(parts))) out.push(message);
  return out;
}

describe("parseSse", () => {
  it("parses events with and without an event name", async () => {
    expect(await collect(["event: a\ndata: 1\n\ndata: 2\n\n"])).toEqual([
      { event: "a", data: "1" },
      { event: "message", data: "2" },
    ]);
  });

  it("joins multi-line data and ignores comments and unknown fields", async () => {
    expect(await collect([": ping\nid: 7\ndata: a\ndata: b\n\n"])).toEqual([
      { event: "message", data: "a\nb" },
    ]);
  });

  it("handles LF, CRLF and CR line ends", async () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      expect(await collect([`data: x${eol}${eol}data: y${eol}${eol}`])).toEqual([
        { event: "message", data: "x" },
        { event: "message", data: "y" },
      ]);
    }
  });

  it("gives the same result however the bytes are split, including inside a CRLF", async () => {
    const text = "event: e\r\ndata: héllo\r\n\r\ndata: 2\n\n";
    const whole = await collect([text]);
    for (let i = 1; i < text.length; i += 1) {
      expect(await collect([text.slice(0, i), text.slice(i)])).toEqual(whole);
    }
    // One byte at a time, which also splits the multi-byte character.
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const out: SseMessage[] = [];
    for await (const message of parseSse(stream)) out.push(message);
    expect(out).toEqual(whole);
  });

  it("dispatches a final event that lacks its blank line", async () => {
    expect(await collect(["data: last"])).toEqual([{ event: "message", data: "last" }]);
  });

  it("throws malformed for a line or an event over the size limit", async () => {
    await expect(collect([`data: ${"x".repeat(MAX_SSE_EVENT_BYTES + 1)}`])).rejects.toMatchObject({
      kind: "malformed",
    });
    const lines = Array.from(
      { length: 10 },
      () => `data: ${"x".repeat(MAX_SSE_EVENT_BYTES / 4)}\n`,
    );
    await expect(collect([lines.join("") + "\n"])).rejects.toBeInstanceOf(ProviderError);
  });
});
