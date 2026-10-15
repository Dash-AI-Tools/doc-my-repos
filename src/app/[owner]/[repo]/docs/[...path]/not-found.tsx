import type { Metadata } from "next";

import { DocNotFound } from "@/components/doc-not-found";

/** Rendered with HTTP 404 when the document page calls `notFound()` (task 9.7). */
export const metadata: Metadata = { title: "Document not found" };

export default function NotFound() {
  return <DocNotFound />;
}
