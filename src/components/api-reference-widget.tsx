"use client";

import { useEffect } from "react";
import SwaggerUI from "swagger-ui-react";
import "swagger-ui-react/swagger-ui.css";
import "./api-reference.css";

import { apiReferenceProps } from "./api-reference-config";

/**
 * The widget opens the operation named by `#/<tag>/<operationId>` (deep linking) but does not
 * scroll to it when it is mounted from a spec object. Once the operation's element exists, bring
 * it into view. The element is found by `getElementById` only, so nothing in the fragment is used
 * as a selector, and the fragment never leaves the browser.
 */
function scrollToDeepLink(): () => void {
  let hash: string;
  try {
    hash = decodeURIComponent(window.location.hash);
  } catch {
    return () => {};
  }
  const parts = hash.replace(/^#!?\/?/, "").split("/");
  if (parts.length !== 2 || parts.some((p) => p === "")) return () => {};
  const id = `operations-${parts[0]}-${parts[1]}`;
  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    const element = document.getElementById(id);
    if (element !== null && element.querySelector(".opblock-body") !== null) {
      window.clearInterval(timer);
      element.scrollIntoView({ block: "start" });
    } else if (tries >= 40) {
      window.clearInterval(timer);
    }
  }, 100);
  return () => window.clearInterval(timer);
}

/**
 * The Swagger UI widget. Loaded only through `next/dynamic` in `api-reference.tsx`, so the
 * script and its stylesheet (which is global once imported) stay off every other page. The
 * stylesheet after it maps the widget to the design tokens (see api-reference.css).
 */
export default function ApiReferenceWidget({ spec }: { readonly spec: object }) {
  useEffect(() => scrollToDeepLink(), []);
  return <SwaggerUI {...apiReferenceProps(spec)} />;
}
