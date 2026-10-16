"use client";

import { useId } from "react";

import { fieldClass } from "@/lib/ui";

/**
 * A write-only secret input (workspace-settings design decision 3). It shows only whether a value
 * is stored and when it changed, never the value, a part of it or its length. An empty field keeps
 * the stored value; typing replaces it; "Clear" removes it. The browser is asked not to remember it.
 */
export interface SecretFieldProps {
  readonly label: string;
  readonly isSet: boolean;
  /** ISO time of the last change, or null. */
  readonly updatedAt: string | null;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly clear: boolean;
  readonly onClearChange: (clear: boolean) => void;
  /** A multi-line value such as a PEM key. */
  readonly multiline?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly testId?: string;
}

function changedText(updatedAt: string | null): string {
  if (updatedAt === null) return "Set.";
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "Set.";
  return `Set, changed ${date.toISOString().slice(0, 16).replace("T", " ")} UTC.`;
}

export function SecretField({
  label,
  isSet,
  updatedAt,
  value,
  onChange,
  clear,
  onClearChange,
  multiline = false,
  hint,
  error,
  testId,
}: SecretFieldProps) {
  const id = useId();
  const describedBy = [`${id}-state`, hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  const common = {
    id,
    value: clear ? "" : value,
    disabled: clear,
    autoComplete: "off",
    spellCheck: false,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  } as const;
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <p
        id={`${id}-state`}
        data-testid={testId ? `${testId}-state` : undefined}
        className="text-sm"
      >
        <strong>{isSet ? changedText(updatedAt) : "Not set."}</strong>
        {isSet ? " Enter a new value to replace it, or leave this empty to keep it." : null}
      </p>
      {multiline ? (
        <textarea
          {...common}
          rows={4}
          onChange={(e) => onChange(e.target.value)}
          placeholder="-----BEGIN RSA PRIVATE KEY-----"
          className={`${fieldClass} font-mono text-sm`}
        />
      ) : (
        <input
          {...common}
          type="password"
          onChange={(e) => onChange(e.target.value)}
          className={fieldClass}
        />
      )}
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {isSet ? (
        <label className="flex min-h-6 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={clear}
            onChange={(e) => onClearChange(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          <span>Clear this value when I save</span>
        </label>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
