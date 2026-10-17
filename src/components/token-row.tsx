"use client";

import { useState, type ReactNode } from "react";

import { STATUS_LABEL, displayPrefix, formatWhen, type TokenRow } from "@/lib/agent-access";

export const primaryButton =
  "min-h-6 w-fit cursor-pointer rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50";
export const secondaryButton =
  "min-h-6 w-fit cursor-pointer rounded-md border border-input px-4 py-2 hover:border-foreground disabled:opacity-50";

/**
 * What the token APIs know about one token: its prefix, expiry, last use and status. Never the
 * token. `owner` is shown on the administrator's list.
 */
export function TokenDetails({
  token,
  owner,
}: {
  readonly token: TokenRow;
  readonly owner?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="break-words font-medium [overflow-wrap:anywhere]">{token.name}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
        {owner ? (
          <>
            <dt>Owner</dt>
            <dd className="break-words [overflow-wrap:anywhere]">{owner}</dd>
          </>
        ) : null}
        <dt>Token</dt>
        <dd>
          <code>{displayPrefix(token.prefix)}</code>
        </dd>
        <dt>Status</dt>
        <dd data-testid="token-status">{STATUS_LABEL[token.status]}</dd>
        <dt>{token.status === "expired" ? "Expired" : "Expires"}</dt>
        <dd>{formatWhen(token.expiresAt)}</dd>
        {token.revokedAt ? (
          <>
            <dt>Revoked</dt>
            <dd>{formatWhen(token.revokedAt)}</dd>
          </>
        ) : null}
        <dt>Last used</dt>
        <dd>{token.lastUsedAt ? formatWhen(token.lastUsedAt) : "Never"}</dd>
      </dl>
    </div>
  );
}

/**
 * Revoking is asked twice in the page itself, with no browser dialog: "Revoke" turns into a
 * question with a confirming button and Cancel. Only an active token can be revoked.
 */
export function RevokeControl({
  name,
  busy,
  onConfirm,
}: {
  readonly name: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
}): ReactNode {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        disabled={busy}
        aria-label={`Revoke ${name}`}
        className={secondaryButton}
      >
        Revoke
      </button>
    );
  }
  return (
    <div role="group" aria-label={`Confirm revoking ${name}`} className="flex flex-wrap gap-2">
      <button
        type="button"
        autoFocus
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        disabled={busy}
        className="min-h-6 w-fit cursor-pointer rounded-md bg-destructive px-4 py-2 font-medium text-destructive-foreground disabled:opacity-50"
      >
        Yes, revoke
      </button>
      <button type="button" onClick={() => setAsking(false)} className={secondaryButton}>
        Cancel
      </button>
    </div>
  );
}
