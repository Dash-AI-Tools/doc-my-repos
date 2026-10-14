import { useLayoutEffect } from "react";

/**
 * Publishes an element's height as a CSS custom property on `<html>` (`--site-header-h`,
 * `--doc-bar-h`), kept current while the element resizes (the header wraps to a second row on a
 * phone, the document bar is hidden from `xl`). `globals.css` derives `scroll-padding-top` and the
 * sticky offsets from these, with fallbacks for the first paint and for no JavaScript. The
 * property is removed when the element goes away, so the fallback applies again.
 */
export function useTrackHeight(find: () => HTMLElement | null, property: string): void {
  useLayoutEffect(() => {
    const el = find();
    if (el === null) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty(property, `${el.offsetHeight}px`);
    publish();
    if (typeof ResizeObserver !== "function") return () => root.style.removeProperty(property);
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(property);
    };
    // `find` is a stable module-level or ref reader; the property is the only real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property]);
}
