"use client";

import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { fieldClass } from "@/lib/ui";

/** Row shape from the admin repos API. Local copy: components take data as props. */
export interface RepoAccessRow {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly isAllowed: boolean;
  readonly syncStatus: "pending" | "ok" | "error";
}

type AccessFilter = "all" | "allowed" | "blocked" | "error";

const FILTERS: ReadonlyArray<{ value: AccessFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "allowed", label: "Visible" },
  { value: "blocked", label: "Blocked" },
  { value: "error", label: "Sync errors" },
];

const SYNC_LABEL: Record<RepoAccessRow["syncStatus"], string> = {
  ok: "Synced",
  pending: "Waiting for first sync",
  error: "Sync failed",
};

const rowButton =
  "text-sm underline underline-offset-4 decoration-border hover:decoration-foreground disabled:opacity-50";
const gridCols = "md:grid-cols-[minmax(0,1fr)_6rem_11rem_5rem]";

interface Notice {
  readonly tone: "ok" | "error";
  readonly text: string;
}

export function RepoAccessManager({ initialRepos }: { initialRepos: RepoAccessRow[] }) {
  const router = useRouter();
  const ids = useId();
  const [repos, setRepos] = useState(initialRepos);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AccessFilter>("all");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos.filter((r) => {
      if (q && !`${r.owner}/${r.name}`.toLowerCase().includes(q)) return false;
      if (filter === "allowed") return r.isAllowed;
      if (filter === "blocked") return !r.isAllowed;
      if (filter === "error") return r.syncStatus === "error";
      return true;
    });
  }, [repos, query, filter]);

  const counts = useMemo(
    () => ({
      all: repos.length,
      allowed: repos.filter((r) => r.isAllowed).length,
      blocked: repos.filter((r) => !r.isAllowed).length,
      error: repos.filter((r) => r.syncStatus === "error").length,
    }),
    [repos],
  );

  async function onToggle(r: RepoAccessRow) {
    const isAllowed = !r.isAllowed;
    setBusyId(r.id);
    setNotice(null);
    const response = await fetch("/api/admin/repos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: r.owner, name: r.name, isAllowed }),
    });
    setBusyId(null);
    if (!response.ok) {
      let text = `Request failed (${response.status})`;
      try {
        const data = (await response.json()) as { error?: unknown };
        if (typeof data.error === "string") text = data.error;
      } catch {}
      setNotice({ tone: "error", text });
      return;
    }
    setRepos((prev) => prev.map((p) => (p.id === r.id ? { ...p, isAllowed } : p)));
    setNotice({
      tone: "ok",
      text: `${r.owner}/${r.name} is ${isAllowed ? "visible again" : "blocked"}.`,
    });
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`} className="text-xl font-bold tracking-tight">
        Repositories{" "}
        <span className="font-normal text-muted-foreground tabular-nums">{repos.length}</span>
      </h2>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div role="group" aria-label="Filter by access" className="flex flex-wrap gap-4 text-sm">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={
                filter === f.value
                  ? "border-b-2 border-primary pb-0.5 font-medium text-foreground"
                  : "border-b-2 border-transparent pb-0.5 text-muted-foreground hover:text-foreground"
              }
            >
              {f.label}{" "}
              <span className="tabular-nums text-muted-foreground">{counts[f.value]}</span>
            </button>
          ))}
        </div>
        <div className="w-full sm:w-64">
          <label htmlFor={`${ids}-search`} className="sr-only">
            Search repositories
          </label>
          <input
            id={`${ids}-search`}
            type="search"
            placeholder="Search owner/name"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={fieldClass}
          />
        </div>
      </div>

      <div role="status" aria-live="polite" className="min-h-5 text-sm">
        {notice ? (
          <p className={notice.tone === "error" ? "text-destructive" : "text-foreground"}>
            {notice.text}
          </p>
        ) : null}
      </div>

      <div>
        <div
          aria-hidden="true"
          className={`hidden gap-4 border-b border-border pb-2 text-xs text-muted-foreground md:grid ${gridCols}`}
        >
          <span>Repository</span>
          <span>Access</span>
          <span>Sync</span>
          <span className="text-right">Actions</span>
        </div>
        <ul>
          {visible.map((r) => {
            const busy = busyId === r.id;
            return (
              <li key={r.id} className="border-b border-border py-3">
                <div className={`grid items-center gap-x-4 gap-y-1 ${gridCols}`}>
                  <div className="min-w-0">
                    <span
                      className={`break-all font-medium ${r.isAllowed ? "" : "text-muted-foreground"}`}
                    >
                      <span className="font-normal text-muted-foreground">{r.owner}/</span>
                      {r.name}
                    </span>
                    {r.visibility === "private" ? (
                      <span className="ml-2 text-xs text-muted-foreground">private</span>
                    ) : null}
                  </div>
                  <div className="text-sm">
                    {r.isAllowed ? (
                      <span className="text-muted-foreground">Visible</span>
                    ) : (
                      <span className="text-destructive">Blocked</span>
                    )}
                  </div>
                  <div
                    className={`text-sm ${r.syncStatus === "error" ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {SYNC_LABEL[r.syncStatus]}
                  </div>
                  <div className="md:text-right">
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`${r.isAllowed ? "Block" : "Allow"} ${r.owner}/${r.name}`}
                      onClick={() => void onToggle(r)}
                      className={rowButton}
                    >
                      {r.isAllowed ? "Block" : "Allow"}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {visible.length === 0 ? (
          <p className="py-8 text-sm text-muted-foreground">
            {repos.length === 0
              ? "Nothing synced yet. Repositories appear after the first sync."
              : "No repository matches. Clear the search or pick another filter."}
          </p>
        ) : null}
      </div>
    </section>
  );
}
