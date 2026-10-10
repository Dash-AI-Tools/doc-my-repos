"use client";

import { useEffect, useId, useState } from "react";

import { useMermaidTheme } from "./use-mermaid-theme";

/**
 * Renders one Mermaid diagram in the browser (task 7.6, design decision 7). Mermaid is imported
 * lazily, only once a diagram is mounted, so documents without diagrams never load it.
 *
 * Security
 *  - `securityLevel: "strict"` is the only level used: Mermaid encodes HTML in labels, disables
 *    click handlers and sanitizes the SVG it returns with DOMPurify. Never `loose`, never
 *    `sandbox`, no `htmlLabels` override, no `dompurifyConfig`.
 *  - The source is author text and only ever goes to `mermaid.render` as a string.
 *  - The single HTML sink is `dangerouslySetInnerHTML` with the SVG string that `mermaid.render`
 *    returned in strict mode. No author string reaches it: on any failure the source is shown as
 *    React text.
 *  - Limits cap CPU per diagram (`maxTextSize`, `maxEdges`).
 *
 * Mermaid's `render` is not re-entrant and `initialize` is global, so every render runs through
 * one module-level queue. `initialize` runs once; it runs again only if the theme changes. Stale
 * results (source or theme changed, or unmounted) are dropped.
 *
 * Theme (task 7.7)
 *  - The theme comes from `next-themes` through `useMermaidTheme` unless a `theme` prop is given.
 *    Light maps to Mermaid's `default` theme and dark to `dark`. The app has no CSS color tokens
 *    yet (group 8), so the built-in themes are used instead of `base` + `themeVariables`; switch
 *    to `base` there once tokens exist.
 *  - A theme change re-renders the diagram. The previous SVG (or error) stays on screen until the
 *    new result is ready, so there is no flash of the source and no layout jump. Each render call
 *    configures its own theme inside the queue, so a late result for the old theme is dropped by
 *    the effect cleanup and can never overwrite the new one.
 *
 * Failures (all shown as the source plus a `role="alert"` message, never as HTML)
 *  - Mermaid rejects: its message, sanitized for display (`displayMessage`).
 *  - A render exceeds `RENDER_TIMEOUT_MS`: fixed message; the queue is released.
 *  - The mermaid chunk fails to load: fixed message; the failed import is not cached, so the next
 *    source or theme change retries.
 *  - The source is empty (nothing is rendered) or longer than `MAX_TEXT_SIZE` (mermaid is not
 *    called).
 *
 * Contract for the enlarge view (task 7.8)
 *  - The ready state is `div.dmr-mermaid-diagram[role="img"]`; its `innerHTML` is the one SVG
 *    string (strict-mode output). The enlarge dialog can read it from there, or call the exported
 *    `renderDiagram(source, id, theme)` for its own copy. Wrap the element in a button; do not
 *    change the SVG.
 */

export type MermaidTheme = "light" | "dark";

type MermaidApi = (typeof import("mermaid"))["default"];

/** Longest diagram source Mermaid accepts, in characters. Matches the server cap in bytes. */
export const MAX_TEXT_SIZE = 50_000;
/** Most edges per diagram. */
export const MAX_EDGES = 500;
/** A render that takes longer than this is abandoned so it cannot block the queue. */
export const RENDER_TIMEOUT_MS = 10_000;
/** Longest error text shown, in characters. */
export const MAX_MESSAGE_LENGTH = 400;
const MAX_MESSAGE_LINES = 8;

const TIMEOUT_MESSAGE = "The diagram took too long to render.";
const LOAD_MESSAGE = "Diagram library failed to load.";
const TOO_LARGE_MESSAGE = "The diagram source is too large to render.";
const GENERIC_MESSAGE = "The diagram could not be rendered.";

class DiagramError extends Error {
  constructor(readonly display: string) {
    super(display);
  }
}

let mermaidPromise: Promise<MermaidApi> | undefined;
let initializedTheme: MermaidTheme | undefined;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

function loadMermaid(): Promise<MermaidApi> {
  if (mermaidPromise === undefined) {
    const loading = import("mermaid").then((m) => m.default);
    mermaidPromise = loading;
    // A failed import is not cached, so a later diagram can retry.
    loading.catch(() => {
      if (mermaidPromise === loading) mermaidPromise = undefined;
    });
  }
  return mermaidPromise.catch(() => {
    throw new DiagramError(LOAD_MESSAGE);
  });
}

function configure(mermaid: MermaidApi, theme: MermaidTheme): void {
  if (initializedTheme === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "default",
    maxTextSize: MAX_TEXT_SIZE,
    maxEdges: MAX_EDGES,
    suppressErrorRendering: true,
  });
  initializedTheme = theme;
}

/** Test hook: forget module state. */
export function resetMermaidForTests(): void {
  mermaidPromise = undefined;
  initializedTheme = undefined;
  queue = Promise.resolve();
  counter = 0;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DiagramError(TIMEOUT_MESSAGE)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Renders `source` to an SVG string, one call at a time. Rejects with the Mermaid error, or with a
 * fixed-message error on timeout or when the library cannot load. A hung render is abandoned after
 * `RENDER_TIMEOUT_MS`, which releases the queue for the next diagram.
 */
export function renderDiagram(
  source: string,
  baseId: string,
  theme: MermaidTheme,
): Promise<string> {
  const run = async (): Promise<string> => {
    const mermaid = await loadMermaid();
    configure(mermaid, theme);
    const id = `${baseId}-${++counter}`;
    try {
      const { svg } = await withTimeout(
        Promise.resolve().then(() => mermaid.render(id, source)),
        RENDER_TIMEOUT_MS,
      );
      return svg;
    } finally {
      // On a syntax error Mermaid can leave its scratch element in the body.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

type State =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly svg: string }
  | { readonly status: "error"; readonly message: string };

function isDisallowed(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200b ||
    code === 0xfeff
  );
}

/**
 * Error text reduced for display as a React text node: line breaks kept (Mermaid's parse errors
 * point at the column with a caret), control and bidi characters removed, generated element ids
 * removed, capped in lines and characters. Never HTML.
 */
export function displayMessage(error: unknown): string {
  if (error instanceof DiagramError) return error.display;
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  let text = "";
  for (const char of raw.replace(/\r\n?/g, "\n")) {
    if (!isDisallowed(char.codePointAt(0) ?? 0)) text += char;
  }
  text = text
    .replace(/\bd?dmr-mermaid-[A-Za-z0-9_-]+/g, "")
    .split("\n")
    .slice(0, MAX_MESSAGE_LINES)
    .join("\n")
    .trim();
  if (text === "") return GENERIC_MESSAGE;
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}\u2026` : text;
}

/** `useId` output (`:r1:`) reduced to what is safe in an element id and a CSS selector. */
function safeId(raw: string): string {
  return `dmr-mermaid-${raw.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

interface Result {
  /** Source the result belongs to. A theme-only change keeps the result visible meanwhile. */
  readonly source: string;
  /** Source and theme the result belongs to. */
  readonly key: string;
  readonly value: State;
}

export function MermaidDiagram({
  source,
  theme: themeProp,
}: {
  readonly source: string;
  /** Overrides the theme from `next-themes` (tests, previews). */
  readonly theme?: MermaidTheme;
}) {
  const appTheme = useMermaidTheme();
  const theme = themeProp ?? appTheme;
  const baseId = safeId(useId());
  const [result, setResult] = useState<Result>({
    source: "",
    key: "",
    value: { status: "loading" },
  });
  const key = `${theme}\n${source}`;
  const empty = source.trim() === "";
  const tooLarge = source.length > MAX_TEXT_SIZE;

  useEffect(() => {
    if (empty || tooLarge) return;
    let cancelled = false;
    renderDiagram(source, baseId, theme).then(
      (svg) => {
        if (!cancelled) setResult({ source, key, value: { status: "ready", svg } });
      },
      (error: unknown) => {
        if (!cancelled) {
          setResult({ source, key, value: { status: "error", message: displayMessage(error) } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, theme, baseId, key, empty, tooLarge]);

  if (empty) {
    return (
      <p className="dmr-mermaid-empty my-4 text-sm text-gray-600 dark:text-gray-400">
        Empty diagram.
      </p>
    );
  }

  if (tooLarge) return <ErrorBox source={source} message={TOO_LARGE_MESSAGE} />;

  // Current input has a result: show it. A theme-only change keeps the previous result (same
  // source) on screen until the new one arrives. Otherwise show the source while loading.
  const current: State =
    result.key === key || result.source === source ? result.value : { status: "loading" };

  if (current.status === "ready") {
    return (
      <div
        role="img"
        aria-label="Mermaid diagram"
        className="dmr-mermaid-diagram my-4 overflow-x-auto"
        // Strict-mode SVG returned by mermaid.render; see the header comment.
        dangerouslySetInnerHTML={{ __html: current.svg }}
      />
    );
  }

  if (current.status === "error") return <ErrorBox source={source} message={current.message} />;

  return (
    <div className="dmr-mermaid-loading my-4" aria-busy="true">
      <pre className="overflow-x-auto rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
        <code>{source}</code>
      </pre>
    </div>
  );
}

function ErrorBox({ source, message }: { readonly source: string; readonly message: string }) {
  return (
    <div
      role="group"
      aria-label="Diagram could not be rendered"
      className="dmr-mermaid-error my-4 rounded border border-red-300 bg-red-50 p-3 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
    >
      <pre className="overflow-x-auto rounded border border-red-200 bg-white p-3 text-sm text-gray-800 dark:border-red-900 dark:bg-gray-900 dark:text-gray-200">
        <code>{source}</code>
      </pre>
      <p role="alert" className="mt-2 text-sm font-medium whitespace-pre-wrap">
        {message}
      </p>
    </div>
  );
}
