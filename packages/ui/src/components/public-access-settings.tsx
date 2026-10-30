"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { failureText } from "@docmyrepos/core/internal/fetch-error";

import { Section, TextField } from "./settings-fields";

/** The settings as the admin API returns them. Local copy: components take data as props. */
export interface PublicAccessView {
  readonly settings: {
    readonly searchEnabled: boolean;
    readonly askEnabled: boolean;
    readonly askQuestionsPerDay: number;
    readonly askQuestionsPerTenMinutes: number;
  };
  /** At least one repository is public (on its own or through a folder). */
  readonly anyPublic: boolean;
}

interface FormState {
  searchEnabled: boolean;
  askEnabled: boolean;
  askQuestionsPerDay: string;
  askQuestionsPerTenMinutes: string;
}

const fromSettings = (s: PublicAccessView["settings"]): FormState => ({
  searchEnabled: s.searchEnabled,
  askEnabled: s.askEnabled,
  askQuestionsPerDay: String(s.askQuestionsPerDay),
  askQuestionsPerTenMinutes: String(s.askQuestionsPerTenMinutes),
});

/** A whole number from digits only, or null (the server checks the range). */
function wholeNumber(text: string): number | null {
  return /^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : null;
}

function Switch({
  label,
  hint,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const hintId = useId();
  return (
    <div className="flex flex-col gap-1">
      <label className="flex min-h-6 items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          aria-describedby={hintId}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 size-4 accent-primary"
        />
        <span className="font-medium">{label}</span>
      </label>
      <p id={hintId} className="pl-6.5 text-sm text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

/**
 * Public access settings, on the Repository access tab: whether visitors who are not signed in may
 * search and use Ask, and the caps all of them share on Ask. They have no effect until a repository
 * or folder is public. Saved on their own, so the GitHub form's version is not involved.
 */
export function PublicAccessSettings({ initial }: { readonly initial: PublicAccessView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [form, setForm] = useState<FormState>(() => fromSettings(initial.settings));
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    const perDay = wholeNumber(form.askQuestionsPerDay);
    const perTen = wholeNumber(form.askQuestionsPerTenMinutes);
    if (perDay === null || perDay < 1 || perDay > 10_000) {
      setProblem("Questions per day must be a whole number from 1 to 10000.");
      return;
    }
    if (perTen === null || perTen < 1 || perTen > 1_000) {
      setProblem("Questions per ten minutes must be a whole number from 1 to 1000.");
      return;
    }
    setProblem(null);
    setMessage(null);
    setBusy(true);
    try {
      const response = await fetch("/api/admin/public-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchEnabled: form.searchEnabled,
          askEnabled: form.askEnabled,
          askQuestionsPerDay: perDay,
          askQuestionsPerTenMinutes: perTen,
        }),
      });
      if (!response.ok) {
        setProblem(await failureText(response));
        return;
      }
      const next = (await response.json()) as PublicAccessView;
      setView(next);
      setForm(fromSettings(next.settings));
      setMessage("Saved. The next anonymous request uses these settings.");
      router.refresh();
    } catch {
      setMessage("The request failed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSave}
      noValidate
      data-testid="public-access"
      className="flex max-w-lg flex-col gap-5"
    >
      <Section
        title="Public access"
        intro="What visitors who are not signed in may do on the repositories and folders marked Public. Signed-in users are not affected."
      >
        {view.anyPublic ? null : (
          <p data-testid="public-access-nothing" className="text-sm text-muted-foreground">
            Nothing is public yet, so these switches take effect once you mark a repository or
            folder Public.
          </p>
        )}
        <Switch
          label="Allow search"
          hint="Anonymous visitors get the search bar and the quick search, over public repositories only."
          checked={form.searchEnabled}
          onChange={(searchEnabled) => setForm((f) => ({ ...f, searchEnabled }))}
        />
        <Switch
          label="Allow Ask the docs"
          hint="Anonymous visitors may ask questions, answered from public repositories only. Also needs Ask turned on with a provider on the Ask tab. Every question is paid for by the portal, so the caps below are shared by all anonymous visitors."
          checked={form.askEnabled}
          onChange={(askEnabled) => setForm((f) => ({ ...f, askEnabled }))}
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Anonymous questions per day"
            hint="1 to 10000, all visitors together."
            inputMode="numeric"
            value={form.askQuestionsPerDay}
            onChange={(askQuestionsPerDay) => setForm((f) => ({ ...f, askQuestionsPerDay }))}
          />
          <TextField
            label="Anonymous questions per ten minutes"
            hint="1 to 1000, all visitors together."
            inputMode="numeric"
            value={form.askQuestionsPerTenMinutes}
            onChange={(askQuestionsPerTenMinutes) =>
              setForm((f) => ({ ...f, askQuestionsPerTenMinutes }))
            }
          />
        </div>
      </Section>
      {problem ? (
        <p role="alert" data-testid="public-access-problem" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="min-h-6 w-fit rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save public access"}
      </button>
      <p
        role="status"
        data-testid="public-access-result"
        className="min-h-5 text-sm text-muted-foreground"
      >
        {message}
      </p>
    </form>
  );
}
