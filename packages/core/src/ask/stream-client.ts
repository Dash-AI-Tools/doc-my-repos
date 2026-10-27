import { decodeEvent, type AskEvent } from "./events";

/**
 * Reads the server-sent events of `POST /api/ask` from a response body: frames are separated by a
 * blank line, may be split across chunks, and anything that is not one of our events is skipped.
 * The text of a frame is parsed as JSON data only; nothing in it is ever interpreted as markup.
 */
export async function* readAskEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AskEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = decodeEvent(frame);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      const event = decodeEvent(buffer);
      if (event) yield event;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
