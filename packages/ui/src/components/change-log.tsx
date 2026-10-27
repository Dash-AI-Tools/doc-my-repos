import type { ReactNode } from "react";

/**
 * The frame around the body of a repository's reserved `log.md` (task 11.6, OKF spec "Reserved
 * files": `log.md` is shown as a change log, not as a typed concept). Presentational.
 *
 * The page uses it only for an OKF repository: reserved handling is part of the OKF UI, and a
 * plain Markdown repository that happens to have a `log.md` gets an ordinary page. The body is the
 * document rendered as usual; the frame adds a visible "Change log" label with a one-line
 * explanation, and a timeline rule (`.change-log` in `globals.css`) that puts a dot on each `##`
 * entry heading. Entries stay in the order the author wrote them: the spec does not say whether a
 * log runs oldest or newest first, and the headings are free text, so the order is not guessed.
 */
export function ChangeLog({ children }: { readonly children: ReactNode }) {
  return (
    <section aria-label="Change log" data-testid="change-log" className="mt-6">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span
          data-testid="change-log-badge"
          className="inline-flex items-center rounded-full bg-okf-badge px-2 py-0.5 text-xs font-medium text-okf-badge-foreground"
        >
          Change log
        </span>
        <span className="text-muted-foreground">
          A record of changes, in the order written. A reserved file, not a typed concept.
        </span>
      </div>
      <div className="change-log border-l-2 border-border pl-5">{children}</div>
    </section>
  );
}
