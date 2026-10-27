---
type: Decision
title: Render Mermaid diagrams in the browser
description: The server only marks Mermaid code blocks. The browser loads Mermaid on demand, draws the diagram in strict mode and redraws it when the theme changes.
tags: [decisions, markdown, mermaid]
status: accepted
sources:
  - openspec/changes/archive/2026-10-14-docmyrepos-mvp/design.md
  - packages/server/src/markdown/mermaid.ts
  - packages/ui/src/components/mermaid-diagram.tsx
  - packages/ui/src/components/mermaid-svg.ts
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2999-01-01
---

# Render Mermaid diagrams in the browser

## Context

Diagrams are common in documentation, and the portal should draw them in both themes. Mermaid needs a DOM to measure text. Its source comes from untrusted documents.

## Decision

On the server, a rehype plugin turns each fenced `mermaid` block into a `<pre class="dmr-mermaid">` placeholder that holds the source as text. Blocks over 50 KB, and blocks past the twentieth in one document, stay ordinary code blocks. In the browser, a component imports Mermaid only when a diagram is on the page, initializes it with `securityLevel: 'strict'`, and renders each diagram. The theme comes from `next-themes`, and a theme switch redraws the diagrams without a reload. A diagram that fails to render shows its source and the error message and leaves the page intact. A reader can open a diagram in an enlarged, pannable view.

## Consequences

- No headless browser on the server, and no SVG produced from untrusted input there.
- The Mermaid bundle is several chunks, loaded only on pages that contain a diagram.
- Diagrams need JavaScript. Without it the reader sees the source as a code block.
- Strict mode alone did not stop an external image in a label from loading, which would let a document track readers. The renderer therefore turns HTML labels off, filters the returned SVG through an allow-list, refuses image shapes, and protects those settings from `%%{init}%%` directives. As a result, HTML in a label shows as literal text.
- The content security policy must allow Mermaid's inline styles, the reason for `'unsafe-inline'` in `style-src`.

## Alternatives considered

- **Render to SVG on the server.** Needs a headless browser in the runtime and a larger attack surface, and was rejected.
- **Skip diagrams.** Cheapest, but diagrams in Markdown are common enough that readers would see broken pages.

The diagrams in the [architecture pages](../architecture/overview.md) are rendered this way, and the [security model](../architecture/security.md#mermaid) lists the controls.
