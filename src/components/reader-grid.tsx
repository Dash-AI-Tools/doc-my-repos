import type { ReactNode } from "react";

import type { OutlineItem } from "@/lib/outline";

import { DocNavPanel } from "./doc-nav-panel";
import { OutlineNav } from "./outline-nav";

/**
 * The grid of a reading page (spec "docs-reader-layout"), shared by the document page and the
 * repository page: the main content (`children`), the headings column and the docs structure
 * (`nav`, inside `DocNavPanel`). Render it inside `DocReader`, after `DocNavBar`.
 *
 * - From `xl` (1280px): three tracks, structure | content | headings, the side tracks sticky and
 *   scrolling on their own. The content column is at most 60rem and centred in its track, so the
 *   line length does not grow with the monitor. The tracks widen from `2xl`.
 * - From `lg` (1024px): structure | content; the headings are the dropdown in the bar.
 * - Below `lg`: one column; the structure is the slide-in panel.
 * - DOM order is content, headings, structure: keyboard and screen-reader users reach the content
 *   first, and a visitor without JavaScript finds the two lists after it. Once enhanced, CSS hides
 *   the headings column below `xl`.
 * - The side tracks are divided by `--text-scale` (set per text size in globals.css), so they keep
 *   their pixel width at every text size; the breakpoints are media queries, which do not follow
 *   the root font size, and the content track takes the rest.
 */
export function ReaderGrid({
  outline,
  nav,
  children,
}: {
  readonly outline: readonly OutlineItem[];
  readonly nav: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="reader-grid grid items-start gap-x-[calc(3rem/var(--text-scale,1))] gap-y-8 lg:grid-cols-[calc(15rem/var(--text-scale,1))_minmax(0,1fr)] xl:grid-cols-[calc(16rem/var(--text-scale,1))_minmax(0,1fr)_calc(14rem/var(--text-scale,1))] 2xl:grid-cols-[calc(18rem/var(--text-scale,1))_minmax(0,1fr)_calc(16rem/var(--text-scale,1))]">
      <div className="reader-content flex w-full max-w-[60rem] min-w-0 flex-col gap-12 justify-self-center lg:col-start-2 lg:row-start-1">
        {children}
      </div>

      <div
        data-testid="doc-sidebar"
        data-read-hide
        className="min-w-0 group-data-[enhanced=true]/reader:max-xl:hidden lg:col-start-2 lg:row-start-2 lg:w-full lg:max-w-[60rem] lg:justify-self-center xl:sticky xl:top-24 xl:col-start-3 xl:row-start-1 xl:max-h-[calc(100vh-7rem)] xl:max-w-none xl:justify-self-stretch xl:overflow-y-auto"
      >
        <OutlineNav items={outline} />
      </div>

      <DocNavPanel>{nav}</DocNavPanel>
    </div>
  );
}
