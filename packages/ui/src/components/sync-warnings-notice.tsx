import type { SyncWarningView } from "@docmyrepos/core/internal/sync-warnings";
import { plural } from "@docmyrepos/core/internal/sync-status";

/**
 * "Some files were not synced" (task 12.3): the repository's visible sync warnings (document cap,
 * size cap, rejected files) with a native disclosure listing each reason and the first paths as
 * plain text. Presentational and server-rendered: `<details>` needs no script. Renders nothing for
 * an empty list.
 */
export function SyncWarningsNotice({
  warnings,
  testId = "repo-sync-warnings",
}: {
  readonly warnings: readonly SyncWarningView[];
  readonly testId?: string;
}) {
  if (warnings.length === 0) return null;
  const total = warnings.reduce((sum, w) => sum + w.count, 0);
  return (
    <div
      role="status"
      data-testid={testId}
      className="rounded-md bg-warning p-3 text-sm text-warning-foreground"
    >
      <p className="font-medium">Some files were not synced</p>
      <p className="mt-1">
        {plural(total, "file")} in this repository {total === 1 ? "is" : "are"} not shown. The rest
        of the documentation is up to date.
      </p>
      <details className="mt-2" data-testid="sync-warnings-details">
        <summary className="cursor-pointer font-medium underline underline-offset-2">
          Show details
        </summary>
        <ul className="mt-2 flex flex-col gap-3">
          {warnings.map((w) => (
            <li key={w.code} data-testid="sync-warning" data-code={w.code}>
              <p className="break-words">{w.message}</p>
              {w.paths.length > 0 ? (
                <ul className="mt-1 list-disc pl-5 font-mono text-xs break-all">
                  {w.paths.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                  {w.count > w.paths.length ? (
                    <li className="list-none font-sans">
                      and {plural(w.count - w.paths.length, "more file")}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
