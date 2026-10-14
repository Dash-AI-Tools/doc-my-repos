---
version: 1
slug: "src-app-layout-tsx"
primary_target: "src/app/layout.tsx"
related_targets: ["src/app/globals.css", "src/app/page.tsx"]
---

# Surface brief: portal shell and reading surfaces

Scope: the whole DocMyRepos portal (shell, home, repo space, document page, search, palette, login, admin). Visitor mode: Read (docs surfaces lead); admin and status inherit the same world as Operate.

Audience, job: newcomers and cross-team readers who must find the right document and know where they are. User pinned: minimal, polished, easier to read, easier navigation, light and dark both first-class. Steer: keep the category-standard docs navigation (left tree, article, on-this-page outline, header search) and express it in the Swiss grid world.

Chosen sketch: .impeccable/mocks/decision/model-pick.html (the build matches its arrangement, palette, type and density; responsive page, below-the-fold and states are owed).

Unresolved: dark-theme accent value; Shiki and Mermaid theme tuning to the new palette.

## Direction contract

THESIS: Hierarchy does all the work. Rules, weight and scale replace boxes, tinted fills and shadows; nothing performs behind the text. It refuses the card-grid-with-soft-borders docs portal.

OWN-WORLD: One grotesque (Hanken Grotesk, weights 400 and 700) plus monospace for code only. White and near-black ink (#fff / #111, dark #0c0c0d / #ececec), one blue (#2b59ff, dark #7c9bff) used only for the current location, links and focus. Hairline rules (#ececec), 2px corners, no shadows except overlays. Flush-left everything, 12-column grid, generous margins.

STORY: A reader lands, sees the title and the tree, knows where they stand (breadcrumb, highlighted tree item, outline marker), reads at 65-72ch, and moves on with the tree, outline or previous/next. Search is one keystroke away.

FIRST VIEWPORT: Header 64px: wordmark left, Repositories / Search / Status, underline-style search with ⌘K right, theme toggle. Below: 12-column grid. Columns 1-3 contents tree (repo name label, bold part headings, current item blue and bold). Columns 4-9 breadcrumb, 64px bold title with -0.035em tracking, 21px lead, hairline-ruled h2 sections. Columns 10-12 on-this-page outline. Primary action is search.

FORM: Swiss / International Typographic Style reference manual, position 1 on my ordered list; seed key 14f4a406 (user picked it over the assigned Numbered Manual).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
