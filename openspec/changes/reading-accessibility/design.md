# Design

## Context

See `proposal.md` for the motivation and `specs/read-mode/spec.md` and `specs/text-size/spec.md` for behaviour. Current state that shapes the approach:

- `src/app/layout.tsx` is already dynamic (it reads `headers()` for the CSP nonce and `getCurrentUser()`), renders `<html lang="en" suppressHydrationWarning>` and wraps everything in `ThemeProvider`. The login page renders inside the same layout, so the header shows there too.
- Sizing is almost entirely `rem`-based (Tailwind utilities and the prose rules in `src/app/globals.css`), so a change of the root font size scales it. Tailwind's breakpoints are `rem` media queries, which always use the browser's initial font size and do not follow the root's CSS `font-size`.
- The theme toggle uses `next-themes`, `localStorage` and a nonce'd blocking script. The CSP is `script-src 'self' 'nonce-…' 'strict-dynamic'`, `style-src 'self' 'unsafe-inline'`, `connect-src 'self'`.
- Keyboard handling already exists in `CommandPalette` (a window `keydown` listener for Ctrl/Cmd+K, `palette-store` with `openPalette`/`togglePalette`, a native modal dialog) and `DocNavPanel` (Esc and a focus trap while the small-screen panel is open).
- The document page (`src/app/[owner]/[repo]/docs/[...path]/page.tsx`) renders `DocReader` > `DocNavBar` + `ReaderGrid` (content wrapper capped at 60rem, outline column, `DocNavPanel`), with `DocBreadcrumb`, the `<article>` (title, description, a source/sync row, optional `OkfMetadataCard`, notices, body) and `DocPager`. `HeaderHeight` and `DocNavBar` publish `--site-header-h` and `--doc-bar-h`, which drive `scroll-padding-top`.
- `ThemeToggle` is the pattern for a control that renders a same-size placeholder until mounted. `starred-repos` plans a disclosure-style account menu in the header; the text size panel follows that pattern (a disclosure, not an ARIA menu).
- Other changes also edit these files (`responsive-docs-reader-layout` is in the working tree, `starred-repos` and `org-branding` are planned). Every task re-reads the file before editing.

## Goals / Non-Goals

**Goals:**
- Two reading aids that work on first paint, need no account, and cannot interfere with typing or browser shortcuts.
- A text scale that never breaks a layout, verified at 320 CSS px and at the widest column layouts.
- No change to the CSP, no new dependency, no database or API.

**Non-Goals:**
- Preferences that follow an account across devices (would need a per-user column and does not work on the sign-in page).
- A remappable shortcut (the on/off switch satisfies WCAG 2.1.4), extra reading controls (line height, width, fonts, high-contrast themes), text-to-speech.
- Read mode on pages other than documents (see Open Questions).

## Decisions

**1. Preferences live in two plain cookies read by the layout.** `docmyrepos-text-size` holds `small | large | larger | largest` (Default has no cookie) and `docmyrepos-read-key` holds `off` (on has no cookie). The root layout reads them with `cookies()` and renders `<html data-text-size="…">`; CSS keys on that attribute, so the very first byte of HTML is already at the right size, with no inline script and no hydration mismatch. Cookies are set from the client with `document.cookie` (not `HttpOnly`, because the page writes them), `Path=/`, `Max-Age` one year, `SameSite=Lax`, and `Secure` when the page is served over https. They are functional preferences, set only after the user acts. Alternatives: `localStorage` with a nonce'd blocking script like the theme (flash if the script is late, needs a mismatch suppressor for the attribute, no help to server rendering); a user column (needs an account, does not exist on the sign-in page, needs an API). Because the client changes the attribute directly and React does not re-apply an unchanged prop, a later server render with the updated cookie agrees with it.

**2. Text size is a percentage on `<html>`.** `html[data-text-size="large"] { font-size: 112.5% }` and so on (87.5, 100, 112.5, 125, 150), each also setting `--text-scale` (0.875 … 1.5). A percentage multiplies the browser's own default size, which is what WCAG 1.4.4 expects, and everything in `rem` follows. Alternatives: CSS `zoom` (non-standard, breaks measurement and media-query semantics), scaling only the document body (the user asked for the interface text size; the chrome would not follow), a Tailwind-wide token rewrite (large and invasive). Two things do not follow the root and are handled explicitly:
- *Media queries* stay on the initial font size, so at 150% the three-column layout would start at the same pixel width with columns 1.5× wider. The side tracks therefore use `calc(16rem / var(--text-scale, 1))` (and the 2xl/14rem/16rem/18rem values likewise), which keeps their pixel width constant while their text wraps; the content column keeps its `rem` cap. A check at each step proves the content column stays at least 20rem wide.
- *Fixed pixel sizes* (`px` font sizes, `h-9`-style heights that hold text) are audited in the CSS and the components; text that is in `px` is converted to `rem`. `--site-header-h` is measured, not assumed, so it follows.

**3. Read mode is state in a client provider, applied as an attribute on `<html>`.** `ReadModeProvider` (mounted in the root layout inside `ThemeProvider`) owns `on`, the shortcut preference and the live region. When it turns on it sets `data-read-mode="true"` on `document.documentElement` and CSS does the rest. Parts to hide carry `data-read-hide` and get `display: none` in read mode, which also removes them from the tab order and the accessibility tree. This is why the page can stay a server component: nothing conditionally renders, so no markup is rebuilt and no state in the tree (open folders, the OKF filters) is lost. Marked: the site header, the footer, `DocNavBar`, the outline column, `DocNavPanel`, `DocBreadcrumb`, the source/sync row and the OKF metadata card. The grid collapses to one column (`.reader-grid`/`.reader-content` hooks added to `ReaderGrid`) with the content capped near 70 characters (about 44rem) and centered, the body text at 1.125rem with line height about 1.75, and a little extra top padding so the floating bar never covers the first line.

**4. Availability is a registry, not a route check.** The document page renders `<ReadModeTarget />`, a client component that registers itself in a small external store (`useSyncExternalStore`, the pattern `palette-store` uses) on mount and unregisters on unmount. The provider derives `available` from it. So: the header button appears only when registered (and only after hydration, which gives the "no button without script" behavior for free); navigating between documents keeps the provider state (the layout stays mounted); reaching a page without a target flips `available` to false, which turns read mode off. Another page type opts in later by rendering the same marker. Alternative: matching the pathname (fragile, duplicates routing knowledge).

**5. The R key handler is one pure function and one listener.** `isReadShortcut(event, context)` in `src/lib/reading-prefs.ts` returns true only when: `event.key` is `r` or `R`, Ctrl/Meta/Alt are not held (Shift is allowed, so Caps Lock works), `isComposing` and `repeat` are false, the shortcut is enabled and read mode is available, the event target is not an `input`, `textarea`, `select`, `[contenteditable]` or `[role="textbox"|"combobox"|"searchbox"]`, and no overlay is open (palette open per `palette-store`, `dialog[open]`, `[aria-modal="true"]`, or the text size panel open). The listener sits on `window` in the provider, calls `preventDefault` only when it acts, and toggles once per press. Escape exits read mode only when nothing else handled it first (`defaultPrevented`) and no overlay is open; the text size panel handles and stops its own Escape. The shortcut is by character (`event.key`), so it works on layouts where R is a Latin letter and is simply absent otherwise; the button always works. `aria-keyshortcuts="R"` is on the button only while the shortcut is enabled. Alternative: a hotkey library (a dependency for fifteen lines).

**6. Focus, announcements and place.** On turning on, the article is made programmatically focusable (`tabIndex={-1}` on the document `<article>`) and focused with `preventScroll`, so a screen reader continues from the title; a visible focus style is not shown for programmatic focus. On turning off, focus goes to the header button (waited for one frame because it was `display: none`). A visually hidden `role="status"` region in the provider gets the message ("Read mode on. Press R or Escape to exit." with the shortcut clause only when enabled, and "Read mode off."). To keep the reader's place, the toggle handler measures the first heading or block in the article that intersects the viewport, sets the attribute synchronously, measures the same element again, and `scrollBy`s the difference with `behavior: "instant"`, all in the same task, before paint. Alternative: restoring by hash anchor (changes the URL).

**7. The floating bar.** While on, the provider renders a fixed, top-right group labelled "Reading controls" holding an "Exit read mode" button (icon plus text from `sm`, icon only below, always with the name) and a second `TextSizeMenu`, so a reader can change the size without leaving. It uses the page background, border and ring tokens (and the header tokens if `org-branding` is present), sits below the search palette in z-order, respects `env(safe-area-inset-*)`, and the one `TextSizeMenu` implementation serves both places.

**8. `TextSizeMenu` is a disclosure with native inputs.** A button ("Aa", `aria-expanded`, `aria-controls`, named "Text size and reading options") toggles a panel containing a group "Text size" of five native radio inputs (arrow keys, grouping and screen-reader semantics are free) and a native checkbox "Press R for read mode". Selecting a radio applies the size at once (sets the `<html>` attribute, writes or clears the cookie, updates local state). The panel closes on Escape (focus back to the button), on pointer-down outside and on focus leaving it; it does not trap focus. The current size is read from `document.documentElement.dataset.textSize` through `useSyncExternalStore`, so both instances agree and the first client render matches the server. Until mounted it renders the same-size placeholder (like `ThemeToggle`), so nothing shifts.

**9. Header order puts the conditional control first.** The right-hand cluster becomes `[ReadModeToggle] [TextSizeMenu] [PaletteTrigger] [ThemeToggle] [user controls]`. The cluster is right-aligned, so a button appearing or disappearing at its left edge moves nothing else when the reader navigates between a document and other pages. Icons are inline SVG (book-open, "Aa" glyph), 16px like the theme icons, with 24px-or-larger hit areas.

**10. Library.** `src/lib/reading-prefs.ts` holds the size table (`id`, label, percent, scale), cookie names, `parseTextSize`, `parseReadKey`, `serializePreference(name, value | null, { secure })` and `isReadShortcut`. No React, no server imports, unit-tested directly.

## Risks / Trade-offs

- [Layouts break at 150%] → Constant-pixel side tracks (decision 2), header already wraps, and a verification matrix: each size at 320, 768, 1024, 1280 and 1920 px widths with no horizontal scroll and a minimum content width, in e2e and with screenshots.
- [Missed `px` sizes ignore the scale] → An audit task greps for `px` font sizes and heights holding text and converts them; an e2e check compares a computed font size on a sample of elements across steps.
- [Single-key shortcut conflicts with assistive technology or typing] → The eligibility rules in decision 5, the on/off switch (WCAG 2.1.4), and unit tests for each exclusion. Screen-reader users also have the button.
- [Hiding with `display: none` hides things a reader still wants, such as the source link] → Intentional for the mode; Exit is always visible. The previous/next links stay.
- [A cookie notice might be expected] → The cookies are user-requested functional preferences with no identifier, set only after a choice; the README says so. A deployment's own policy decides if a notice is needed.
- [Header crowding on a phone with the account menu, org name and logo] → The header wraps; an e2e check at 320 px confirms every control is reachable and nothing overlaps.
- [The floating bar covers content] → Extra top padding in read mode, and the bar is small; at 320 px the controls are icon only.
- [Scroll-position adjustment misfires on very long reflows] → Measured against a stable anchor in the same task; falls back to doing nothing if no anchor is found.

## Migration Plan

No data, no environment variables. Rolling out adds two controls and CSS; with no cookies set everything looks as before. Rolling back is removing the components; stray cookies are harmless and ignored.

## Open Questions

- Whether the repository page (its README-like overview) should also register as readable later. It does not change the specs (a page opts in by rendering the marker) or the task breakdown.
