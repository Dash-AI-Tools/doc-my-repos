"use client";

import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import { EXPIRY_OPTIONS, connectionSnippets, mcpAddress, type TokenRow } from "@/lib/agent-access";
import { copyText } from "@/lib/copy-text";
import { fieldClass } from "@/lib/ui";

import { Section } from "./settings-fields";
import { RevokeControl, TokenDetails, primaryButton, secondaryButton } from "./token-row";

/** The portal's own origin as the browser sees it (behind a proxy too); empty on the server. */
function useOrigin(): string {
  return useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "",
  );
}

function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <>
      <button
        type="button"
        className={secondaryButton}
        onClick={async () => setState((await copyText(text)) ? "copied" : "failed")}
      >
        {label}
      </button>
      <span role="status" className="text-sm text-muted-foreground">
        {state === "copied"
          ? "Copied."
          : state === "failed"
            ? "Could not copy. Select it instead."
            : ""}
      </span>
    </>
  );
}

function Snippet({ title, code }: { readonly title: string; readonly code: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium">{title}</h3>
      {/* Focusable, so a keyboard user can scroll a long command sideways (WCAG 2.1.1). */}
      <pre
        tabIndex={0}
        className="overflow-x-auto rounded-md border border-border bg-muted p-3 text-sm"
      >
        <code>{code}</code>
      </pre>
      <div className="flex flex-wrap items-center gap-3">
        <CopyButton text={code} label={`Copy ${title.toLowerCase()}`} />
      </div>
    </div>
  );
}

interface Created {
  readonly token: string;
  readonly name: string;
}

/**
 * The AI agent access page (mcp-agent-access, spec `agent-tokens`): how to connect an agent, create
 * a token, and the user's tokens with revoking. The full token is held in this component's state
 * only: it is shown once, in the panel under the form, and is never in the URL, the page's server
 * data or any later render. Leaving the page, reloading or pressing Done drops it for good.
 */
export function AgentAccess({
  initialTokens,
  maxActive,
}: {
  readonly initialTokens: readonly TokenRow[];
  readonly maxActive: number;
}) {
  const origin = useOrigin();
  const address = mcpAddress(origin);
  const [tokens, setTokens] = useState<readonly TokenRow[]>(initialTokens);
  const [name, setName] = useState("");
  const [days, setDays] = useState<number>(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const active = tokens.filter((t) => t.status === "active").length;
  const generic = connectionSnippets(address);

  async function onCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const response = await fetch("/api/account/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, expiryDays: days }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        token?: string;
        view?: TokenRow;
        error?: string;
      };
      if (response.status === 201 && data.token && data.view) {
        setCreated({ token: data.token, name: data.view.name });
        setTokens((current) => [data.view as TokenRow, ...current]);
        setName("");
        // Land on the new token for keyboard and screen reader users.
        requestAnimationFrame(() => panel.current?.focus());
      } else {
        setError(data.error ?? "The token could not be created.");
      }
    } catch {
      setError("The request failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(token: TokenRow): Promise<void> {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/account/tokens/${token.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      if (response.ok) {
        const now = new Date().toISOString();
        setTokens((current) =>
          current.map((t) => (t.id === token.id ? { ...t, status: "revoked", revokedAt: now } : t)),
        );
        setMessage(`Revoked “${token.name}”. It no longer works.`);
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

  const withToken = created ? connectionSnippets(address, created.token) : null;

  return (
    <div className="flex flex-col gap-2">
      <Section
        title="Connect an agent"
        intro="AI agents read the documentation through MCP at this address, authenticated with a token you create below."
      >
        <div className="flex flex-col gap-2">
          <p className="text-sm">MCP address</p>
          <code
            data-testid="mcp-address"
            className="w-fit max-w-full break-all rounded-md border border-border bg-muted px-3 py-2 text-sm"
          >
            {address}
          </code>
          <div className="flex flex-wrap items-center gap-3">
            <CopyButton text={address} label="Copy address" />
          </div>
        </div>
        <Snippet title="Command-line agent (Claude Code)" code={generic.commandLine} />
        <Snippet title="JSON-configured agent (Cursor and others)" code={generic.json} />
        <p className="text-sm text-muted-foreground">
          Replace <code>YOUR_TOKEN</code> with a token. The snippets above never hold a real token;
          the one shown after you create a token does.
        </p>
      </Section>

      <Section
        title="Create a token"
        intro={`A token reads the documentation you can see and nothing else. You can have up to ${maxActive} active tokens; use a short expiry.`}
      >
        <form onSubmit={onCreate} noValidate className="flex max-w-lg flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="token-name" className="text-sm">
              Token name
            </label>
            <input
              id="token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="token-name-hint"
              className={fieldClass}
            />
            <p id="token-name-hint" className="text-sm text-muted-foreground">
              1 to 60 characters, for example the machine or agent it is for.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="token-expiry" className="text-sm">
              Expires after
            </label>
            <select
              id="token-expiry"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className={fieldClass}
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? "Working…" : "Create token"}
          </button>
        </form>

        {error ? (
          <p role="alert" data-testid="agent-access-error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {message ? (
          <p role="status" data-testid="agent-access-message" className="text-sm">
            {message}
          </p>
        ) : null}

        {created && withToken ? (
          <div
            ref={panel}
            tabIndex={-1}
            role="region"
            aria-label="New token"
            data-testid="new-token"
            className="flex flex-col gap-4 border border-foreground p-4"
          >
            <h3 className="text-lg font-bold">Your new token “{created.name}”</h3>
            <p role="alert" className="text-sm font-medium">
              Copy it now. This is the only time it is shown, and it cannot be shown again.
            </p>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="new-token-value" className="text-sm">
                Token
              </label>
              <input
                id="new-token-value"
                readOnly
                value={created.token}
                autoComplete="off"
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
                className={`${fieldClass} font-mono text-sm`}
              />
              <div className="flex flex-wrap items-center gap-3">
                <CopyButton text={created.token} label="Copy token" />
              </div>
            </div>
            <Snippet title="Command with this token" code={withToken.commandLine} />
            <Snippet title="JSON with this token" code={withToken.json} />
            <button type="button" onClick={() => setCreated(null)} className={primaryButton}>
              I have saved the token
            </button>
          </div>
        ) : null}
      </Section>

      <Section
        title="Your tokens"
        intro={`${active} of ${maxActive} active. A revoked or expired token stays listed for 30 days.`}
      >
        {tokens.length === 0 ? (
          <p data-testid="no-tokens" className="text-sm text-muted-foreground">
            You have no tokens yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-5">
            {tokens.map((token) => (
              <li
                key={token.id}
                data-testid="token-item"
                className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5"
              >
                <TokenDetails token={token} />
                {token.status === "active" ? (
                  <RevokeControl name={token.name} busy={busy} onConfirm={() => onRevoke(token)} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
