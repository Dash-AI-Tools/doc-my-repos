import { describe, expect, it } from "vitest";

import { encodeEvent, type AskEvent } from "./events";
import { readAskEvents } from "./stream-client";

const EVENTS: AskEvent[] = [
  { event: "status", data: { state: "searching" } },
  { event: "references", data: { references: [] } },
  { event: "delta", data: { text: "héllo\nwith a newline and data: inside" } },
  { event: "done", data: { outcome: "ok" } },
];

function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function read(chunks: Uint8Array[]): Promise<AskEvent[]> {
  const out: AskEvent[] = [];
  for await (const event of readAskEvents(bodyOf(chunks))) out.push(event);
  return out;
}

const WIRE = new TextEncoder().encode(EVENTS.map(encodeEvent).join(""));

describe("readAskEvents", () => {
  it("reads whole frames", async () => {
    expect(await read([WIRE])).toEqual(EVENTS);
  });

  it("reads the same events however the bytes are split, even inside a character", async () => {
    for (let i = 1; i < WIRE.length; i += 3) {
      expect(await read([WIRE.slice(0, i), WIRE.slice(i)])).toEqual(EVENTS);
    }
    expect(await read([...WIRE].map((b) => Uint8Array.of(b)))).toEqual(EVENTS);
  });

  it("keeps newlines inside text safe: the JSON is on one line", () => {
    expect(encodeEvent(EVENTS[2]!).split("\n\n")).toHaveLength(2); // one frame plus the empty tail
  });

  it("skips frames that are not our events, and comments", async () => {
    const text = `: ping\n\nevent: bogus\ndata: {}\n\nevent: delta\ndata: not json\n\n${encodeEvent(EVENTS[3]!)}`;
    expect(await read([new TextEncoder().encode(text)])).toEqual([EVENTS[3]]);
  });

  it("reads a final frame that lacks its blank line", async () => {
    const frame = encodeEvent(EVENTS[3]!).trimEnd();
    expect(await read([new TextEncoder().encode(frame)])).toEqual([EVENTS[3]]);
  });

  it("is empty for an empty body", async () => {
    expect(await read([])).toEqual([]);
  });
});
