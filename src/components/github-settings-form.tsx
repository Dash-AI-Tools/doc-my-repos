"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent, type ReactNode } from "react";

import {
  buildSettings,
  formFromSettings,
  type RepoMode,
  type SettingsFormState,
} from "@/lib/settings-form";
import { fieldClass } from "@/lib/ui";
import type { AppConfig } from "@/server/config/schema";

import { SecretField } from "./secret-field";

/** The names of the secrets this page edits. */
type SecretName = "github_private_key" | "github_webhook_secret";

/** What `GET /api/admin/settings` returns (structural, with times as ISO text). */
export interface SettingsView {
  readonly version: number;
  readonly settings: AppConfig;
  readonly secrets: Readonly<
    Record<string, { readonly set: boolean; readonly updatedAt: string | null }>
  >;
  readonly problems: {
    readonly missingGithub: readonly string[];
    readonly encryptionKey: string | null;
    readonly unreadable: readonly string[];
    readonly invalidStored: boolean;
  };
}

/** The fixed messages for the connection test, one per result word. */
const TEST_MESSAGES: Readonly<Record<string, string>> = {
  rejected: "Test failed: GitHub rejected the App credentials.",
  not_found: "Test failed: GitHub did not find that installation.",
  unavailable: "Test failed: GitHub could not be reached or returned an error.",
  timeout: "Test failed: GitHub did not answer in time.",
};

const MODES: readonly { value: RepoMode; label: string; hint: string }[] = [
  {
    value: "all",
    label: "All repositories the App can access",
    hint: "Archived ones are skipped.",
  },
  { value: "only", label: "Only these repositories", hint: "" },
  { value: "except", label: "All except these repositories", hint: "" },
];

function Section({
  title,
  intro,
  children,
}: {
  readonly title: string;
  readonly intro?: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="mb-10 flex break-inside-avoid flex-col gap-5 border-t border-foreground pt-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-sm font-bold">
          {title}
        </h2>
        {intro ? <p className="text-sm text-muted-foreground">{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  inputMode,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly inputMode?: "numeric";
  readonly testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        data-testid={testId}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={fieldClass}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label className="flex min-h-6 items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
        />
        <span>{label}</span>
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="pl-7 text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function CheckIcon({ done }: { readonly done: boolean }) {
  return done ? (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      className="shrink-0 text-primary"
    >
      <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  ) : (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      className="shrink-0 text-muted-foreground"
    >
      <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/**
 * Where the GitHub connection stands, at the top of the page: the four things it needs, each set or
 * missing. Read from what was last saved, so it answers "can this sync yet?" before any field is read.
 */
function ConnectionSummary({ view }: { readonly view: SettingsView }) {
  const items = [
    { label: "App ID", done: view.settings.github.appId !== undefined },
    { label: "Installation ID", done: view.settings.github.installationId !== undefined },
    { label: "Private key", done: view.secrets.github_private_key?.set === true },
    { label: "Webhook secret", done: view.secrets.github_webhook_secret?.set === true },
  ];
  const ready = items.slice(0, 3).every((i) => i.done);
  return (
    <section
      aria-labelledby="settings-connection-heading"
      data-testid="settings-connection"
      className="flex flex-col gap-3"
    >
      <h2 id="settings-connection-heading" className="text-sm font-bold">
        GitHub connection:{" "}
        <span data-testid="settings-connection-state" className={ready ? "text-primary" : ""}>
          {ready ? "ready to sync" : "not ready to sync"}
        </span>
      </h2>
      <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {items.map((item) => (
          <li key={item.label} className="flex min-h-6 items-center gap-1.5">
            <CheckIcon done={item.done} />
            <span>{item.label}</span>
            <span className="text-muted-foreground">{item.done ? "set" : "missing"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The `/admin/workspace` form (workspace-settings design decision 7): the GitHub App, which
 * repositories are shown, docs folders, limits, sync, comments and Ask limits. Secrets are
 * write-only: the page shows whether each is set and when it changed, never the value. Saving is
 * optimistic (it carries the version it was loaded from), so a change made by someone else in the
 * meantime is reported instead of overwritten.
 */
export function GithubSettingsForm({ initial }: { readonly initial: SettingsView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [form, setForm] = useState<SettingsFormState>(() => formFromSettings(initial.settings));
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [clear, setClear] = useState<Record<SecretName, boolean>>({
    github_private_key: false,
    github_webhook_secret: false,
  });
  const [problems, setProblems] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);

  const set = <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const secret = (name: string) => view.secrets[name] ?? { set: false, updatedAt: null };

  function secretsToSend(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    const entries: [SecretName, string][] = [
      ["github_private_key", privateKey],
      ["github_webhook_secret", webhookSecret],
    ];
    for (const [name, value] of entries) {
      if (clear[name]) out[name] = null;
      else if (value.trim() !== "") out[name] = value;
    }
    return out;
  }

  function applyView(next: SettingsView): void {
    setView(next);
    setForm(formFromSettings(next.settings));
    setPrivateKey("");
    setWebhookSecret("");
    setClear({ github_private_key: false, github_webhook_secret: false });
  }

  async function onSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    const built = buildSettings(form, view.settings);
    if (!built.ok) {
      setProblems(built.errors);
      return;
    }
    setProblems([]);
    setMessage(null);
    setBusy("save");
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: view.version,
          settings: built.settings,
          secrets: secretsToSend(),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as Partial<SettingsView> & {
        error?: string;
        code?: string;
        problems?: string[];
      };
      if (response.status === 409) {
        setStale(true);
        setMessage(data.error ?? "The settings changed. Reload the page and try again.");
      } else if (!response.ok) {
        setProblems(data.problems ?? [data.error ?? "The request failed."]);
      } else {
        applyView(data as SettingsView);
        setStale(false);
        setMessage("Saved. The next sync, webhook and question use these settings.");
        router.refresh();
      }
    } catch {
      setMessage("The request failed. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function onTest(): Promise<void> {
    setProblems([]);
    setMessage(null);
    setBusy("test");
    try {
      const appId = Number(form.appId.trim());
      const installationId = Number(form.installationId.trim());
      const response = await fetch("/api/admin/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(Number.isInteger(appId) && appId > 0 ? { appId } : {}),
          ...(Number.isInteger(installationId) && installationId > 0 ? { installationId } : {}),
          ...(privateKey.trim() !== "" ? { privateKey } : {}),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        result?: string;
        repositories?: number;
        error?: string;
        retryAfterSeconds?: number;
      };
      if (response.status === 429) {
        setMessage(`Too many tests. Try again in ${data.retryAfterSeconds ?? 60} seconds.`);
      } else if (!response.ok) {
        setMessage(data.error ?? "The request failed.");
      } else if (data.result === "ok") {
        const n = data.repositories ?? 0;
        setMessage(
          `Test passed: the installation can access ${n} ${n === 1 ? "repository" : "repositories"}.`,
        );
      } else {
        setMessage((data.result && TEST_MESSAGES[data.result]) || TEST_MESSAGES.unavailable!);
      }
    } catch {
      setMessage(TEST_MESSAGES.unavailable!);
    } finally {
      setBusy(null);
    }
  }

  const keyProblem = view.problems.encryptionKey;
  const unreadable = view.problems.unreadable;

  return (
    <form onSubmit={onSave} noValidate className="flex max-w-5xl flex-col gap-8">
      {keyProblem ? (
        <p role="alert" data-testid="settings-key-problem" className="text-sm text-destructive">
          {keyProblem}. Secrets cannot be read or saved until the server has a valid encryption key.
        </p>
      ) : null}
      {unreadable.length > 0 ? (
        <p role="alert" data-testid="settings-unreadable" className="text-sm text-destructive">
          A stored secret cannot be read with the current encryption key. Enter it again below.
        </p>
      ) : null}
      {view.problems.invalidStored ? (
        <p role="alert" className="text-sm text-destructive">
          The saved settings are not valid, so defaults are shown. Saving replaces them.
        </p>
      ) : null}

      <ConnectionSummary view={view} />

      <div className="lg:columns-2 lg:gap-x-14">
        <Section
          title="GitHub App"
          intro="The read-only GitHub App installation the portal syncs from. Secrets are encrypted and never shown again."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              label="App ID"
              value={form.appId}
              onChange={(v) => set("appId", v)}
              inputMode="numeric"
              hint="From the GitHub App settings page."
              testId="settings-app-id"
            />
            <TextField
              label="Installation ID"
              value={form.installationId}
              onChange={(v) => set("installationId", v)}
              inputMode="numeric"
              hint="The number at the end of the installation's URL."
              testId="settings-installation-id"
            />
          </div>
          <SecretField
            label="Private key (PEM)"
            isSet={secret("github_private_key").set}
            updatedAt={secret("github_private_key").updatedAt}
            value={privateKey}
            onChange={setPrivateKey}
            clear={clear.github_private_key}
            onClearChange={(c) => setClear((s) => ({ ...s, github_private_key: c }))}
            multiline
            hint="Paste the whole file the App issued, including the BEGIN and END lines."
            testId="settings-private-key"
          />
          <SecretField
            label="Webhook secret"
            isSet={secret("github_webhook_secret").set}
            updatedAt={secret("github_webhook_secret").updatedAt}
            value={webhookSecret}
            onChange={setWebhookSecret}
            clear={clear.github_webhook_secret}
            onClearChange={(c) => setClear((s) => ({ ...s, github_webhook_secret: c }))}
            hint="At least 16 characters; the same secret configured on the GitHub App."
            testId="settings-webhook-secret"
          />
        </Section>

        <Section
          title="Repositories"
          intro="Narrows what the App installation can access. It never grants access."
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm">Repositories shown</legend>
            {MODES.map((m) => (
              <label key={m.value} className="flex min-h-6 items-center gap-2.5 text-sm">
                <input
                  type="radio"
                  name="repo-mode"
                  value={m.value}
                  checked={form.mode === m.value}
                  onChange={() => set("mode", m.value)}
                  className="h-4 w-4 accent-primary"
                />
                <span>
                  {m.label}
                  {m.hint ? <span className="block text-muted-foreground">{m.hint}</span> : null}
                </span>
              </label>
            ))}
          </fieldset>
          {form.mode !== "all" ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="settings-repos" className="text-sm">
                {form.mode === "only" ? "Repositories to show" : "Repositories to leave out"}
              </label>
              <textarea
                id="settings-repos"
                value={form.repoLines}
                onChange={(e) => set("repoLines", e.target.value)}
                rows={6}
                spellCheck={false}
                aria-describedby="settings-repos-hint"
                className={`${fieldClass} font-mono text-sm`}
              />
              <p id="settings-repos-hint" className="text-sm text-muted-foreground">
                {form.mode === "only"
                  ? "One repository name per line (no owner). Add docsPath=folder to change its docs folder, or apiSpecs=path1,path2 to name its API spec files."
                  : "One repository name per line (no owner)."}
              </p>
            </div>
          ) : null}
        </Section>

        <Section
          title="Docs folders"
          intro="Folders tried in order, matched case-insensitively, for repositories without their own."
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="settings-docs-paths" className="text-sm">
              Docs folder candidates
            </label>
            <textarea
              id="settings-docs-paths"
              value={form.docsPaths}
              onChange={(e) => set("docsPaths", e.target.value)}
              rows={3}
              spellCheck={false}
              className={`${fieldClass} font-mono text-sm`}
            />
            <p className="text-sm text-muted-foreground">One folder per line.</p>
          </div>
        </Section>

        <Section
          title="Limits"
          intro="Per repository. Files over the limit are skipped and shown as a warning."
        >
          <TextField
            label="Documents per repository"
            value={form.maxDocsPerRepo}
            onChange={(v) => set("maxDocsPerRepo", v)}
            inputMode="numeric"
            hint="1 to 10000."
          />
          <TextField
            label="Largest document (bytes)"
            value={form.maxFileBytes}
            onChange={(v) => set("maxFileBytes", v)}
            inputMode="numeric"
            hint="1024 to 262144."
          />
          <TextField
            label="Largest API spec (bytes)"
            value={form.maxSpecBytes}
            onChange={(v) => set("maxSpecBytes", v)}
            inputMode="numeric"
            hint="1024 to 2097152."
          />
        </Section>

        <Section
          title="Sync"
          intro="A background full sync catches missed webhooks. The schedule is read when the server starts."
        >
          <TextField
            label="Full sync every (minutes)"
            value={form.intervalMinutes}
            onChange={(v) => set("intervalMinutes", v)}
            inputMode="numeric"
            hint="0 turns periodic runs off; otherwise at least 5."
          />
          <Toggle
            label="Sync shortly after the server starts"
            checked={form.onStartup}
            onChange={(c) => set("onStartup", c)}
          />
        </Section>

        <Section title="Comments">
          <Toggle
            label="Allow comments on documents"
            checked={form.commentsEnabled}
            onChange={(c) => set("commentsEnabled", c)}
            hint="Off removes the Comments section from document pages. Stored comments can still be purged."
          />
        </Section>

        <Section
          title="Ask limits"
          intro="Whether Ask is on, and its provider, are set on the Ask page."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              label="Questions per user per day"
              value={form.questionsPerDay}
              onChange={(v) => set("questionsPerDay", v)}
              inputMode="numeric"
              hint="1 to 10000."
            />
            <TextField
              label="Questions per user per ten minutes"
              value={form.questionsPerTenMinutes}
              onChange={(v) => set("questionsPerTenMinutes", v)}
              inputMode="numeric"
              hint="1 to 1000."
            />
            <TextField
              label="Longest answer (tokens)"
              value={form.maxOutputTokens}
              onChange={(v) => set("maxOutputTokens", v)}
              inputMode="numeric"
              hint="100 to 8000."
            />
            <TextField
              label="Answers at once per server"
              value={form.maxConcurrent}
              onChange={(v) => set("maxConcurrent", v)}
              inputMode="numeric"
              hint="1 to 100."
            />
          </div>
        </Section>
      </div>

      <div className="sticky bottom-0 z-10 flex flex-col gap-3 border-t border-foreground bg-background py-4 pr-16">
        {problems.length > 0 ? (
          <div role="alert" data-testid="settings-problems" className="text-sm text-destructive">
            <ul className="list-disc pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={busy !== null || stale}
            className="min-h-6 w-fit rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy === "save" ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={onTest}
            disabled={busy !== null}
            className="min-h-6 w-fit rounded-md border border-input px-4 py-2 transition-colors hover:border-foreground disabled:opacity-50"
          >
            {busy === "test" ? "Testing…" : "Test GitHub connection"}
          </button>
          {stale ? (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="min-h-6 w-fit rounded-md border border-input px-4 py-2 hover:border-foreground"
            >
              Reload
            </button>
          ) : null}
        </div>
        <p
          role="status"
          data-testid="settings-result"
          className="min-h-5 text-sm text-muted-foreground"
        >
          {message}
        </p>
      </div>
    </form>
  );
}
