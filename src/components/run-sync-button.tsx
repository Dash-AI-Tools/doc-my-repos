"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Syncs every repository now with the saved GitHub settings (`POST /api/admin/sync`, the admin
 * session standing in for `SYNC_SECRET`). Disabled until those settings are complete.
 */
export function RunSyncButton({ canSync }: { readonly canSync: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSync(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/sync", { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string | { message?: string };
        repositories?: unknown[];
      };
      if (response.status === 202) {
        setMessage(data.message ?? "A sync is already running.");
      } else if (response.ok) {
        const n = data.repositories?.length ?? 0;
        setMessage(`Sync finished: ${n} ${n === 1 ? "repository" : "repositories"} processed.`);
        router.refresh();
      } else {
        const detail = typeof data.error === "object" ? data.error.message : undefined;
        setMessage(data.message ?? detail ?? "The sync failed. Check the settings and try again.");
      }
    } catch {
      setMessage("The request failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void onSync()}
        disabled={busy || !canSync}
        className="min-h-6 w-fit rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
      >
        {busy ? "Syncing…" : "Run first sync"}
      </button>
      <p role="status" data-testid="sync-result" className="min-h-5 text-sm text-muted-foreground">
        {message ??
          (canSync
            ? "Syncs with the saved GitHub settings."
            : "Save the GitHub App settings first.")}
      </p>
    </div>
  );
}
