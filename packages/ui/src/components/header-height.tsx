"use client";

import { useRef } from "react";

import { useTrackHeight } from "./track-height";

/**
 * Renders nothing; publishes the height of the site header it sits in as `--site-header-h` (see
 * `useTrackHeight`). A child of the `<header>`, so its `parentElement` is the header.
 */
export function HeaderHeight() {
  const marker = useRef<HTMLSpanElement>(null);
  useTrackHeight(() => marker.current?.parentElement ?? null, "--site-header-h");
  return <span ref={marker} hidden />;
}
