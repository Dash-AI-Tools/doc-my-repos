"use client";

import { useState, type ReactNode } from "react";

import type { Block, Inline } from "@docmyrepos/core/internal/ask/answer";

/**
 * Renders the safe tree from `sanitizeAnswer` as React elements (ask-the-docs design decision 4).
 * There is no `dangerouslySetInnerHTML`, no `<img>` and no `<a>` built from model text: the tree
 * cannot hold them. The only links are citation markers, which point at the page's own reference
 * list by number, and the numbers were checked against the references the server sent.
 */

function renderInline(nodes: readonly Inline[], idPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "strong":
        return <strong key={i}>{renderInline(node.children, idPrefix)}</strong>;
      case "em":
        return <em key={i}>{renderInline(node.children, idPrefix)}</em>;
      case "code":
        return (
          <code key={i} className="rounded bg-muted px-1 py-0.5 text-[0.9em] break-words">
            {node.text}
          </code>
        );
      case "cite":
        return (
          <sup key={i}>
            <a
              href={`#${idPrefix}-ref-${node.n}`}
              aria-label={`Reference ${node.n}`}
              className="mx-0.5 inline-block min-h-6 min-w-6 text-center text-primary underline underline-offset-2"
            >
              [{node.n}]
            </a>
          </sup>
        );
    }
  });
}

function CodeBlock({
  text,
  language,
}: {
  readonly text: string;
  readonly language: string | null;
}) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="my-3 overflow-hidden rounded-md border border-border bg-muted">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground">
        <span>{language ?? "code"}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="min-h-6 min-w-6 cursor-pointer rounded px-2 py-0.5 text-xs text-foreground hover:underline"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* Focusable so the wide code can be scrolled with the keyboard. */}
      <pre tabIndex={0} className="overflow-x-auto p-3 text-sm">
        <code>{text}</code>
      </pre>
      <span role="status" className="sr-only">
        {copied ? "Code copied" : ""}
      </span>
    </div>
  );
}

export function AskAnswer({
  blocks,
  idPrefix,
}: {
  readonly blocks: readonly Block[];
  /** Unique per message, so citation links find their own reference list. */
  readonly idPrefix: string;
}) {
  return (
    <div className="flex flex-col gap-3 break-words [overflow-wrap:anywhere]">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "paragraph":
            return <p key={i}>{renderInline(block.children, idPrefix)}</p>;
          case "list": {
            const items = block.items.map((item, j) => (
              <li key={j}>{renderInline(item, idPrefix)}</li>
            ));
            return block.ordered ? (
              <ol key={i} className="list-decimal pl-6">
                {items}
              </ol>
            ) : (
              <ul key={i} className="list-disc pl-6">
                {items}
              </ul>
            );
          }
          case "code":
            return <CodeBlock key={i} text={block.text} language={block.language} />;
        }
      })}
    </div>
  );
}
