# Proposal

## Why

Every DocMyRepos portal looks the same: a "DocMyRepos" wordmark, a fixed blue and a fixed tab title. An organization running its own portal wants it to read as its own: its logo and name in the top bar, its own tab title, and its brand colors. The DocMyRepos project itself should still be credited, and should still get the visibility that comes from being open source.

## What Changes

- A new admin page, **Branding** (`/admin/branding`), where admins set, for the whole portal:
  - a **logo**, shown in the top bar (PNG, JPEG, WebP or SVG, up to 512 KB), with a switch (on by default) to **invert it with CSS in the dark theme**, so a dark logo stays visible on dark surfaces without a second upload;
  - an **organization name**, shown next to the logo in the top bar;
  - a **page title**, used as the browser tab title and as the suffix of every page title ("Search · Acme Docs"); it falls back to the organization name, then to "DocMyRepos";
  - a **primary color** and an **accent color**;
  - whether the top bar is **colored** with the primary color.
- Colors are entered once (as `#rrggbb`) and the portal derives every readable variant for light and dark themes itself: text on the primary color, link and focus colors, the dark-theme shades and the accent text. A color that would be unreadable as text is darkened or lightened for text and focus use only, so admins cannot make the portal inaccessible. The admin page previews the result in both themes.
- The inversion is presentation only: the stored file and its public address are never altered. The same inversion applies on a colored top bar whose text is light, where a dark logo would otherwise disappear.
- Nothing set means nothing changes: the portal looks exactly as it does today. A **Reset to defaults** action clears everything.
- The logo, name, title and colors apply to every page, including the sign-in page. The logo is therefore served without a session.
- The **footer keeps DocMyRepos credited**: "Powered by DocMyRepos" linking to the project's GitHub repository, with a small **★ Star** call to action linking to the same repository. It cannot be removed from the admin page.
- Non-admins cannot change branding (403); everyone sees the result.
- Not changed: the repository, document and search content, the Mermaid and code themes, the favicon, separate light and dark logo files, per-user theming, and the light/dark/system theme toggle.

## Capabilities

### New Capabilities

- `org-branding`: admin-configurable logo, organization name, page title, primary and accent colors and colored top bar, and the DocMyRepos credit in the footer.

### Modified Capabilities

- None. Theming lives in the `docmyrepos-mvp` change spec (`theming`), which is not yet archived into `openspec/specs/`. This change adds a new capability that builds on its tokens and does not rewrite its requirements.

## Impact

- Data: new single-row `site_branding` table (settings and the logo bytes) and a Drizzle migration.
- Server: new `src/server/branding/` (read, validate, write) and admin handlers in `src/server/admin/`; new admin API under `/api/admin/branding`; new public `GET /api/branding/logo`; `src/proxy.ts` lets that one path through the session gate.
- Pure library: `src/lib/branding/` (color validation and derivation, CSS generation), shared by the server and the admin preview. Reuses `contrastRatio` from `src/lib/theme-tokens.ts` and the image-type checks in `src/server/assets/image-types.ts`.
- UI: `src/app/layout.tsx` (token overrides, title template), `src/components/site-header.tsx` and the header controls (logo, name, header colors), `src/components/site-footer.tsx` (attribution and star), a new `/admin/branding` page and form, a link to it from the admin pages. Page titles that hard-code "· DocMyRepos" switch to the shared template.
- Tests: unit tests for derivation (contrast sweep) and validation, API and authorization tests, header, footer and form component tests, and e2e plus axe in both themes with branding applied.
- Docs: README (admin guide) and `DESIGN.md` (header, footer, branding tokens).
- No new dependencies. No new environment variables.
