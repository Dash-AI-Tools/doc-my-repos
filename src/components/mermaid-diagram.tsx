"use client";

import { useEffect, useId, useState } from "react";

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
 * one module-level queue. `initialize` runs once; it runs again only if the theme input changes
 * (the hook for theme-aware re-rendering). Stale results (source or theme changed, or unmounted)
 * are dropped.
 */

export type MermaidTheme = "light" | "dark";

type MermaidApi = (typeof import("mermaid"))["default"];

/** Longest diagram source Mermaid accepts, in characters. Matches the server cap in bytes. */
export const MAX_TEXT_SIZE = 50_000;
/** Most edges per diagram. */
export const MAX_EDGES = 500;

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
  return mermaidPromise;
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

/** Renders `source` to an SVG string, one call at a time. Rejects with the Mermaid error. */
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
      const { svg } = await mermaid.render(id, source);
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

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() === "" ? "The diagram could not be rendered." : text;
}

/** `useId` output (`:r1:`) reduced to what is safe in an element id and a CSS selector. */
function safeId(raw: string): string {
  return `dmr-mermaid-${raw.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

export function MermaidDiagram({
  source,
  theme = "light",
}: {
  readonly source: string;
  readonly theme?: MermaidTheme;
}) {
  const baseId = safeId(useId());
  const [state, setState] = useState<{ readonly key: string; readonly value: State }>({
    key: "",
    value: { status: "loading" },
  });
  const key = `${theme}\n${source}`;

  useEffect(() => {
    let cancelled = false;
    renderDiagram(source, baseId, theme).then(
      (svg) => {
        if (!cancelled) setState({ key, value: { status: "ready", svg } });
      },
      (error: unknown) => {
        if (!cancelled) setState({ key, value: { status: "error", message: messageOf(error) } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, theme, baseId, key]);

  // Until the current input has a result, show the source (or the previous diagram's absence).
  const current = state.key === key ? state.value : ({ status: "loading" } as const);

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

  if (current.status === "error") {
    return (
      <div className="dmr-mermaid-error my-4">
        <pre>
          <code>{source}</code>
        </pre>
        <p role="alert">{current.message}</p>
      </div>
    );
  }

  return (
    <div className="dmr-mermaid-loading my-4" aria-busy="true">
      <pre>
        <code>{source}</code>
      </pre>
    </div>
  );
}
