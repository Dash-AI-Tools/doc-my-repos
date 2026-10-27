"use client";

import dynamic from "next/dynamic";
import { Component, type ReactNode } from "react";

/**
 * Renders a stored OpenAPI / Swagger spec with Swagger UI (openapi-reference, decisions 5 and 6).
 *
 * The widget is loaded lazily and only in the browser (`ssr: false`), so it is never part of
 * another page's bundle. It receives the spec as data and a fixed, locked-down configuration
 * (`api-reference-config.ts`). If the widget or its chunk throws, the boundary shows a message and
 * the link to the source file instead of a broken page.
 */

const ApiReferenceWidget = dynamic(() => import("./api-reference-widget"), {
  ssr: false,
  loading: () => (
    <p role="status" className="text-sm text-muted-foreground">
      Loading API reference…
    </p>
  ),
});

export interface ApiReferenceProps {
  /** The stored, parsed spec. */
  readonly spec: object;
  /** Link to the spec file on GitHub, or null when it cannot be built. */
  readonly sourceUrl: string | null;
}

export function ApiReferenceFallback({ sourceUrl }: { readonly sourceUrl: string | null }) {
  return (
    <div role="alert" className="border border-border p-4 text-sm">
      <p>This API reference could not be displayed.</p>
      {sourceUrl ? (
        <p className="mt-2">
          <a href={sourceUrl} rel="noopener noreferrer" className="underline">
            View source on GitHub
          </a>
        </p>
      ) : null}
    </div>
  );
}

interface BoundaryProps {
  readonly sourceUrl: string | null;
  readonly children: ReactNode;
}

export class ApiReferenceErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? (
      <ApiReferenceFallback sourceUrl={this.props.sourceUrl} />
    ) : (
      this.props.children
    );
  }
}

export function ApiReference({ spec, sourceUrl }: ApiReferenceProps) {
  return (
    <div className="api-reference">
      <ApiReferenceErrorBoundary sourceUrl={sourceUrl}>
        <ApiReferenceWidget spec={spec} />
      </ApiReferenceErrorBoundary>
    </div>
  );
}
