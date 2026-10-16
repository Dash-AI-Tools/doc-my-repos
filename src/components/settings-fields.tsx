import { useId, type ReactNode } from "react";

import { fieldClass } from "@/lib/ui";

export function Section({
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
        <h2 id={id} className="text-xl font-bold">
          {title}
        </h2>
        {intro ? <p className="text-sm text-muted-foreground">{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function TextField({
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
