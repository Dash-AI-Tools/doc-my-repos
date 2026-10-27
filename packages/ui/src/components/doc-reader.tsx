"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * The document page's shell and the state its two small-screen controls share (spec
 * "docs-reader-layout"): whether the docs-structure panel is open, the button that opens it (focus
 * goes back there on close), and whether the page is enhanced.
 *
 * - `enhanced` is false on the server and until hydration, so a page without JavaScript keeps the
 *   structure and the headings as plain lists after the article; CSS keys on
 *   `data-enhanced="true"` on this element to turn the structure into a panel and the headings
 *   column into a dropdown below their breakpoints.
 * - `isPanel` is true below `lg` (1024px), where the structure is a panel. It decides the dialog
 *   semantics and the focus handling; the look is CSS.
 * - The panel closes when the pathname changes (a document was chosen) and when the viewport grows
 *   to `lg`. It stays open when only the search string changes: the OKF filter chips are links to
 *   the same page, and a visitor combines them.
 */
interface DocReaderState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly opener: RefObject<HTMLButtonElement | null>;
  readonly enhanced: boolean;
  readonly isPanel: boolean;
}

const Context = createContext<DocReaderState | null>(null);

const SMALL = "(max-width: 1023.98px)";

function subscribeSmall(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(SMALL);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const smallNow = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia(SMALL).matches;

const noSubscription = () => () => {};

export function useDocReader(): DocReaderState {
  const state = useContext(Context);
  if (state === null) throw new Error("useDocReader must be used inside <DocReader>");
  return state;
}

export function DocReader({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [seenPath, setSeenPath] = useState(pathname);
  const opener = useRef<HTMLButtonElement>(null);
  const enhanced = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  const isPanel = useSyncExternalStore(subscribeSmall, smallNow, () => false);

  // Adjusting state while rendering, the pattern React recommends for state derived from props.
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    if (open) setOpen(false);
  }
  if (open && !isPanel) setOpen(false);

  const value = useMemo<DocReaderState>(
    () => ({ open, setOpen, opener, enhanced, isPanel }),
    [open, enhanced, isPanel],
  );
  return (
    <Context value={value}>
      <div
        data-enhanced={enhanced ? "true" : "false"}
        className="doc-reader group/reader flex flex-col gap-8"
      >
        {children}
      </div>
    </Context>
  );
}
