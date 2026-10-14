"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Row shape from the admin repos API. Local copy: components take data as props. */
export interface RepoAccessRow {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly isAllowed: boolean;
  readonly syncStatus: "pending" | "ok" | "error";
}

export function RepoAccessManager({ initialRepos }: { initialRepos: RepoAccessRow[] }) {
  const router = useRouter();
  const [repos, setRepos] = useState(initialRepos);
  const [message, setMessage] = useState<string | null>(null);

  async function onToggle(owner: string, name: string, isAllowed: boolean) {
    setMessage(null);
    const response = await fetch("/api/admin/repos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, name, isAllowed }),
    });
    if (!response.ok) {
      let text = `Request failed (${response.status})`;
      try {
        const data = (await response.json()) as { error?: unknown };
        if (typeof data.error === "string") text = data.error;
      } catch {
        // Keep the status fallback.
      }
      setMessage(text);
      return;
    }
    setRepos((prev) =>
      prev.map((r) => (r.owner === owner && r.name === name ? { ...r, isAllowed } : r)),
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {message ? (
        <p role="alert" className="text-sm">
          {message}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {repos.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
            <span className="font-medium">
              {r.owner}/{r.name}
            </span>
            <span className="text-sm text-muted-foreground">
              {r.visibility}
              {r.isAllowed ? "" : " · blocked"}
              {r.syncStatus === "error" ? " · sync error" : ""}
            </span>
            <button
              type="button"
              onClick={() => onToggle(r.owner, r.name, !r.isAllowed)}
              className="ml-auto rounded-md border px-2 py-1 text-sm"
            >
              {r.isAllowed ? "Block" : "Allow"}
            </button>
          </li>
        ))}
      </ul>
      {repos.length === 0 ? <p className="text-muted-foreground">Nothing synced yet.</p> : null}
    </div>
  );
}
