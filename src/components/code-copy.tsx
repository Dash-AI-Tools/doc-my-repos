"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { copyText } from "@/lib/copy-text";

/**
 * Adds a "Copy code" button to every code block inside `children` (the server-rendered, already
 * sanitized document HTML; the server never emits a button). Mermaid blocks are skipped.
 *
 * Each block's `pre` gets one host `<span class="dmr-copy-host">` after its `code`, and the
 * button is a React portal into that host, so the label is plain React text, not innerHTML.
 * The scan is idempotent: hosts are reused, and removed on cleanup, so re-rendering never
 * leaves two buttons.
 */

const HOST_CLASS = "dmr-copy-host";
const MERMAID_CLASS = "dmr-mermaid";

interface Target {
  readonly host: HTMLElement;
  readonly code: HTMLElement;
}

function CopyButton({ code }: { readonly code: HTMLElement }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function onClick() {
    const ok = await copyText(code.textContent ?? "");
    setState(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }

  return (
    <>
      <button
        type="button"
        aria-label="Copy code"
        onClick={() => void onClick()}
        className="cursor-pointer rounded border border-input bg-card px-2 py-1 text-xs font-medium text-card-foreground hover:bg-muted"
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Copy failed" : ""}
      </span>
    </>
  );
}

export function CodeCopyEnhancer({ children }: { readonly children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [targets, setTargets] = useState<readonly Target[]>([]);

  useEffect(() => {
    const container = root.current;
    if (container === null) return;
    const found: Target[] = [];
    const created: HTMLElement[] = [];
    for (const pre of container.querySelectorAll("pre")) {
      if (pre.classList.contains(MERMAID_CLASS)) continue;
      const code = Array.from(pre.children).find((c): c is HTMLElement => c.tagName === "CODE");
      if (code === undefined) continue;
      let host = Array.from(pre.children).find(
        (c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains(HOST_CLASS),
      );
      if (host === undefined) {
        host = document.createElement("span");
        host.className = HOST_CLASS;
        pre.appendChild(host);
        created.push(host);
      }
      found.push({ host, code });
    }
    setTargets(found);
    return () => {
      for (const host of created) host.remove();
    };
  }, [children]);

  return (
    <div ref={root}>
      {children}
      {targets.map(({ host, code }, i) =>
        createPortal(<CopyButton code={code} />, host, String(i)),
      )}
    </div>
  );
}
