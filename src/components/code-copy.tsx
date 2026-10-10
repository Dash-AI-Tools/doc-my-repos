"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea path (insecure context, denied permission).
  }
  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus();
  }
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
        className="cursor-pointer rounded border border-gray-300 bg-white/80 px-2 py-1 text-xs font-medium text-gray-800 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-gray-600 dark:bg-gray-900/80 dark:text-gray-100 dark:hover:bg-gray-800 dark:focus-visible:outline-blue-400"
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
