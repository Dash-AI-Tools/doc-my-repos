---
name: DocMyRepos
description: A Swiss reference-manual documentation portal. Ink on paper, one blue, rules instead of boxes.
colors:
  paper: "#ffffff"
  ink: "#111111"
  signal-blue: "#2b59ff"
  signal-blue-deep: "#1a3bc4"
  blue-wash: "#eaf0ff"
  blue-selection: "#cddaff"
  quiet-ink: "#5c5c5c"
  hairline: "#e4e4e4"
  control-edge: "#858585"
  tint: "#f5f5f5"
  private-grey: "#efefef"
  alarm-red: "#b91c1c"
  alarm-wash: "#fef2f2"
  alarm-edge: "#fca5a5"
  notice-amber-wash: "#fef3c7"
  notice-amber-ink: "#78350f"
  night: "#0c0c0d"
  night-ink: "#ececec"
  night-blue: "#7c9bff"
  night-link: "#8aa6ff"
  night-quiet-ink: "#a1a1a6"
  night-hairline: "#262628"
  night-control-edge: "#7d7d83"
  night-tint: "#151516"
  night-overlay: "#161617"
  night-blue-wash: "#172250"
typography:
  display:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "60px"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "Hanken Grotesk Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: "2px"
  md: "3px"
  lg: "4px"
  xl: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "32px"
  xl: "48px"
components:
  site-header:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    height: "64px"
  palette-trigger:
    textColor: "{colors.quiet-ink}"
    height: "36px"
    width: "256px"
  palette-trigger-hover:
    textColor: "{colors.ink}"
  theme-toggle-option:
    textColor: "{colors.quiet-ink}"
    size: "28px"
    rounded: "{rounded.lg}"
  theme-toggle-option-selected:
    textColor: "{colors.ink}"
  docs-tree-link:
    textColor: "{colors.quiet-ink}"
    typography: "{typography.label}"
  docs-tree-link-current:
    textColor: "{colors.signal-blue}"
  docs-tree-folder:
    textColor: "{colors.ink}"
  outline-link:
    textColor: "{colors.quiet-ink}"
    typography: "{typography.label}"
  outline-link-current:
    textColor: "{colors.ink}"
  doc-bar:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    height: "44px"
  docs-panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    width: "320px"
    padding: "20px"
  pager-link:
    textColor: "{colors.ink}"
    typography: "{typography.title}"
  repo-row:
    textColor: "{colors.ink}"
    padding: "24px 0"
  search-submit:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    height: "48px"
    padding: "0 24px"
  search-submit-hover:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.paper}"
  result-row:
    textColor: "{colors.ink}"
    padding: "20px 0"
  type-badge:
    backgroundColor: "{colors.blue-wash}"
    textColor: "{colors.signal-blue-deep}"
    rounded: "9999px"
    padding: "2px 8px"
  code-block:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "16px 18px"
---

# Design System: DocMyRepos

## Overview

**Creative North Star: "The Swiss Reference Grid"**

DocMyRepos is a reference manual set in the International Typographic Style. Hierarchy does all the work: weight, scale and rules replace boxes, tinted fills and shadows, so nothing performs behind the text. It is built for newcomers and cross-team readers who must find the right document and always know where they stand. The familiar documentation arrangement is kept on purpose (header search, contents tree on the left, article in the middle, on-this-page outline on the right) and expressed in the Swiss grid.

One grotesque carries every word. Ink on white (near-black on near-black in dark) carries every surface. One blue appears only where it means something: the current location, links, focus and the primary hover. Everything is flush left. The system refuses the card-grid-with-soft-borders docs portal, and the build backs that up: repositories and results are ruled rows, not tiles.

Light and dark are both first-class. Dark is a near-black surface with lighter accents rather than an inversion, and every pairing is gated by contrast tests.

**Key Characteristics:**
- One typeface (Hanken Grotesk, 400 and 700) with tight negative tracking on large titles; monospace only for code and paths.
- Ink, paper and one blue. Grey carries secondary text and nothing else.
- Hairline rules and bold ink rules draw structure; no shadows at rest.
- Near-square corners (2px on code and keys).
- Document-first reading column near 60rem, with navigation as flanking columns.

## Colors

A monochrome ink-on-paper palette with a single electric blue; dark mode swaps to a lifted, lighter blue on near-black.

### Primary
- **Signal Blue** (`colors.signal-blue`, dark `colors.night-blue`): the only chromatic voice. Marks the current tree item (with bold), the 1px outline marker, links, the focus ring, the caret, task checkboxes, the primary hover of the search button, and the change-log dots. Links in dark use `colors.night-link`.
- **Signal Blue Deep** (`colors.signal-blue-deep`): link hover and text on blue washes.

### Secondary
- **Blue Wash** (`colors.blue-wash`, dark `colors.night-blue-wash`): background of type badges and search snippet highlights, always paired with Signal Blue Deep text (dark text `#c2d0ff`).
- **Blue Selection** (`colors.blue-selection`): light-mode text selection and `mark`; dark selection is full Signal Blue with white text.

### Neutral
- **Paper** (`colors.paper`, dark `colors.night`): page, header, cards and code-free surfaces.
- **Ink** (`colors.ink`, dark `colors.night-ink`): body text, titles, bold rules over panels, the selected theme icon.
- **Quiet Ink** (`colors.quiet-ink`, dark `colors.night-quiet-ink`): secondary text, inactive nav, metadata.
- **Hairline** (`colors.hairline`, dark `colors.night-hairline`): row dividers, header bottom rule, h2 top rules, tree nesting rule.
- **Control Edge** (`colors.control-edge`, dark `colors.night-control-edge`): form-control underlines, blockquote rule, scrollbar; chosen to hold 3:1 against the page.
- **Tint** (`colors.tint`, dark `colors.night-tint`): code blocks, inline code, hover fills, secondary chips.
- **Overlay Night** (`colors.night-overlay`): dark popover surface (command palette).
- **Private Grey** (`colors.private-grey`, dark `#232325`): private repository badge.

### Status
- **Alarm Red** (`colors.alarm-red`, dark `#f87171`) with Alarm Wash (`colors.alarm-wash`) and Alarm Edge (`colors.alarm-edge`): sync failure box and destructive actions only.
- **Notice Amber** (`colors.notice-amber-wash` with `colors.notice-amber-ink`; dark `#422006` with `#fde68a`): "waiting for first sync" and Mermaid notes. Success pair is `#dcfce7` / `#14532d` (dark `#052e16` / `#bbf7d0`).

### Named Rules
**The One Voice Rule.** Signal Blue means "you are here, or you can act here." It is never decoration, never a fill behind body copy, and never a second accent.

**The Contrast Gate Rule.** Raw colors live only in the `:root` and `.dark` blocks of `globals.css`, mirrored in `src/lib/theme-tokens.ts`. Every pairing used is listed in `CONTRAST_PAIRS` and fails the unit test below 4.5:1 (text) or 3:1 (UI). A new color enters both files and the pair list, or it does not ship.

## Typography

**Display Font:** Hanken Grotesk Variable (with ui-sans-serif, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial)
**Body Font:** Hanken Grotesk Variable
**Label/Mono Font:** ui-monospace, SFMono-Regular, Menlo, Consolas, for code and file paths only

**Character:** a neutral, slightly humanist grotesque. Big titles are packed tight and heavy; body is open and quiet. Contrast comes from size and weight, not from a second family.

### Hierarchy
- **Display** (700, 36px / 48px / 60px at base / sm / xl, line-height 1.05, tracking -0.035em): document and repository titles. The home hero is 48px / 60px at 1.02.
- **Headline** (700, 26px, 1.25, -0.02em): `h2` inside Markdown, each opened by a hairline top rule with 20px padding. Section heads on the home page are 24px bold, tracking-tight.
- **Title** (700, 20px, 1.25, -0.015em): Markdown `h3`, repo-row names (20px), pager targets (18px bold).
- **Body** (400, 18px, 1.7): rendered Markdown. Reading column caps at 60rem (about 100ch at 18px). Lead paragraph under the document title is 20px, Quiet Ink.
- **Label** (400-500, 14px; 12px for chips and tree controls): navigation, metadata, breadcrumbs. Active labels go bold, not larger.

### Named Rules
**The One Grotesque Rule.** One family, two weights in the system's own chrome (400 and 700). Hierarchy is made with size, weight, tracking and rules, never a second face.

**The Mono Is Code Rule.** Monospace appears only for code, inline code, source paths and result paths. Keyboard hints such as the palette shortcut use the sans.

## Layout

A Swiss grid expressed as flush-left columns inside a container capped at 88rem with 20px / 32px / 64px side padding (base / sm / lg). Margins are generous and everything aligns to the left edge. The two reading pages (document and repository) are the exception: from 1024px the header, page and footer drop the cap and span the full viewport width with the same side padding, so the rails sit at the viewport edges and the three stay aligned; the content column keeps its line length instead.

Document page and repository page (the repository header and the README are its content, the code owners follow it): at xl (1280px), three columns of 16rem tree (18rem from 2xl), fluid content track holding a content column of at most 60rem centred in it, 14rem outline (16rem from 2xl), with a 48px column gap; tree and outline stick at 96px from the top and scroll independently. At lg (1024px) two columns: the 15rem tree on the left and the article beside it, with the outline moved into a dropdown in the document bar. Below lg one column: the document fills the width, the tree is a slide-in panel and the outline is the same dropdown, both opened from the document bar. The DOM is document-first (article before navigation), so without scripts the outline and tree stay as plain lists after the article. Anchored headings keep a scroll offset equal to the sticky header, plus the document bar where there is one, plus 16px; the header and bar publish their measured heights (`--site-header-h`, `--doc-bar-h`) for this.

Header is 64px minimum, sticky, with a bottom hairline: wordmark left, Repositories / Search / Status links, then an underline-style search field and the theme toggle pushed right. On narrow screens the links wrap onto their own row.

Lists (repositories on the home page) run in two columns from md with a 48px gutter. Spacing rhythm is 4, 8, 16, 24, 32, 48px; vertical separation prefers rules plus 20-24px padding over gaps and boxes.

## Elevation & Depth

Flat. There are no shadows at rest and none on hover; the Mermaid theme sets `dropShadow: none`. Depth is conveyed by position (sticky header over a hairline), by rules, and by one Tint hover fill. Overlays (command palette, enlarged diagram) sit on the Overlay Night popover surface in dark and Paper in light, separated by their border. The only shadow-like device in the product is an inset 2px bottom line, used as a selected-state underline in the theme toggle.

### Named Rules
**The Flat Rule.** A surface is never lifted by shadow. If something must read as above, it is an overlay and it earns a border, not a blur.

## Shapes

Near-square. Code blocks, inline code and images are 2px to 4px (`rounded.sm`, `rounded.lg`). Structure is drawn by lines, not enclosures: panels open with a 1px Ink rule on top, list rows close with a 1px Hairline bottom rule, the tree nests behind a 1px hairline left rule, the outline sits on a hairline spine, the search field is an underline, and tables rule between rows with an Ink rule under the header. Chips and badges are the only fully rounded forms (9999px).

### Named Rules
**The Rule-Not-Box Rule.** Group content with a rule above or below it. Do not wrap it in a bordered, filled or shadowed container.

## Components

### Site Header
Sticky, Paper background, bottom Hairline, 64px. Wordmark in bold 18px tracking-tight; nav links 14px Quiet Ink, no underline, to Ink on hover.

### Search / Palette Trigger
An underline field, not a box: 36px tall, bottom border in Control Edge that turns Ink on hover, 224px wide at lg and 256px at xl, collapsing to icon-only below lg. The "Search" label is Quiet Ink and a small 2px-cornered keycap shows the shortcut. The search page uses the same idea at 48px with a bottom-border input that darkens on focus, and a solid Ink submit button whose hover turns Signal Blue.

### Theme Toggle
A three-option radio group (28px icon buttons). The selected option is Ink with a 2px inset underline; unselected options are Quiet Ink with a Tint hover. Rendered as an inert placeholder of the same size until mounted, so nothing shifts.

### Contents Tree
Left navigation. Folder names are bold 14px Ink and hover to Signal Blue; leaf links are Quiet Ink and go to Ink on hover. The current page is Signal Blue and bold. Nested levels indent 12px behind a Hairline rule; a chevron rotates 90 degrees when a folder opens. Expand/collapse-all controls are small underlined text buttons. Typed (OKF) pages carry a small Blue Wash badge only in OKF repos.

### On-this-page Outline
Right navigation on a Hairline spine. The active heading gets a 1px Signal Blue bar overlapping the spine, Ink semibold text; others are transparent-barred Quiet Ink, to Ink on hover. Nested headings indent 12px. Below xl the same list opens from a dropdown (see Document Bar).

### Document Bar
Below xl, a bar above the reading columns that sticks beneath the site header: 44px minimum, Paper background, bottom Hairline, flush left and right. Left, a hamburger button (16px three-line icon and "Documentation", 14px medium Ink, hover Signal Blue; shown below lg) that opens the docs panel. Right, an "On this page" button (14px medium, chevron that turns when open) that opens the headings dropdown: a 2px-cornered Paper popover with a Hairline border, the list inside it scrolling at 60vh, right-aligned to the bar and at most 22rem wide, directly under the bar's rule. Both buttons state their open state with `aria-expanded`. Until scripts have run the bar keeps its height but is invisible, so the document does not shift.

### Docs Panel
Below lg the contents tree and OKF filters are a panel from the left edge: 20rem or 85vw wide, Paper background with a 1px Hairline right rule, 20px padding, over a 45% black backdrop. It slides in over 200ms (instantly under reduced motion). A "Close" text button (underlined, 14px) is its first control; Esc, the backdrop and choosing a document also close it, filter chips keep it open. It is a modal dialog only while it is a panel: focus is contained, the page behind does not scroll, and focus returns to the hamburger. From lg it is the plain sticky left column.

### Breadcrumb and Pager
The breadcrumb sits in the content column above the title, not across the page. It is 14px Quiet Ink with Ink links, the current page medium weight. The pager is two ruled links with a top Hairline that turns Ink on hover; the label is Quiet Ink and the target is bold 18px, shifting to the link color on hover. Next aligns right.

### Repository Rows
Home and repo lists are ruled rows: a bold 20px name, metadata beneath, a Hairline bottom rule, 24px vertical padding; the whole row is one link via a stretched pseudo-element and the name turns Signal Blue on hover. The list is capped above by a 1px Ink rule.

### Search Results and Facets
Results are ruled rows (Hairline bottom, 20px padding) with a 18px semibold linked title, a metadata line, path in mono, and highlighted snippets on Blue Wash. Metadata chips: type on Blue Wash, status on Secondary with a border, tags outlined. The facet panel opens with an Ink top rule, lists options as 14px rows with counts, and uses a Tint hover fill.

### Markdown Body
18px / 1.7 prose; `h2` carries a Hairline top rule; links are underlined; blockquote is a 2px Control Edge left rule in Quiet Ink; inline code and code blocks sit on Tint at 2px radius, highlighted by Shiki dual themes (light and dark palettes selected by the `.dark` class, no re-render), with a top-right copy button. Heading anchors (`#`) appear only on hover or focus.

### Motion and State
Motion is minimal: the tree chevron rotates, the docs panel slides in (200ms, none under reduced motion), and color changes on hover; nothing animates on load or scroll. Focus is a 2px Signal Blue outline with 2px offset on every `:focus-visible` element, except text fields (inputs, selects, textareas), which show focus on their own edge: the border turns Ink and its bottom edge thickens to 2px. Hover is a color shift to Ink or Signal Blue, or a Tint fill on option rows. Selected is expressed by weight and blue (tree, outline) or an underline (theme toggle), never a filled chip.

## Do's and Don'ts

### Do:
- **Do** mark the current location with Signal Blue plus bold (tree) or the 1px blue bar (outline), and use blue for nothing else decorative.
- **Do** separate content with a 1px rule: Ink above panels and lists, Hairline below rows.
- **Do** build hierarchy from size, weight (400 or 700) and tracking (-0.035em on display titles).
- **Do** keep the document column near 60rem and put the article before the navigation in the DOM.
- **Do** give every navigation part one control when it cannot be a column: hamburger for the tree, dropdown for the outline.
- **Do** add any new color to both token blocks and to `CONTRAST_PAIRS`, and check light and dark.
- **Do** keep monospace for code and paths only.

### Don't:
- **Don't** wrap repositories, results or panels in bordered, tinted or shadowed cards.
- **Don't** add shadows outside overlays; depth comes from position and rules.
- **Don't** introduce a second accent hue or use blue as a fill behind body text.
- **Don't** round surfaces beyond 4px; only chips and badges are pill-shaped.
- **Don't** add a second typeface or a display face for headings.
- **Don't** color-only signal a link inside running text; text links are underlined.

## Not canonized (defects the build carries)

- Several surfaces use `rounded-md` (3px) boxes with tinted fills: the sync-failure and first-sync notices in the repo header and document page, and facet option rows. They work against the Rule-Not-Box Rule and are not a pattern to copy.
- Some elements use 500 and 600 weights (search result titles, outline current item, summary, chips). The variable font renders them, but the system voice is 400 and 700; prefer those for new surfaces.
- Active filter chips and badges are pill-shaped with Secondary fills; the system's silhouette is otherwise rules and near-square corners.
