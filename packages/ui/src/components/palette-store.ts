/**
 * Open/closed state of the command palette (task 10.4), shared between the one palette mounted in
 * the root layout and anything that opens it (the header trigger, the keyboard shortcut). A tiny
 * external store read with `useSyncExternalStore`: no provider, no context, so a server component
 * can place a client trigger anywhere without wiring.
 *
 * It also remembers which element had focus when the palette opened, so closing can return focus
 * there (a link click does not focus the link in every browser, so the trigger passes itself).
 */

let open = false;
let returnFocusTo: HTMLElement | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribePalette(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isPaletteOpen(): boolean {
  return open;
}

/** The server never renders the palette open. */
export function isPaletteOpenOnServer(): boolean {
  return false;
}

/** Opens the palette. `from` is where focus returns on close (default: the focused element). */
export function openPalette(from?: HTMLElement | null): void {
  if (open) return;
  const active = typeof document === "undefined" ? null : document.activeElement;
  returnFocusTo =
    from ?? (active instanceof HTMLElement && active !== document.body ? active : null);
  open = true;
  emit();
}

export function closePalette(): void {
  if (!open) return;
  open = false;
  emit();
}

export function togglePalette(): void {
  if (open) closePalette();
  else openPalette();
}

/** The element to focus after closing (set by every `openPalette`, so never stale). */
export function returnFocusTarget(): HTMLElement | null {
  return returnFocusTo;
}

/** Back to the initial state. Tests only. */
export function resetPaletteForTests(): void {
  open = false;
  returnFocusTo = null;
}
