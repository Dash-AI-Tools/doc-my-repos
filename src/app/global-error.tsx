"use client";

import { GlobalErrorContent, globalErrorCss } from "@/components/global-error-view";

/**
 * Last-resort error boundary: replaces the root layout when the layout itself crashes (see
 * `src/components/global-error-view.tsx` for what it shows and why it styles itself). It must
 * render its own `<html>` and `<body>`.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <head>
        <meta name="color-scheme" content="light dark" />
        <title>Something went wrong · DocMyRepos</title>
        <style>{globalErrorCss()}</style>
      </head>
      <body>
        <GlobalErrorContent error={error} reset={reset} />
      </body>
    </html>
  );
}
