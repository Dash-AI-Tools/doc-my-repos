/**
 * Reading preferences shared by the server layout, the header controls and the read mode provider
 * (reading-accessibility 1.1): the five text size steps, the two preference cookies, how a cookie
 * value is read, and how a preference is written back. No React, no server imports, so the layout
 * (which reads the cookies on the server) and the client components cannot disagree about the
 * contract.
 *
 * Both preferences are per browser and need no account. The default of each is "no cookie".
 */

/** One text size step. `percent` is what the reader sees; `scale` is the same value for CSS. */
export interface TextSizeStep {
  readonly id: TextSizeId;
  readonly label: string;
  readonly percent: number;
  readonly scale: number;
}

export const TEXT_SIZE_STEPS = [
  { id: "small", label: "Small", percent: 87.5, scale: 0.875 },
  { id: "default", label: "Default", percent: 100, scale: 1 },
  { id: "large", label: "Large", percent: 112.5, scale: 1.125 },
  { id: "larger", label: "Larger", percent: 125, scale: 1.25 },
  { id: "largest", label: "Largest", percent: 150, scale: 1.5 },
] as const satisfies readonly TextSizeStep[];

export type TextSizeId = "small" | "default" | "large" | "larger" | "largest";

export const DEFAULT_TEXT_SIZE: TextSizeId = "default";

export const TEXT_SIZE_COOKIE = "docmyrepos-text-size";
export const READ_KEY_COOKIE = "docmyrepos-read-key";

/** The shortcut is on unless its cookie says `off`. */
export type ReadKeyChoice = "on" | "off";

export const DEFAULT_READ_KEY: ReadKeyChoice = "on";

/** One year, in seconds. */
const PREFERENCE_MAX_AGE = 60 * 60 * 24 * 365;

/** The step with this id. Every id in `TextSizeId` has one. */
export function textSizeStep(id: TextSizeId): TextSizeStep {
  const step = TEXT_SIZE_STEPS.find((candidate) => candidate.id === id);
  if (step === undefined) throw new Error(`unknown text size: ${id}`);
  return step;
}

/**
 * The size named by a stored value. Anything that is not exactly one of the five names (missing,
 * an array, an object, an overlong string, a different case) is the default, so a hand-edited or
 * stale cookie never breaks a page.
 */
export function parseTextSize(value: unknown): TextSizeId {
  return TEXT_SIZE_STEPS.find((step) => step.id === value)?.id ?? DEFAULT_TEXT_SIZE;
}

/** The shortcut setting named by a stored value. Only `off` turns it off; anything else is on. */
export function parseReadKey(value: unknown): ReadKeyChoice {
  return value === "off" ? "off" : DEFAULT_READ_KEY;
}

/**
 * The `Set-Cookie` value that stores `value` under `name`, or clears it when `value` is null.
 * Path is the whole site and the cookie lasts one year. `Secure` is added only when the page was
 * served over https, so the browser keeps the cookie in local http development too.
 */
export function serializePreference(
  name: string,
  value: string | null,
  options: { readonly secure: boolean },
): string {
  const attributes =
    value === null
      ? `Path=/; Max-Age=0; SameSite=Lax`
      : `Path=/; Max-Age=${PREFERENCE_MAX_AGE}; SameSite=Lax`;
  const secure = options.secure ? "; Secure" : "";
  return `${name}=${value ?? ""}; ${attributes}${secure}`;
}

/** The parts of a key press `isReadShortcut` reads. Structural, so no DOM types are needed. */
export interface ShortcutKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
  readonly repeat: boolean;
}

/** The element a key press was aimed at, reduced to what the eligibility rules need. */
export interface ShortcutTarget {
  readonly tagName: string;
  readonly isContentEditable: boolean;
  readonly role: string | null;
}

/** What the page is doing when the key is pressed. */
export interface ShortcutContext {
  /** The reader's shortcut setting (`docmyrepos-read-key`). */
  readonly enabled: boolean;
  /** The page shows a document, so read mode can turn on. */
  readonly available: boolean;
  /** A dialog, the search palette or the text size panel has the reader's attention. */
  readonly overlayOpen: boolean;
}

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const TEXT_ENTRY_ROLES = new Set(["textbox", "combobox", "searchbox"]);

/** Whether a key press is the read mode shortcut: `R` (Shift allowed), and nothing else. */
export function isReadShortcut(
  event: ShortcutKeyEvent,
  target: ShortcutTarget | null,
  context: ShortcutContext,
): boolean {
  if (event.key !== "r" && event.key !== "R") return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.isComposing || event.repeat) return false;
  if (!context.enabled || !context.available || context.overlayOpen) return false;
  if (target === null) return true;
  if (TEXT_ENTRY_TAGS.has(target.tagName.toUpperCase())) return false;
  if (target.isContentEditable) return false;
  if (target.role !== null && TEXT_ENTRY_ROLES.has(target.role)) return false;
  return true;
}
