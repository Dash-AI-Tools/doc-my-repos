"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  INITIAL_VIEW,
  PAN_FAST_FACTOR,
  PAN_STEP,
  ZOOM_STEP,
  panBy,
  percentOf,
  transformOf,
  wheelFactor,
  zoomAt,
  type Size,
  type View,
} from "./pan-zoom";

/**
 * Enlarge, pan and zoom view for one rendered Mermaid diagram (task 7.8, spec "Mermaid diagrams":
 * a diagram can be enlarged into a pannable view that closes from the keyboard).
 *
 * `MermaidViewer` wraps the inline diagram. It adds one real `<button>` laid over the diagram
 * ("Enlarge diagram": keyboard focusable, visible focus ring, Enter and Space as for any button)
 * and, once clicked, a modal dialog with its own copy of the diagram. The inline diagram and its
 * SVG are not touched or moved. The overlay covers the diagram so a click anywhere on it opens the
 * view; a wide diagram is scrolled there instead.
 *
 * Dialog
 *  - The native `<dialog>` opened with `showModal()`: top layer, inert page behind it, focus kept
 *    inside, Esc closes. Where `showModal` does not exist (older engines, jsdom) the `open`
 *    attribute is set and the same classes keep it fixed over the page; the Esc, Close and backdrop
 *    handling below does not depend on the native behavior.
 *  - The `<dialog>` element itself is the full-screen backdrop (tinted, `backdrop:bg-transparent`),
 *    and a panel inside it fills the visible box. A click that starts and ends on the backdrop
 *    closes the view; a drag that ends outside the panel does not.
 *  - `aria-modal="true"` and `aria-labelledby` point at the visible title. Focus moves to the pan
 *    area on open and returns to the Enlarge button on close. The page cannot scroll while the
 *    view is open (`overflow: hidden` on `<html>`, restored on close).
 *  - The panel is only mounted while open, so every opening starts from the initial view
 *    (fit to the panel, 100%).
 *
 * Diagram copy
 *  - The dialog asks for its own render through the `render` prop (MermaidDiagram passes
 *    `renderDiagram(source, id, theme)` with the current theme), so element ids are unique on the
 *    page. Same safety rule as `MermaidDiagram`: the only HTML sink is `dangerouslySetInnerHTML`
 *    with the SVG string `mermaid.render` returned in `securityLevel: "strict"`. No author string
 *    reaches it, and a failure is shown as a fixed message, never as markup.
 *
 * Pan and zoom (pure math in `pan-zoom.ts`)
 *  - Pointer events with pointer capture; `touch-action: none` on the pan area. One pointer pans,
 *    two pointers pinch (zoom around the midpoint and pan with it). The wheel zooms around the
 *    pointer, through a non-passive listener so the page does not scroll.
 *  - Keyboard (focus in the dialog): arrow keys move the view (Shift: further), `+`/`=` and `-`
 *    zoom, `0` resets. Buttons: Zoom out, Zoom in, Reset zoom (shows the percentage).
 *  - Scale is clamped to `MIN_SCALE`..`MAX_SCALE`; the diagram cannot be dragged out of sight.
 *  - Button and key changes ease over 150 ms; dragging, the wheel and pinch never animate, and
 *    `prefers-reduced-motion` turns the easing off (Tailwind `motion-reduce`).
 */

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400";

const TOOL_BUTTON = `cursor-pointer rounded border border-gray-300 bg-white px-2.5 py-1 text-sm font-medium text-gray-800 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800 ${FOCUS_RING}`;

const RENDER_FAILED_MESSAGE = "The enlarged diagram could not be rendered.";

export function MermaidViewer({
  render,
  children,
}: {
  /**
   * Renders the diagram for the dialog and resolves to the strict-mode SVG string. Must be stable
   * (`useCallback`) for as long as the source and theme are the same: a new function re-renders.
   */
  readonly render: (baseId: string) => Promise<string>;
  /** The inline diagram. */
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return (
    <div className="dmr-mermaid-viewer group relative">
      {children}
      <button
        ref={trigger}
        type="button"
        aria-label="Enlarge diagram"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={`absolute inset-0 cursor-zoom-in rounded ${FOCUS_RING}`}
      >
        <span
          aria-hidden="true"
          className="absolute top-2 right-2 rounded border border-gray-300 bg-white/90 p-1 text-gray-700 opacity-70 group-hover:opacity-100 group-focus-within:opacity-100 dark:border-gray-600 dark:bg-gray-900/90 dark:text-gray-200"
        >
          <ExpandIcon />
        </span>
      </button>
      {open ? <ViewerDialog render={render} onClose={close} /> : null}
    </div>
  );
}

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly svg: string }
  | { readonly status: "error" };

interface Point {
  readonly x: number;
  readonly y: number;
}

function ViewerDialog({
  render,
  onClose,
}: {
  readonly render: (baseId: string) => Promise<string>;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const titleId = `dmr-viewer-title-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const hintId = `dmr-viewer-hint-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const baseId = `dmr-mermaid-viewer-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;

  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [smooth, setSmooth] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const backdropDown = useRef(false);

  // Open as a modal, move focus into it, lock page scroll; undo all of it on unmount.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else {
      dialog.setAttribute("open", "");
    }
    stageRef.current?.focus();
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previousOverflow;
      try {
        if (typeof dialog.close === "function" && dialog.open) dialog.close();
      } catch {
        // The element is going away anyway.
      }
    };
  }, []);

  // The dialog's own render. A new `render` (source or theme changed) replaces the result; the
  // previous diagram stays until then.
  useEffect(() => {
    let cancelled = false;
    render(baseId).then(
      (svg) => {
        if (!cancelled) setLoaded({ status: "ready", svg });
      },
      () => {
        if (!cancelled) setLoaded({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [render, baseId]);

  const sizeOf = useCallback((): Size | undefined => {
    const rect = stageRef.current?.getBoundingClientRect();
    return rect === undefined ? undefined : { width: rect.width, height: rect.height };
  }, []);

  /** Point relative to the stage center, the origin the view math uses. */
  const fromCenter = useCallback((clientX: number, clientY: number): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect === undefined) return { x: 0, y: 0 };
    return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) };
  }, []);

  const zoomBy = useCallback(
    (factor: number, animate: boolean, at: Point = { x: 0, y: 0 }) => {
      setSmooth(animate);
      setView((v) => zoomAt(v, v.scale * factor, at.x, at.y, sizeOf()));
    },
    [sizeOf],
  );

  const moveBy = useCallback(
    (dx: number, dy: number, animate: boolean) => {
      setSmooth(animate);
      setView((v) => panBy(v, dx, dy, sizeOf()));
    },
    [sizeOf],
  );

  const reset = useCallback(() => {
    setSmooth(true);
    setView(INITIAL_VIEW);
  }, []);

  // React registers wheel listeners as passive, so `preventDefault` needs a native listener.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomBy(
        wheelFactor(event.deltaY, event.deltaMode, event.ctrlKey),
        false,
        fromCenter(event.clientX, event.clientY),
      );
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [zoomBy, fromCenter]);

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = PAN_STEP * (event.shiftKey ? PAN_FAST_FACTOR : 1);
    switch (event.key) {
      case "ArrowLeft":
        moveBy(-step, 0, true);
        break;
      case "ArrowRight":
        moveBy(step, 0, true);
        break;
      case "ArrowUp":
        moveBy(0, -step, true);
        break;
      case "ArrowDown":
        moveBy(0, step, true);
        break;
      case "+":
      case "=":
        zoomBy(ZOOM_STEP, true);
        break;
      case "-":
      case "_":
        zoomBy(1 / ZOOM_STEP, true);
        break;
      case "0":
        reset();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Not supported (jsdom) or the pointer is gone; dragging still works while over the area.
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const map = pointers.current;
    const previous = map.get(event.pointerId);
    if (previous === undefined) return;
    const next: Point = { x: event.clientX, y: event.clientY };
    if (map.size === 1) {
      moveBy(next.x - previous.x, next.y - previous.y, false);
    } else if (map.size === 2) {
      const other = Array.from(map.entries()).find(([id]) => id !== event.pointerId)?.[1];
      if (other !== undefined) {
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(next.x - other.x, next.y - other.y);
        const midBefore = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
        const midAfter = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 };
        setSmooth(false);
        setView((v) => {
          const at = fromCenter(midAfter.x, midAfter.y);
          const zoomed =
            before > 0 && after > 0
              ? zoomAt(v, v.scale * (after / before), at.x, at.y, sizeOf())
              : v;
          return panBy(zoomed, midAfter.x - midBefore.x, midAfter.y - midBefore.y, sizeOf());
        });
      }
    }
    map.set(event.pointerId, next);
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    if (pointers.current.size === 0) setDragging(false);
  }

  const percent = percentOf(view);

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        backdropDown.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && backdropDown.current) onClose();
        backdropDown.current = false;
      }}
      className="dmr-mermaid-dialog fixed inset-0 m-0 h-full max-h-none w-full max-w-none items-center justify-center bg-black/60 p-3 text-gray-900 backdrop:bg-transparent open:flex sm:p-6 dark:text-gray-100"
    >
      <div className="flex h-full max-h-[60rem] w-full max-w-7xl flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
          <h2 id={titleId} className="mr-auto text-sm font-semibold">
            Diagram
          </h2>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / ZOOM_STEP, true)}
            className={TOOL_BUTTON}
          >
            <span aria-hidden="true">{"−"}</span>
          </button>
          <button
            type="button"
            aria-label={`Reset zoom, currently ${percent}%`}
            onClick={reset}
            className={`${TOOL_BUTTON} min-w-16 tabular-nums`}
          >
            <span aria-hidden="true">{percent}%</span>
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomBy(ZOOM_STEP, true)}
            className={TOOL_BUTTON}
          >
            <span aria-hidden="true">+</span>
          </button>
          <button type="button" onClick={onClose} className={TOOL_BUTTON}>
            Close
          </button>
        </div>
        <p id={hintId} className="sr-only">
          Drag to pan. Use the arrow keys to pan, plus and minus to zoom, zero to reset, and Escape
          to close.
        </p>
        <div
          ref={stageRef}
          role="group"
          aria-label="Diagram pan and zoom area"
          aria-describedby={hintId}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          className={`dmr-mermaid-stage min-h-0 flex-1 touch-none overflow-hidden select-none ${
            dragging ? "cursor-grabbing" : "cursor-grab"
          } -outline-offset-2 focus-visible:outline-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400`}
        >
          {loaded.status === "ready" ? (
            <div
              data-testid="mermaid-viewer-content"
              style={{ transform: transformOf(view), transformOrigin: "center" }}
              className={`dmr-mermaid-stage-content flex h-full w-full items-center justify-center ${
                smooth && !dragging
                  ? "transition-transform duration-150 motion-reduce:transition-none"
                  : ""
              }`}
              dangerouslySetInnerHTML={{ __html: loaded.svg }}
            />
          ) : loaded.status === "error" ? (
            <p role="alert" className="p-4 text-sm font-medium text-red-900 dark:text-red-100">
              {RENDER_FAILED_MESSAGE}
            </p>
          ) : (
            <p aria-busy="true" className="p-4 text-sm text-gray-600 dark:text-gray-400">
              Rendering diagram&hellip;
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}

function ExpandIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4.5 4.5M2.5 13.5 7 9" />
    </svg>
  );
}
