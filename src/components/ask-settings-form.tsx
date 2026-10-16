"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  AI_PROVIDERS,
  isAiProvider,
  providerLabel,
  validateModel,
  type AiProvider,
} from "@/lib/ask/providers";
import { askStatusLine } from "@/lib/ask/status";
import { fieldClass } from "@/lib/ui";

import { SecretField } from "./secret-field";

/** What the admin page knows, as `GET /api/admin/ask` returns it (structural, no server import). */
export interface AskSettingsView {
  readonly settings: {
    readonly enabled: boolean;
    readonly provider: AiProvider | null;
    readonly model: string | null;
  };
  readonly providers: Readonly<
    Record<
      AiProvider,
      {
        readonly configured: boolean;
        readonly missing: readonly string[];
        readonly problem?: string;
        readonly host?: string;
      }
    >
  >;
  /** Stored provider credentials: whether each is set, never the value. */
  readonly credentials: {
    readonly version: number;
    readonly openaiBaseUrl: string | null;
    readonly anthropicKey: { readonly set: boolean; readonly updatedAt: string | null };
    readonly openaiKey: { readonly set: boolean; readonly updatedAt: string | null };
  };
  readonly state:
    | { readonly state: "off" }
    | { readonly state: "ready"; readonly provider: string; readonly model: string }
    | {
        readonly state: "unavailable";
        readonly missing: readonly string[];
        readonly problem?: string;
      };
}

type Field = "provider" | "model";
type FieldErrors = Partial<Record<Field, string>>;

/** The fixed messages for the connection test, one per result word. */
const TEST_MESSAGES: Readonly<Record<string, string>> = {
  ok: "Test passed: the provider accepted the model.",
  rejected: "Test failed: the provider rejected the credentials.",
  not_found: "Test failed: the provider does not know that model.",
  unavailable: "Test failed: the provider could not be reached or returned an error.",
  timeout: "Test failed: the provider did not answer in time.",
};

const MODEL_HINTS: Readonly<Record<AiProvider, string>> = {
  anthropic: "The model identifier as your Anthropic account lists it.",
  "openai-compatible": "The model name exactly as your endpoint expects it.",
};

/** The provider option text: its label and whether the operator has set it up. */
function optionLabel(view: AskSettingsView, provider: AiProvider): string {
  const group = view.providers[provider];
  if (group.configured) {
    return `${providerLabel(provider)} (configured${group.host ? `, ${group.host}` : ""})`;
  }
  if (group.missing.length > 0) {
    return `${providerLabel(provider)} (missing: ${group.missing.join(", ")})`;
  }
  return `${providerLabel(provider)} (not usable)`;
}

/**
 * The `/admin/ask` form (ask-the-docs design decision 9, workspace-settings decision 7): an on/off
 * switch, a provider choice, a model name, Save and Test, and the provider credentials. Keys are
 * write-only: the page only reports whether each is set and when it changed, never the value.
 * Results are fixed messages in a `role="status"` region.
 */
export function AskSettingsForm({ initial }: { readonly initial: AskSettingsView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [enabled, setEnabled] = useState(initial.settings.enabled);
  const [provider, setProvider] = useState<AiProvider | "">(initial.settings.provider ?? "");
  const [model, setModel] = useState(initial.settings.model ?? "");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "credentials" | null>(null);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiUrl, setOpenaiUrl] = useState(initial.credentials.openaiBaseUrl ?? "");
  const [clearAnthropic, setClearAnthropic] = useState(false);
  const [clearOpenai, setClearOpenai] = useState(false);
  const [credProblems, setCredProblems] = useState<string[]>([]);
  const [credMessage, setCredMessage] = useState<string | null>(null);

  const chosen = isAiProvider(provider) ? provider : null;
  const chosenGroup = chosen ? view.providers[chosen] : null;
  const canEnable = chosenGroup?.configured === true && validateModel(model).ok;
  const status = askStatusLine(view.state);

  function validate(requireBoth: boolean): FieldErrors {
    const found: FieldErrors = {};
    if (chosen === null && (requireBoth || model.trim() !== "")) {
      found.provider = "Choose a provider.";
    }
    if (model.trim() !== "" || requireBoth) {
      const checked = validateModel(model);
      if (!checked.ok) found.model = `The model name ${checked.reason}.`;
    }
    return found;
  }

  /** Applies a 400 that names a field; returns false if the response named none. */
  function showServerError(data: { error?: string; field?: string }): void {
    if (data.field === "provider" || data.field === "model") {
      setErrors({ [data.field]: data.error ?? "This value is not valid." });
    } else {
      setMessage(data.error ?? "The request failed.");
    }
  }

  async function onSave(event: FormEvent): Promise<void> {
    event.preventDefault();
    const found = validate(false);
    if (enabled && !canEnable) {
      if (chosen === null) found.provider ??= "Choose a provider before turning Ask on.";
      else if (!chosenGroup?.configured) found.provider ??= "This provider is not configured.";
      if (model.trim() === "") found.model ??= "Enter a model name before turning Ask on.";
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy("save");
    setMessage(null);
    try {
      const response = await fetch("/api/admin/ask", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          ...(chosen ? { provider: chosen } : {}),
          ...(model.trim() !== "" ? { model: model.trim() } : {}),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as Partial<AskSettingsView> & {
        error?: string;
        field?: string;
      };
      if (!response.ok) {
        showServerError(data);
        return;
      }
      setView(data as AskSettingsView);
      setMessage(enabled ? "Saved. Ask is on." : "Saved. Ask is off.");
      router.refresh();
    } catch {
      setMessage("The request failed. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function onTest(): Promise<void> {
    const found = validate(true);
    setErrors(found);
    if (Object.keys(found).length > 0 || chosen === null) return;
    setBusy("test");
    setMessage(null);
    try {
      const response = await fetch("/api/admin/ask/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: chosen, model: model.trim() }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        result?: string;
        error?: string;
        field?: string;
        retryAfterSeconds?: number;
      };
      if (response.status === 429) {
        setMessage(`Too many tests. Try again in ${data.retryAfterSeconds ?? 60} seconds.`);
      } else if (!response.ok) {
        showServerError(data);
      } else {
        setMessage((data.result && TEST_MESSAGES[data.result]) || TEST_MESSAGES.unavailable!);
      }
    } catch {
      setMessage(TEST_MESSAGES.unavailable!);
    } finally {
      setBusy(null);
    }
  }

  async function onSaveCredentials(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy("credentials");
    setCredProblems([]);
    setCredMessage(null);
    const secrets: Record<string, string | null> = {};
    if (clearAnthropic) secrets.anthropic_api_key = null;
    else if (anthropicKey.trim() !== "") secrets.anthropic_api_key = anthropicKey;
    if (clearOpenai) secrets.openai_api_key = null;
    else if (openaiKey.trim() !== "") secrets.openai_api_key = openaiKey;
    try {
      const response = await fetch("/api/admin/ask/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: view.credentials.version,
          openaiBaseUrl: openaiUrl.trim() === "" ? null : openaiUrl.trim(),
          secrets,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        problems?: string[];
      };
      if (response.status === 409) {
        setCredMessage(data.error ?? "The settings changed. Reload the page and try again.");
        return;
      }
      if (!response.ok) {
        setCredProblems(data.problems ?? [data.error ?? "The request failed."]);
        return;
      }
      // Re-read the Ask view so provider availability and the stored state are current.
      const fresh = await fetch("/api/admin/ask", { cache: "no-store" });
      if (fresh.ok) {
        const next = (await fresh.json()) as AskSettingsView;
        setView(next);
        setOpenaiUrl(next.credentials.openaiBaseUrl ?? "");
      }
      setAnthropicKey("");
      setOpenaiKey("");
      setClearAnthropic(false);
      setClearOpenai(false);
      setCredMessage("Credentials saved. The next question uses them.");
      router.refresh();
    } catch {
      setCredMessage("The request failed. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  const switchHint = canEnable
    ? "Ask uses the provider and model below."
    : "To turn Ask on, choose a configured provider and enter a model name.";

  return (
    <div className="flex max-w-lg flex-col gap-8">
      <section
        aria-labelledby="ask-state-heading"
        className="flex flex-col gap-2 border-t border-foreground pt-5"
      >
        <h2 id="ask-state-heading" className="text-sm font-bold">
          Current state
        </h2>
        <p data-testid="ask-admin-state" className="text-sm">
          <strong>{status.label}.</strong> {status.detail}
        </p>
        <p className="text-sm text-muted-foreground">
          When Ask is on, each question, the recent conversation and excerpts of the documents the
          reader can see are sent to the provider you choose. The portal stores none of it.
        </p>
      </section>

      <form onSubmit={onSave} className="flex flex-col gap-8" noValidate>
        <section className="flex flex-col gap-5 border-t border-foreground pt-5">
          <div className="flex flex-col gap-1">
            <label className="flex min-h-6 items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                role="switch"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                aria-describedby="ask-enabled-hint"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span>Turn Ask on</span>
            </label>
            <p id="ask-enabled-hint" className="pl-7 text-sm text-muted-foreground">
              {switchHint}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="ask-provider" className="text-sm">
              Provider
            </label>
            <select
              id="ask-provider"
              value={provider}
              onChange={(e) => setProvider(isAiProvider(e.target.value) ? e.target.value : "")}
              aria-invalid={errors.provider ? true : undefined}
              aria-describedby={errors.provider ? "ask-provider-error" : undefined}
              className={fieldClass}
            >
              <option value="">Choose a provider</option>
              {AI_PROVIDERS.map((id) => (
                <option
                  key={id}
                  value={id}
                  // A provider that lost its credentials stays shown if it is the saved choice.
                  disabled={!view.providers[id].configured && view.settings.provider !== id}
                >
                  {optionLabel(view, id)}
                </option>
              ))}
            </select>
            {chosen === "openai-compatible" && chosenGroup?.host ? (
              <p data-testid="ask-endpoint-host" className="text-sm text-muted-foreground">
                Requests go to {chosenGroup.host}.
              </p>
            ) : null}
            {chosenGroup && !chosenGroup.configured ? (
              <p className="text-sm text-muted-foreground">
                {chosenGroup.problem ??
                  `Enter ${chosenGroup.missing.join(", ")} under Credentials below before this provider can be used.`}
              </p>
            ) : null}
            {errors.provider ? (
              <p id="ask-provider-error" role="alert" className="text-sm text-destructive">
                {errors.provider}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="ask-model" className="text-sm">
              Model name
            </label>
            <input
              id="ask-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errors.model ? true : undefined}
              aria-describedby={`ask-model-hint${errors.model ? " ask-model-error" : ""}`}
              className={fieldClass}
            />
            <p id="ask-model-hint" className="text-sm text-muted-foreground">
              {chosen
                ? MODEL_HINTS[chosen]
                : "Choose a provider, then enter the model it should use."}
            </p>
            {errors.model ? (
              <p id="ask-model-error" role="alert" className="text-sm text-destructive">
                {errors.model}
              </p>
            ) : null}
          </div>
        </section>

        <div className="flex flex-col gap-3 border-t border-foreground pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy !== null}
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
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
          </div>
          <p
            role="status"
            data-testid="ask-admin-result"
            className="min-h-5 text-sm text-muted-foreground"
          >
            {message}
          </p>
        </div>
      </form>

      <form
        onSubmit={onSaveCredentials}
        noValidate
        aria-labelledby="ask-credentials-heading"
        className="flex flex-col gap-5 border-t border-foreground pt-5"
      >
        <div className="flex flex-col gap-1">
          <h2 id="ask-credentials-heading" className="text-sm font-bold">
            Credentials
          </h2>
          <p className="text-sm text-muted-foreground">
            Keys are encrypted when saved and never shown again. Leave a key empty to keep the
            stored one.
          </p>
        </div>
        <SecretField
          label="Anthropic API key"
          isSet={view.credentials.anthropicKey.set}
          updatedAt={view.credentials.anthropicKey.updatedAt}
          value={anthropicKey}
          onChange={setAnthropicKey}
          clear={clearAnthropic}
          onClearChange={setClearAnthropic}
          testId="ask-anthropic-key"
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ask-openai-url" className="text-sm">
            OpenAI-compatible base URL
          </label>
          <input
            id="ask-openai-url"
            value={openaiUrl}
            onChange={(e) => setOpenaiUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="ask-openai-url-hint"
            data-testid="ask-openai-url"
            className={fieldClass}
          />
          <p id="ask-openai-url-hint" className="text-sm text-muted-foreground">
            Must be https, or http on a local address such as http://127.0.0.1:11434/v1.
          </p>
        </div>
        <SecretField
          label="OpenAI-compatible API key"
          isSet={view.credentials.openaiKey.set}
          updatedAt={view.credentials.openaiKey.updatedAt}
          value={openaiKey}
          onChange={setOpenaiKey}
          clear={clearOpenai}
          onClearChange={setClearOpenai}
          hint="Required unless the endpoint is on a local address."
          testId="ask-openai-key"
        />
        {credProblems.length > 0 ? (
          <div
            role="alert"
            data-testid="ask-credential-problems"
            className="text-sm text-destructive"
          >
            <ul className="list-disc pl-5">
              {credProblems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-col gap-3">
          <button
            type="submit"
            disabled={busy !== null}
            className="min-h-6 w-fit rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy === "credentials" ? "Saving…" : "Save credentials"}
          </button>
          <p
            role="status"
            data-testid="ask-credential-result"
            className="min-h-5 text-sm text-muted-foreground"
          >
            {credMessage}
          </p>
        </div>
      </form>
    </div>
  );
}
