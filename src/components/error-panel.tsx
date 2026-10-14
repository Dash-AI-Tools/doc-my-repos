import type { ReactNode } from "react";

/**
 * A friendly error box with a heading and actions (task 9.2). Used by the home page when the
 * repository list cannot be read (`LoadErrorState`) and by the `error.tsx` boundary. Callers pass
 * fixed text only: never an error message, a stack or a connection detail.
 */
export interface ErrorPanelProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly testId?: string;
}

/** Shared look for the action buttons and links of an error panel. */
export const ERROR_ACTION =
  "inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground no-underline hover:opacity-90";

export function ErrorPanel({ title, children, actions, testId }: ErrorPanelProps) {
  return (
    <section
      role="alert"
      aria-labelledby="error-heading"
      data-testid={testId}
      className="rounded-lg border border-destructive-muted-border bg-destructive-muted p-6 text-destructive-muted-foreground"
    >
      <h2 id="error-heading" className="text-xl font-semibold">
        {title}
      </h2>
      <div className="mt-2 space-y-2">{children}</div>
      {actions === undefined ? null : <div className="mt-4 flex flex-wrap gap-3">{actions}</div>}
    </section>
  );
}
