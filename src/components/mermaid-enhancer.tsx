"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { MermaidDiagram, type MermaidTheme } from "./mermaid-diagram";
import { useMermaidTheme } from "./use-mermaid-theme";

/**
 * Turns every `pre.dmr-mermaid > code.language-mermaid` in `children` (the server-rendered,
 * sanitized document HTML) into a diagram. Same pattern as `CodeCopyEnhancer`: each block gets
 * one host `<div class="dmr-mermaid-host">` placed after its `pre`, and `MermaidDiagram` is a
 * React portal into that host. Without JavaScript the `pre` with the source stays visible; once
 * enhanced it is hidden (`hidden`), and cleanup removes the host and shows it again.
 *
 * The scan is idempotent: hosts are reused, and a document without Mermaid blocks renders no
 * diagram, so `mermaid` is never imported for it (the import lives in `MermaidDiagram`).
 *
 * The theme comes from `next-themes` (`useMermaidTheme`) unless the `theme` prop is set; a change
 * re-renders every diagram. Contract for the enlarge view (task 7.8): each diagram lives in
 * `div.dmr-mermaid-host > div.dmr-mermaid-diagram[role="img"]`, whose `innerHTML` is the SVG.
 */

const HOST_CLASS = "dmr-mermaid-host";
const MERMAID_CLASS = "dmr-mermaid";

interface Target {
  readonly host: HTMLElement;
  readonly source: string;
}

export function MermaidEnhancer({
  children,
  theme: themeProp,
}: {
  readonly children: ReactNode;
  /** Overrides the theme from `next-themes` (tests, previews). */
  readonly theme?: MermaidTheme;
}) {
  const appTheme = useMermaidTheme();
  const theme = themeProp ?? appTheme;
  const root = useRef<HTMLDivElement>(null);
  const [targets, setTargets] = useState<readonly Target[]>([]);

  useEffect(() => {
    const container = root.current;
    if (container === null) return;
    const found: Target[] = [];
    const created: HTMLElement[] = [];
    const hidden: HTMLElement[] = [];
    for (const pre of container.querySelectorAll<HTMLElement>(`pre.${MERMAID_CLASS}`)) {
      const code = Array.from(pre.children).find(
        (c): c is HTMLElement => c.tagName === "CODE" && c.classList.contains("language-mermaid"),
      );
      if (code === undefined) continue;
      const next = pre.nextElementSibling;
      let host =
        next instanceof HTMLElement && next.classList.contains(HOST_CLASS) ? next : undefined;
      if (host === undefined) {
        host = document.createElement("div");
        host.className = HOST_CLASS;
        pre.after(host);
        created.push(host);
      }
      if (!pre.hidden) {
        pre.hidden = true;
        hidden.push(pre);
      }
      found.push({ host, source: code.textContent ?? "" });
    }
    setTargets(found);
    return () => {
      for (const host of created) host.remove();
      for (const pre of hidden) pre.hidden = false;
    };
  }, [children]);

  return (
    <div ref={root}>
      {children}
      {targets.map(({ host, source }, i) =>
        createPortal(<MermaidDiagram source={source} theme={theme} />, host, String(i)),
      )}
    </div>
  );
}
