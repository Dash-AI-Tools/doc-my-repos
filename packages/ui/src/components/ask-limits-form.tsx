"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  buildSettings,
  formFromSettings,
  type SettingsFormState,
} from "@docmyrepos/core/internal/settings-form";

import type { SettingsView } from "./github-settings-form";
import { Section, TextField } from "./settings-fields";

type LimitKey = "questionsPerDay" | "questionsPerTenMinutes" | "maxOutputTokens" | "maxConcurrent";

/**
 * The Ask limits, on the Ask tab. They are part of the workspace settings, so they save through the
 * same optimistic endpoint as the GitHub form (carrying the version they were loaded from), with the
 * other settings sent back as they were loaded.
 */
export function AskLimitsForm({ initial }: { readonly initial: SettingsView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [form, setForm] = useState<SettingsFormState>(() => formFromSettings(initial.settings));
  const [problems, setProblems] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  const field = (key: LimitKey) => ({
    value: form[key],
    onChange: (value: string) => setForm((f) => ({ ...f, [key]: value })),
    inputMode: "numeric" as const,
  });

  async function onSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    const built = buildSettings(form, view.settings);
    if (!built.ok) {
      setProblems(built.errors);
      return;
    }
    setProblems([]);
    setMessage(null);
    setBusy(true);
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: view.version,
          settings: built.settings,
          secrets: {},
        }),
      });
      const data = (await response.json().catch(() => ({}))) as Partial<SettingsView> & {
        error?: string;
        problems?: string[];
      };
      if (response.status === 409) {
        setStale(true);
        setMessage(data.error ?? "The settings changed. Reload the page and try again.");
      } else if (!response.ok) {
        setProblems(data.problems ?? [data.error ?? "The request failed."]);
      } else {
        const next = data as SettingsView;
        setView(next);
        setForm(formFromSettings(next.settings));
        setStale(false);
        setMessage("Saved. The next question uses these limits.");
        router.refresh();
      }
    } catch {
      setMessage("The request failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSave} noValidate className="flex max-w-lg flex-col gap-5">
      <Section title="Ask limits" intro="Per-user and per-server caps on questions and answers.">
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Questions per user per day"
            hint="1 to 10000."
            {...field("questionsPerDay")}
          />
          <TextField
            label="Questions per user per ten minutes"
            hint="1 to 1000."
            {...field("questionsPerTenMinutes")}
          />
          <TextField
            label="Longest answer (tokens)"
            hint="100 to 8000."
            {...field("maxOutputTokens")}
          />
          <TextField
            label="Answers at once per server"
            hint="1 to 100."
            {...field("maxConcurrent")}
          />
        </div>
      </Section>
      {problems.length > 0 ? (
        <div role="alert" data-testid="ask-limits-problems" className="text-sm text-destructive">
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
          disabled={busy || stale}
          className="min-h-6 w-fit rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save limits"}
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
        data-testid="ask-limits-result"
        className="min-h-5 text-sm text-muted-foreground"
      >
        {message}
      </p>
    </form>
  );
}
