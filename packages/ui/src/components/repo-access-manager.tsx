"use client";

import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { failureText } from "@docmyrepos/core/internal/fetch-error";
import { fieldClass } from "@docmyrepos/core/internal/ui";

import { RepoLine, repoLabel, type FolderOption, type RepoAccessRow } from "./repo-access-row";
import { RunSyncButton } from "./run-sync-button";
import { StarredRepoList } from "./starred-repo-list";

export type { RepoAccessRow } from "./repo-access-row";

type AccessFilter = "all" | "allowed" | "blocked" | "error";

const FILTERS: ReadonlyArray<{ value: AccessFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "allowed", label: "Visible" },
  { value: "blocked", label: "Blocked" },
  { value: "error", label: "Sync errors" },
];

interface Notice {
  readonly tone: "ok" | "error";
  readonly text: string;
}

/** Starred rows in the admin order (place, then id: the same order the server uses). */
function starredInOrder(repos: readonly RepoAccessRow[]): RepoAccessRow[] {
  return repos
    .filter((r) => r.isStarred)
    .sort((a, b) => (a.starPosition ?? 0) - (b.starPosition ?? 0) || a.id - b.id);
}

export function RepoAccessManager({
  initialRepos,
  folders = [],
  canSync = false,
}: {
  initialRepos: RepoAccessRow[];
  /** Folders to choose from (optional feature): no folder control is shown when empty. */
  folders?: readonly FolderOption[];
  /** Whether the saved GitHub settings are complete enough to sync. */
  canSync?: boolean;
}) {
  const router = useRouter();
  const ids = useId();
  const [repos, setRepos] = useState(initialRepos);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AccessFilter>("all");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reordering, setReordering] = useState(false);

  // The starred group is always shown whole (it is the list being ordered); the search and filter
  // narrow the other repositories.
  const starred = useMemo(() => starredInOrder(repos), [repos]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos.filter((r) => {
      if (r.isStarred) return false;
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

  /** PATCH one repo; on failure the list is left as it was and the error is shown. */
  async function patch(
    r: RepoAccessRow,
    body: { isAllowed: boolean } | { isStarred: boolean } | { folderId: number | null },
  ): Promise<{ isAllowed: boolean; starPosition: number | null; folderId: number | null } | null> {
    setBusyId(r.id);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/repos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: r.owner, name: r.name, ...body }),
      });
      if (!response.ok) {
        setNotice({ tone: "error", text: await failureText(response) });
        return null;
      }
      const data = (await response.json()) as {
        repo: { isAllowed: boolean; starPosition: number | null; folderId: number | null };
      };
      return data.repo;
    } catch {
      setNotice({ tone: "error", text: "Could not reach the server." });
      return null;
    } finally {
      setBusyId(null);
    }
  }

  async function onToggle(r: RepoAccessRow) {
    const saved = await patch(r, { isAllowed: !r.isAllowed });
    if (!saved) return;
    setRepos((prev) => prev.map((p) => (p.id === r.id ? { ...p, isAllowed: saved.isAllowed } : p)));
    setNotice({
      tone: "ok",
      text: `${repoLabel(r)} is ${saved.isAllowed ? "visible again" : "blocked"}.`,
    });
    router.refresh();
  }

  async function onSetFolder(r: RepoAccessRow, folderId: number | null) {
    const saved = await patch(r, { folderId });
    if (!saved) return;
    setRepos((prev) => prev.map((p) => (p.id === r.id ? { ...p, folderId: saved.folderId } : p)));
    const name = folders.find((f) => f.id === saved.folderId)?.name;
    setNotice({
      tone: "ok",
      text: name ? `${repoLabel(r)} is in ${name}.` : `${repoLabel(r)} is in no folder.`,
    });
    router.refresh();
  }

  async function onToggleStar(r: RepoAccessRow) {
    const saved = await patch(r, { isStarred: !r.isStarred });
    if (!saved) return;
    setRepos((prev) =>
      prev.map((p) =>
        p.id === r.id
          ? { ...p, starPosition: saved.starPosition, isStarred: saved.starPosition !== null }
          : p,
      ),
    );
    setNotice({
      tone: "ok",
      text: `${repoLabel(r)} ${saved.starPosition !== null ? "is starred" : "is no longer starred"}.`,
    });
    router.refresh();
  }

  /** Optimistic reorder: show the new order now, send the whole list, restore it on failure. */
  async function onReorder(next: RepoAccessRow[]) {
    const previous = repos;
    const places = new Map(next.map((r, index) => [r.id, index]));
    setRepos((prev) =>
      prev.map((p) => (places.has(p.id) ? { ...p, starPosition: places.get(p.id) ?? null } : p)),
    );
    setReordering(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/repos/starred", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repos: next.map((r) => ({ owner: r.owner, name: r.name })) }),
      });
      if (!response.ok) {
        setRepos(previous);
        setNotice({ tone: "error", text: await failureText(response) });
        return;
      }
      setNotice({ tone: "ok", text: "Starred order saved." });
      router.refresh();
    } catch {
      setRepos(previous);
      setNotice({ tone: "error", text: "Could not reach the server." });
    } finally {
      setReordering(false);
    }
  }

  return (
    <div className="flex flex-col gap-10">
      {starred.length > 0 ? (
        <section className="flex flex-col gap-2" aria-labelledby={`${ids}-starred`}>
          <h2 id={`${ids}-starred`} className="text-xl font-bold tracking-tight">
            Starred{" "}
            <span className="font-normal text-muted-foreground tabular-nums">{starred.length}</span>
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Starred repositories lead the home page in this order. Drag a row by its handle, or use
            Up and Down.
          </p>
          <div className="border-t border-border">
            <StarredRepoList
              repos={starred}
              busyId={busyId}
              reordering={reordering}
              onReorder={(next) => void onReorder(next)}
              onToggleStar={(r) => void onToggleStar(r)}
              onToggleAllowed={(r) => void onToggle(r)}
              folders={folders}
              onSetFolder={(r, id) => void onSetFolder(r, id)}
            />
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-4" aria-labelledby={`${ids}-h`}>
        {initialRepos.length === 0 ? <RunSyncButton canSync={canSync} /> : null}
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
          <ul>
            {visible.map((r) => (
              <li key={r.id} className="border-b border-border py-3">
                <RepoLine
                  repo={r}
                  busy={busyId === r.id}
                  onToggleStar={(row) => void onToggleStar(row)}
                  onToggleAllowed={(row) => void onToggle(row)}
                  folders={folders}
                  onSetFolder={(row, id) => void onSetFolder(row, id)}
                />
              </li>
            ))}
          </ul>
          {visible.length === 0 ? (
            <p className="py-8 text-sm text-muted-foreground">
              {repos.length === 0
                ? "Nothing synced yet. Repositories appear after the first sync."
                : repos.every((r) => r.isStarred)
                  ? "Every repository is starred."
                  : "No repository matches. Clear the search or pick another filter."}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
