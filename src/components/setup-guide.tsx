"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * The setup instructions of the Workspace configuration page: what to do on GitHub to create the
 * App, and what to enter here. An info button next to the page title opens them in a native modal
 * dialog (focus stays inside, Escape closes). When the setup banner brought the administrator here
 * (`autoOpen`) the dialog opens on its own.
 */
export function SetupGuide({
  autoOpen,
  encryptionKeyProblem,
}: {
  readonly autoOpen: boolean;
  readonly encryptionKeyProblem: string | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // The webhook URL is this site's own address, known only in the browser.
  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "<your-app-url>",
  );

  function open(): void {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    // jsdom and very old browsers have no showModal: fall back to the plain open attribute.
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  useEffect(() => {
    if (autoOpen) open();
  }, [autoOpen]);

  function close(focusFirstField: boolean): void {
    const dialog = ref.current;
    if (typeof dialog?.close === "function") dialog.close();
    else dialog?.removeAttribute("open");
    if (focusFirstField) {
      document.querySelector<HTMLElement>('[data-testid="settings-app-id"]')?.focus();
    }
  }

  const code = "rounded bg-muted px-1 font-mono text-[0.9em] break-words [overflow-wrap:anywhere]";

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-label="Setup instructions"
        aria-haspopup="dialog"
        title="Setup instructions"
        data-testid="setup-guide-open"
        className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-input text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="4.8" r="0.95" fill="currentColor" />
        </svg>
      </button>
      <dialog
        ref={ref}
        data-testid="onboarding-dialog"
        aria-labelledby="setup-guide-title"
        aria-describedby="setup-guide-intro"
        className="m-auto max-h-[90dvh] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border bg-background p-6 text-foreground shadow-lg backdrop:bg-background/80 backdrop:backdrop-blur-sm"
      >
        <h2 id="setup-guide-title" className="text-xl font-bold">
          Connect DocMyRepos to GitHub
        </h2>
        <p id="setup-guide-intro" className="mt-2 text-sm text-muted-foreground">
          Nothing can be synced until a GitHub App is set up. It takes a few minutes, and you can
          change any of it later. Full details are in{" "}
          <code className={code}>docs/github-app-setup.md</code>.
        </p>
        {encryptionKeyProblem ? (
          <p
            role="alert"
            className="mt-3 text-sm text-destructive"
            data-testid="onboarding-key-problem"
          >
            {encryptionKeyProblem}. Set <code>SETTINGS_ENCRYPTION_KEY</code> on the server first (
            <code>openssl rand -base64 32</code>) and restart it, or secrets cannot be saved.
          </p>
        ) : null}

        <h3 className="mt-5 text-sm font-bold">On GitHub</h3>
        <ol
          className="mt-2 list-decimal space-y-2 pl-5 text-sm"
          data-testid="setup-guide-github-steps"
        >
          <li>
            You must own the organization. Open{" "}
            <strong>Settings &gt; Developer settings &gt; GitHub Apps &gt; New GitHub App</strong>{" "}
            (for an organization, under the organization&apos;s settings). GitHub may ask you to
            confirm your access first.
          </li>
          <li>
            Give it a name and a homepage URL (this site&apos;s address works). Leave user
            authorization (OAuth) and the callback URL empty.
          </li>
          <li>
            <strong>Webhook:</strong> tick <em>Active</em>, set the URL to{" "}
            <code className={code} data-testid="setup-guide-webhook-url">
              {origin}/api/webhooks/github
            </code>
            , and choose a secret of at least 16 characters (
            <code className={code}>openssl rand -hex 32</code>). Keep SSL verification on. You will
            enter the same secret below. GitHub must be able to reach the URL; for a local machine
            use a tunnel such as smee.io.
          </li>
          <li>
            <strong>Repository permissions:</strong> <em>Contents</em> read-only and{" "}
            <em>Metadata</em> read-only. Set no other permission.
          </li>
          <li>
            <strong>Subscribe to events:</strong> <em>Push</em> and <em>Repository</em> (the
            installation events are sent without a checkbox).
          </li>
          <li>
            Choose where it can be installed (usually <em>Only on this account</em>) and press{" "}
            <strong>Create GitHub App</strong>. Copy the <strong>App ID</strong> from the{" "}
            <em>About</em> box (it is not the Client ID).
          </li>
          <li>
            Under <strong>Private keys</strong>, press <em>Generate a private key</em>. GitHub
            downloads a <code className={code}>.pem</code> file once; keep it somewhere private.
          </li>
          <li>
            Open <strong>Install App</strong>, pick your organization and select the repositories
            (or all of them). After installing, the number at the end of the page address is the{" "}
            <strong>Installation ID</strong>.
          </li>
        </ol>

        <h3 className="mt-5 text-sm font-bold">Here</h3>
        <ol
          className="mt-2 list-decimal space-y-2 pl-5 text-sm"
          data-testid="setup-guide-here-steps"
        >
          <li>
            Enter the <strong>App ID</strong>, <strong>Installation ID</strong>, the contents of the{" "}
            <strong>private key</strong> file and the <strong>webhook secret</strong>.
          </li>
          <li>
            Press <strong>Test GitHub connection</strong>. It shows how many repositories the App
            can access and saves nothing.
          </li>
          <li>
            Optionally choose which repositories to show, then <strong>Save</strong>. Secrets are
            encrypted and never shown again; no restart is needed.
          </li>
          <li>
            Start the first sync:{" "}
            <code className={code}>
              curl -X POST -H &quot;Authorization: Bearer $SYNC_SECRET&quot; {origin}/api/sync
            </code>
          </li>
        </ol>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => close(true)}
            data-testid="onboarding-start"
            className="min-h-6 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
          >
            Start setup
          </button>
          <button
            type="button"
            onClick={() => close(false)}
            data-testid="onboarding-skip"
            className="min-h-6 rounded-md border border-input px-4 py-2 hover:border-foreground"
          >
            Close
          </button>
        </div>
      </dialog>
    </>
  );
}
