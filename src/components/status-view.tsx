import Link from "next/link";

import { askStatusLine, type AskStatusInput } from "@/lib/ask/status";
import { workspaceStatusLine, type WorkspaceStatusInput } from "@/lib/workspace-status";
import { repoUrl } from "@/lib/routes";
import {
  formatDuration,
  repoStatusChip,
  runStatusChip,
  TONE_CLASSES,
  triggerLabel,
  type RepoSyncState,
  type RunStatus,
  type StatusTone,
  type SyncTrigger,
} from "@/lib/sync-status";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

import { ERROR_ACTION, ErrorPanel } from "./error-panel";

/**
 * The `/status` page body (task 12.2): the last sync run with its counts, a running sync if any,
 * and every visible repository's sync state (status, last synced, error, warnings). Presentational
 * and server-rendered; the data is the structural subset of the query layer's `SyncStatus`
 * (components never import the query layer). Everything is rendered as text.
 */

export interface StatusRunCounts {
  readonly repos: number;
  readonly ok: number;
  readonly failed: number;
  readonly skipped: number;
  readonly docsAdded: number;
  readonly docsUpdated: number;
  readonly docsRemoved: number;
  readonly docsSkipped: number;
  readonly warnings: number;
}

export interface StatusViewData {
  readonly lastRun: {
    readonly trigger: SyncTrigger;
    readonly scope: string | null;
    readonly status: RunStatus;
    readonly startedAt: Date;
    readonly finishedAt: Date | null;
    readonly durationMs: number | null;
    readonly error: string | null;
    readonly counts: StatusRunCounts;
  } | null;
  readonly running: {
    readonly trigger: SyncTrigger;
    readonly scope: string | null;
    readonly startedAt: Date;
  } | null;
  readonly repos: readonly {
    readonly owner: string;
    readonly name: string;
    readonly visibility: "public" | "private";
    readonly syncStatus: RepoSyncState;
    readonly syncError: string | null;
    readonly lastSyncedAt: Date | null;
    readonly warnings: readonly {
      readonly code: string;
      readonly message: string;
      readonly count: number;
    }[];
    readonly skippedFiles: number;
  }[];
  readonly reposTotal: number;
  readonly reposByStatus: { readonly ok: number; readonly error: number; readonly pending: number };
  readonly reposWithWarnings: number;
  readonly truncated: boolean;
}

const CHIP = "inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-medium";

function Chip({ tone, label, testId }: { tone: StatusTone; label: string; testId?: string }) {
  return (
    <span data-testid={testId} data-tone={tone} className={`${CHIP} ${TONE_CLASSES[tone]}`}>
      {label}
    </span>
  );
}

function TimeText({ date, now }: { readonly date: Date; readonly now: Date }) {
  return (
    <time dateTime={date.toISOString()} title={formatAbsoluteTime(date)}>
      {formatRelativeTime(date, now)}
      <span className="sr-only"> ({formatAbsoluteTime(date)})</span>
    </time>
  );
}

function repositories(n: number): string {
  return `${n} ${n === 1 ? "repository" : "repositories"}`;
}

function scopeLabel(scope: string | null): string {
  return scope === null ? "all repositories" : scope;
}

function LastRun({ run, now }: { run: NonNullable<StatusViewData["lastRun"]>; now: Date }) {
  const chip = runStatusChip(run.status);
  const c = run.counts;
  const items: [string, string][] = [
    ["Repositories", `${c.repos} (${c.ok} ok, ${c.failed} failed, ${c.skipped} skipped)`],
    [
      "Documents",
      `${c.docsAdded} added, ${c.docsUpdated} updated, ${c.docsRemoved} removed, ${c.docsSkipped} skipped`,
    ],
    ["Warnings", String(c.warnings)],
  ];
  if (run.durationMs !== null) items.push(["Duration", formatDuration(run.durationMs)]);
  return (
    <div data-testid="status-last-run" className="rounded-lg border border-border bg-card p-4">
      <p className="flex flex-wrap items-center gap-2">
        <Chip tone={chip.tone} label={chip.label} testId="status-last-run-status" />
        <span>
          {triggerLabel(run.trigger)} of {scopeLabel(run.scope)}, started{" "}
          <TimeText date={run.startedAt} now={now} />
        </span>
      </p>
      {run.error !== null ? (
        <p
          data-testid="status-last-run-error"
          className="mt-3 rounded-md border border-destructive-muted-border bg-destructive-muted p-2 text-sm break-words text-destructive-muted-foreground"
        >
          {run.error}
        </p>
      ) : null}
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        {items.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function StatusHeading() {
  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Sync status</h1>
      <p className="mt-2 text-muted-foreground">
        How the documentation is kept in sync with GitHub. The same data is available as JSON at{" "}
        <code className="rounded bg-muted px-1">/api/status</code>.
      </p>
    </div>
  );
}

const ASK_TONE = { good: "success", bad: "error" } as const satisfies Record<string, StatusTone>;

function AskStatus({ ask }: { readonly ask: AskStatusInput }) {
  const line = askStatusLine(ask);
  return (
    <section aria-labelledby="status-ask-heading" className="flex flex-col gap-3">
      <h2 id="status-ask-heading" className="text-xl font-semibold">
        Ask
      </h2>
      <p data-testid="status-ask" className="flex flex-wrap items-center gap-2 text-sm">
        {line.tone === "neutral" ? (
          <span
            data-testid="status-ask-state"
            data-tone="neutral"
            className={`${CHIP} bg-muted text-muted-foreground`}
          >
            {line.label}
          </span>
        ) : (
          <Chip tone={ASK_TONE[line.tone]} label={line.label} testId="status-ask-state" />
        )}
        <span data-testid="status-ask-detail">{line.detail}</span>
      </p>
    </section>
  );
}

function WorkspaceStatus({ workspace }: { readonly workspace: WorkspaceStatusInput }) {
  const line = workspaceStatusLine(workspace);
  return (
    <section aria-labelledby="status-workspace-heading" className="flex flex-col gap-3">
      <h2 id="status-workspace-heading" className="text-xl font-semibold">
        Workspace settings
      </h2>
      <p data-testid="status-workspace" className="flex flex-wrap items-center gap-2 text-sm">
        <Chip tone={ASK_TONE[line.tone]} label={line.label} testId="status-workspace-state" />
        {line.details.length === 0 ? (
          <span data-testid="status-workspace-detail">GitHub is configured.</span>
        ) : null}
      </p>
      {line.details.length > 0 ? (
        <ul data-testid="status-workspace-detail" className="list-disc pl-5 text-sm">
          {line.details.map((detail) => (
            <li key={detail} className="break-words [overflow-wrap:anywhere]">
              {detail}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function StatusView({
  data,
  ask,
  workspace,
  now,
}: {
  readonly data: StatusViewData;
  readonly ask?: AskStatusInput;
  readonly workspace?: WorkspaceStatusInput | null;
  readonly now: Date;
}) {
  const by = data.reposByStatus;
  return (
    <div className="flex flex-col gap-8">
      <StatusHeading />

      <section aria-labelledby="status-run-heading" className="flex flex-col gap-3">
        <h2 id="status-run-heading" className="text-xl font-semibold">
          Last sync run
        </h2>
        {data.running !== null ? (
          <p
            role="status"
            data-testid="status-running"
            className="rounded-md bg-warning p-3 text-sm text-warning-foreground"
          >
            A {triggerLabel(data.running.trigger)} of {scopeLabel(data.running.scope)} is running
            (started <TimeText date={data.running.startedAt} now={now} />
            ).
          </p>
        ) : null}
        {data.lastRun === null ? (
          <p data-testid="status-no-run" className="text-muted-foreground">
            No sync run has finished yet.
          </p>
        ) : (
          <LastRun run={data.lastRun} now={now} />
        )}
      </section>

      {workspace ? <WorkspaceStatus workspace={workspace} /> : null}

      {ask ? <AskStatus ask={ask} /> : null}

      <section aria-labelledby="status-repos-heading" className="flex flex-col gap-3">
        <h2 id="status-repos-heading" className="text-xl font-semibold">
          Repositories
        </h2>
        <p data-testid="status-summary" className="text-sm text-muted-foreground">
          {repositories(data.reposTotal)}: {by.ok} synced, {by.error} failed, {by.pending} pending;{" "}
          {repositories(data.reposWithWarnings)} with files not synced.
        </p>
        {data.repos.length === 0 ? (
          <p data-testid="status-no-repos" className="text-muted-foreground">
            No repository has been synced yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {data.repos.map((r) => {
              const chip = repoStatusChip(r.syncStatus, r.warnings.length);
              return (
                <li
                  key={`${r.owner}/${r.name}`}
                  data-testid="status-repo"
                  data-repo={`${r.owner}/${r.name}`}
                  className="flex min-w-0 flex-col gap-1 p-3"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link
                      href={repoUrl(r.owner, r.name)}
                      prefetch={false}
                      className="font-medium break-all text-foreground"
                    >
                      {r.owner}/{r.name}
                    </Link>
                    <Chip tone={chip.tone} label={chip.label} testId="status-repo-status" />
                    {r.visibility === "private" ? (
                      <span className={`${CHIP} bg-private-badge text-private-badge-foreground`}>
                        Private
                      </span>
                    ) : null}
                    <span className="text-sm text-muted-foreground">
                      {r.lastSyncedAt !== null ? (
                        <>
                          Last synced <TimeText date={r.lastSyncedAt} now={now} />
                        </>
                      ) : (
                        "Not synced yet"
                      )}
                    </span>
                  </div>
                  {r.syncStatus === "error" && r.syncError !== null && r.syncError !== "" ? (
                    <p data-testid="status-repo-error" className="text-sm break-words">
                      Last sync failed: {r.syncError}
                    </p>
                  ) : null}
                  {r.warnings.length > 0 ? (
                    <ul data-testid="status-repo-warnings" className="text-sm">
                      {r.warnings.map((w) => (
                        <li key={w.code} className="break-words">
                          Not synced: {w.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {data.truncated ? (
          <p data-testid="status-truncated" className="text-sm text-muted-foreground">
            Showing the first {data.repos.length} of {data.reposTotal} repositories.
          </p>
        ) : null}
      </section>
    </div>
  );
}

/** In-page error state of `/status`: the database or configuration is unusable. */
export function StatusLoadError() {
  return (
    <div className="flex flex-col gap-8">
      <StatusHeading />
      <ErrorPanel
        title="Sync status could not be loaded"
        testId="status-load-error"
        actions={
          <Link href="/status" className={ERROR_ACTION}>
            Try again
          </Link>
        }
      >
        <p>
          The portal could not read its sync status. The database may be unreachable or the server
          may be misconfigured. Ask the administrator to check the server logs.
        </p>
      </ErrorPanel>
    </div>
  );
}
