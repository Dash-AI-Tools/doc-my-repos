import { ProviderError } from "./shared";

export interface SseMessage {
  readonly event: string;
  readonly data: string;
}

/** One SSE line or event larger than this is a broken or hostile stream. */
export const MAX_SSE_EVENT_BYTES = 256 * 1024;

/**
 * Parses a `text/event-stream` body into messages: `event:` and `data:` fields, comments ignored,
 * `\n`, `\r\n` and `\r` line ends, a blank line dispatching the event. Strict on size: a line or
 * event over `MAX_SSE_EVENT_BYTES` throws a `malformed` `ProviderError`. A final event without its
 * blank line is dispatched at the end of the stream.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let eventBytes = 0;

  const flush = (): SseMessage | null => {
    const message = data.length > 0 ? { event: event || "message", data: data.join("\n") } : null;
    event = "";
    data = [];
    eventBytes = 0;
    return message;
  };

  const handleLine = (line: string): SseMessage | null => {
    if (line === "") return flush();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    eventBytes += line.length;
    if (eventBytes > MAX_SSE_EVENT_BYTES) throw new ProviderError("malformed");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let start = 0;
      for (;;) {
        const lf = buffer.indexOf("\n", start);
        const cr = buffer.indexOf("\r", start);
        let end = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
        if (end === -1) break;
        // A trailing `\r` may be half of `\r\n`: wait for the next chunk to know.
        if (buffer[end] === "\r" && end === buffer.length - 1) break;
        const line = buffer.slice(start, end);
        end += buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        start = end;
        const message = handleLine(line);
        if (message) yield message;
      }
      buffer = buffer.slice(start);
      if (buffer.length > MAX_SSE_EVENT_BYTES) throw new ProviderError("malformed");
    }
    buffer += decoder.decode();
    if (buffer !== "") {
      const message = handleLine(buffer.replace(/\r$/, ""));
      if (message) yield message;
    }
    const last = flush();
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
