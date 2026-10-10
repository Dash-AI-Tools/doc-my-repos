"use client";

import Link from "next/link";

import { ERROR_ACTION, ErrorPanel } from "@/components/error-panel";

/**
 * Error boundary for every page below the root layout (task 9.2): the header and footer stay.
 * It handles UNEXPECTED errors (a bug); expected failures, such as an unreachable database on the
 * home page, are rendered by the page itself. The message and stack are never shown: in
 * production Next.js already replaces them with a `digest` that matches the server log line.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorPanel
      title="Something went wrong"
      testId="error-boundary"
      actions={
        <>
          <button type="button" onClick={reset} className={ERROR_ACTION}>
            Try again
          </button>
          <Link href="/" className={ERROR_ACTION}>
            Back to the home page
          </Link>
        </>
      }
    >
      <p>An unexpected error occurred while showing this page. Nothing has been lost.</p>
      {error.digest ? (
        <p className="text-sm">
          Reference: <code className="font-mono">{error.digest}</code>
        </p>
      ) : null}
    </ErrorPanel>
  );
}
