"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Whether the page on screen can be read in read mode (reading-accessibility 2.2, spec
 * "read-mode", "Where read mode is available"). A document page renders `<ReadModeTarget />`; that
 * registers it here on mount and removes it on unmount. Nothing checks the route, so another page
 * type opts in by rendering the same marker, and navigating away from a document unmounts it.
 *
 * The count, not a flag, keeps two targets on one page correct: the page stays readable until the
 * last one is gone. An external store in the style of `palette-store`, read with
 * `useSyncExternalStore`, so the server renders nothing and no button appears before mount.
 */

let targets = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribeReadModeTargets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readModeAvailable(): boolean {
  return targets > 0;
}

/** The server never knows a page is readable before its client components mount. */
function readModeAvailableOnServer(): boolean {
  return false;
}

function registerReadModeTarget(): () => void {
  targets += 1;
  emit();
  return () => {
    targets -= 1;
    emit();
  };
}

/** Whether a mounted `ReadModeTarget` is on the page. */
export function useReadModeAvailable(): boolean {
  return useSyncExternalStore(
    subscribeReadModeTargets,
    readModeAvailable,
    readModeAvailableOnServer,
  );
}

/** Marks the page as one that can be read in read mode. Renders nothing. */
export function ReadModeTarget() {
  useEffect(registerReadModeTarget, []);
  return null;
}
