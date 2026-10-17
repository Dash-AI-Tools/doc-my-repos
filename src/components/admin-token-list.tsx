"use client";

import { useState } from "react";

import type { AdminTokenRow } from "@/lib/agent-access";

import { RevokeControl, TokenDetails } from "./token-row";

/**
 * Every user's AI agent tokens, for administrators (spec `agent-tokens`, "Revoke tokens"): owner,
 * name, prefix, expiry, last use and status, with a revoke for active ones. No token or hash is
 * ever on this page.
 */
export function AdminTokenList({
  initialTokens,
}: {
  readonly initialTokens: readonly AdminTokenRow[];
}) {
  const [tokens, setTokens] = useState<readonly AdminTokenRow[]>(initialTokens);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function onRevoke(token: AdminTokenRow): Promise<void> {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/tokens/${token.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      if (response.ok) {
        const now = new Date().toISOString();
        setTokens((current) =>
          current.map((t) => (t.id === token.id ? { ...t, status: "revoked", revokedAt: now } : t)),
        );
        setMessage(`Revoked “${token.name}” of ${token.owner.email}.`);
      } else if (response.status === 404) {
        setTokens((current) => current.filter((t) => t.id !== token.id));
        setError("That token no longer exists.");
      } else {
        setError("The token could not be revoked. Try again.");
      }
    } catch {
      setError("The request failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p role="alert" data-testid="admin-tokens-error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" data-testid="admin-tokens-message" className="text-sm">
          {message}
        </p>
      ) : null}
      {tokens.length === 0 ? (
        <p data-testid="admin-no-tokens" className="text-sm text-muted-foreground">
          No tokens have been created.
        </p>
      ) : (
        <ul className="flex flex-col gap-5">
          {tokens.map((token) => (
            <li
              key={token.id}
              data-testid="admin-token-item"
              className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5"
            >
              <TokenDetails token={token} owner={token.owner.email} />
              {token.status === "active" ? (
                <RevokeControl name={token.name} busy={busy} onConfirm={() => onRevoke(token)} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
