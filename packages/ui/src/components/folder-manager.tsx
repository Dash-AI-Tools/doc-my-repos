"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";

import { failureText } from "@docmyrepos/core/internal/fetch-error";
import { fieldClass } from "@docmyrepos/core/internal/ui";

import { rowButton } from "./repo-access-row";

/** Folder as the admin API returns it. Local copy: components take data as props. */
export interface FolderRow {
  readonly id: number;
  readonly name: string;
  readonly description: string | null;
  readonly starPosition: number | null;
  readonly isStarred: boolean;
}

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

interface Notice {
  readonly tone: "ok" | "error";
  readonly text: string;
}

/** Starred folders in tab order, then the rest as given (the server sends them by name). */
function arrange(folders: readonly FolderRow[]): FolderRow[] {
  const starred = folders
    .filter((f) => f.isStarred)
    .sort((a, b) => (a.starPosition ?? 0) - (b.starPosition ?? 0) || a.id - b.id);
  return [...starred, ...folders.filter((f) => !f.isStarred)];
}

interface FormValues {
  name: string;
  description: string;
}

function FolderForm({
  idBase,
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly idBase: string;
  readonly initial: FormValues;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly onSubmit: (values: FormValues) => void;
  readonly onCancel?: () => void;
}) {
  const [values, setValues] = useState(initial);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
      className="flex max-w-xl flex-col gap-3"
    >
      <div>
        <label htmlFor={`${idBase}-name`} className="text-sm font-medium">
          Name
        </label>
        <input
          id={`${idBase}-name`}
          value={values.name}
          maxLength={NAME_MAX}
          required
          autoComplete="off"
          onChange={(e) => setValues({ ...values, name: e.target.value })}
          className={fieldClass}
        />
      </div>
      <div>
        <label htmlFor={`${idBase}-description`} className="text-sm font-medium">
          Description{" "}
          <span className="font-normal text-muted-foreground">(optional, plain text)</span>
        </label>
        <textarea
          id={`${idBase}-description`}
          value={values.description}
          maxLength={DESCRIPTION_MAX}
          rows={2}
          onChange={(e) => setValues({ ...values, description: e.target.value })}
          className={fieldClass}
        />
      </div>
      <div className="flex items-center gap-4">
        <button type="submit" disabled={busy} className={`${rowButton} font-medium`}>
          {submitLabel}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} className={rowButton}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * The Folders tab of the Workspace configuration page: create, edit, star and order, and delete
 * folders. Folders are optional; with none, the tab is a short note and the create form. A failed
 * request shows its error and keeps the previous state. Repositories are assigned from the
 * Repository access list.
 */
export function FolderManager({
  initialFolders,
  counts,
}: {
  readonly initialFolders: readonly FolderRow[];
  /** Repositories in each folder, blocked ones included (folder id -> count). */
  readonly counts: Readonly<Record<number, number>>;
}) {
  const router = useRouter();
  const ids = useId();
  const [folders, setFolders] = useState(initialFolders);
  // The server sends fresh props after `router.refresh()`; take them over when they change.
  const [seen, setSeen] = useState(initialFolders);
  if (initialFolders !== seen) {
    setSeen(initialFolders);
    setFolders(initialFolders);
  }
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

  const list = arrange(folders);
  const starred = list.filter((f) => f.isStarred);

  /** Sends a request; returns the parsed body, or null after showing the error. */
  async function send<T>(url: string, method: string, body?: unknown): Promise<T | null> {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        setNotice({ tone: "error", text: await failureText(response) });
        return null;
      }
      return (await response.json()) as T;
    } catch {
      setNotice({ tone: "error", text: "Could not reach the server." });
      return null;
    } finally {
      setBusy(false);
    }
  }

  function replace(next: FolderRow) {
    setFolders((prev) => prev.map((f) => (f.id === next.id ? next : f)));
  }

  async function create(values: FormValues) {
    const data = await send<{ folder: FolderRow }>("/api/admin/folders", "POST", values);
    if (!data) return;
    setFolders((prev) => [...prev, data.folder]);
    setNotice({ tone: "ok", text: `Created ${data.folder.name}.` });
    router.refresh();
  }

  async function save(folder: FolderRow, values: FormValues) {
    const data = await send<{ folder: FolderRow }>(
      `/api/admin/folders/${folder.id}`,
      "PATCH",
      values,
    );
    if (!data) return;
    replace(data.folder);
    setEditing(null);
    setNotice({ tone: "ok", text: `Saved ${data.folder.name}.` });
    router.refresh();
  }

  async function toggleStar(folder: FolderRow) {
    const data = await send<{ folder: FolderRow }>(`/api/admin/folders/${folder.id}`, "PATCH", {
      isStarred: !folder.isStarred,
    });
    if (!data) return;
    replace(data.folder);
    setNotice({
      tone: "ok",
      text: `${folder.name} ${data.folder.isStarred ? "is starred and has a tab" : "is no longer starred"}.`,
    });
    router.refresh();
  }

  async function move(folder: FolderRow, delta: -1 | 1) {
    const from = starred.findIndex((f) => f.id === folder.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= starred.length) return;
    const next = [...starred];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    const data = await send<{ folderIds: number[] }>("/api/admin/folders/starred", "PUT", {
      folderIds: next.map((f) => f.id),
    });
    if (!data) return;
    const places = new Map(data.folderIds.map((id, index) => [id, index]));
    setFolders((prev) =>
      prev.map((f) => (places.has(f.id) ? { ...f, starPosition: places.get(f.id) ?? null } : f)),
    );
    setNotice({ tone: "ok", text: "Tab order saved." });
    router.refresh();
  }

  async function remove(folder: FolderRow) {
    const data = await send<{ ok: true }>(`/api/admin/folders/${folder.id}`, "DELETE");
    if (!data) return;
    setFolders((prev) => prev.filter((f) => f.id !== folder.id));
    setConfirming(null);
    setNotice({ tone: "ok", text: `Deleted ${folder.name}. Its repositories are kept.` });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-prose text-muted-foreground">
        Folders are optional. Group repositories on the home page under a name and description, then
        assign each repository from its row in Repository access. Star a folder to give it a tab on
        the home page.
      </p>

      <section aria-labelledby={`${ids}-new`} className="flex flex-col gap-3">
        <h2 id={`${ids}-new`} className="text-xl font-bold tracking-tight">
          New folder
        </h2>
        <FolderForm
          key={folders.length}
          idBase={`${ids}-new-form`}
          initial={{ name: "", description: "" }}
          submitLabel="Create folder"
          busy={busy}
          onSubmit={(v) => void create(v)}
        />
      </section>

      <div role="status" aria-live="polite" className="min-h-5 text-sm">
        {notice ? (
          <p className={notice.tone === "error" ? "text-destructive" : "text-foreground"}>
            {notice.text}
          </p>
        ) : null}
      </div>

      <section aria-labelledby={`${ids}-list`} className="flex flex-col gap-2">
        <h2 id={`${ids}-list`} className="text-xl font-bold tracking-tight">
          Folders{" "}
          <span className="font-normal text-muted-foreground tabular-nums">{list.length}</span>
        </h2>
        {list.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No folders yet.</p>
        ) : (
          <ul className="border-t border-border">
            {list.map((f) => {
              const count = counts[f.id] ?? 0;
              const starIndex = starred.findIndex((s) => s.id === f.id);
              return (
                <li key={f.id} className="border-b border-border py-3">
                  {editing === f.id ? (
                    <FolderForm
                      idBase={`${ids}-edit-${f.id}`}
                      initial={{ name: f.name, description: f.description ?? "" }}
                      submitLabel="Save"
                      busy={busy}
                      onSubmit={(v) => void save(f, v)}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                      <div className="min-w-0">
                        <p className="font-medium break-words [overflow-wrap:anywhere]">
                          {f.name}
                          {f.isStarred ? (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              starred, tab {starIndex + 1} of {starred.length}
                            </span>
                          ) : null}
                        </p>
                        {f.description ? (
                          <p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
                            {f.description}
                          </p>
                        ) : null}
                        <p className="text-sm text-muted-foreground tabular-nums">
                          {count} {count === 1 ? "repository" : "repositories"}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        {starIndex > 0 ? (
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`Move up ${f.name}`}
                            onClick={() => void move(f, -1)}
                            className={rowButton}
                          >
                            Up
                          </button>
                        ) : null}
                        {starIndex >= 0 && starIndex < starred.length - 1 ? (
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`Move down ${f.name}`}
                            onClick={() => void move(f, 1)}
                            className={rowButton}
                          >
                            Down
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={busy}
                          aria-pressed={f.isStarred}
                          aria-label={`Star ${f.name}`}
                          onClick={() => void toggleStar(f)}
                          className={rowButton}
                        >
                          Star
                        </button>
                        <button
                          type="button"
                          aria-label={`Edit ${f.name}`}
                          onClick={() => setEditing(f.id)}
                          className={rowButton}
                        >
                          Edit
                        </button>
                        {confirming === f.id ? null : (
                          <button
                            type="button"
                            aria-label={`Delete ${f.name}`}
                            onClick={() => setConfirming(f.id)}
                            className={rowButton}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                      {confirming === f.id ? (
                        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                          <p>
                            Delete {f.name}?{" "}
                            {count > 0
                              ? `Its ${count} ${count === 1 ? "repository moves" : "repositories move"} to Repositories.`
                              : "It has no repositories."}
                          </p>
                          <button
                            type="button"
                            disabled={busy}
                            aria-label={`Confirm delete ${f.name}`}
                            onClick={() => void remove(f)}
                            className={`${rowButton} text-destructive`}
                          >
                            Confirm delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirming(null)}
                            className={rowButton}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
