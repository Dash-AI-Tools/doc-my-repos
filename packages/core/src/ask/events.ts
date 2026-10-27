/**
 * The server-sent events of `POST /api/ask` (ask-the-docs design decision 6), shared by the route
 * and the chat island so both sides agree on the shapes. Every value is data the server built; no
 * field carries markup or a link taken from model output.
 */

/** Fixed failure kinds; the page maps each to a fixed message. Never provider text. */
export type AskErrorKind = "unavailable" | "busy" | "timeout" | "malformed" | "filtered";

/** One retrieved excerpt as a reference. `href` is built by the server from stored data. */
export interface AskReference {
  /** The marker number the answer cites, `[n]`. */
  readonly n: number;
  readonly title: string;
  /** `owner/name`. */
  readonly repo: string;
  readonly path: string;
  readonly heading: string | null;
  /** Portal link to the document, ending in `#anchor` when the excerpt has a heading. */
  readonly href: string | null;
}

export type AskEvent =
  | { readonly event: "status"; readonly data: { readonly state: "searching" | "answering" } }
  | {
      readonly event: "references";
      readonly data: { readonly references: readonly AskReference[] };
    }
  | { readonly event: "delta"; readonly data: { readonly text: string } }
  | {
      readonly event: "done";
      /** `no_results`: nothing matched, the model was not called. `cut_off`: the output limit. */
      readonly data: { readonly outcome: "ok" | "cut_off" | "no_results" };
    }
  | { readonly event: "error"; readonly data: { readonly kind: AskErrorKind } };

/** Encodes one event as an SSE frame. Data is JSON on one line, so no value can inject a frame. */
export function encodeEvent(event: AskEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

const EVENT_NAMES: ReadonlySet<string> = new Set([
  "status",
  "references",
  "delta",
  "done",
  "error",
]);

/**
 * Reads one SSE frame (`event:` and `data:` lines) back into an event, or null if it is not one of
 * ours. Used by the client; the server never parses.
 */
export function decodeEvent(frame: string): AskEvent | null {
  let name = "";
  const data: string[] = [];
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!EVENT_NAMES.has(name) || data.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(data.join("\n"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return { event: name, data: parsed } as AskEvent;
  } catch {
    return null;
  }
}
