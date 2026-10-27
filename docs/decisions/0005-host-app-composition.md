---
type: Decision
title: Compose a host app from packages
description: An application that extends DocMyRepos is a Next.js host app that installs the published packages and passes its hooks, adapters and plugins to one application factory. Plugins are not loaded into a built server at runtime, and the core is never forked.
tags: [decisions, packages, extension]
status: accepted
sources:
  - openspec/changes/prepare-core-for-open-core-extensibility/design.md
  - pnpm-workspace.yaml
generated: 2026-10-27
verified: 2026-10-27
stale_after: 2999-01-01
---

# Compose a host app from packages

## Context

DocMyRepos is the open-source core of a product. A separate application (for example a hosted, multi-tenant edition) adds its own pages, permissions, metering and background work on top of it, and must do so through public APIs without patching the core. The core is a Next.js App Router application: routes, server components and client components are bundled when the app is built, and the proxy runs in the Edge runtime.

## Decision

The extending application is a **host app**: a Next.js app that depends on `@docmyrepos/core`, `@docmyrepos/server` and `@docmyrepos/ui`. It owns its own `app/` folder of thin files that bind the packages' pages and route handlers, and builds its application in one module with the application factory, passing its hooks, adapters and plugins. It adds any routes of its own the normal Next.js way.

The open-source app in this repository is the reference host app: the same thin files, with the defaults. The container image is built from it.

## Consequences

- Extensions are type-checked and bundled with the host app, under the same Content Security Policy as the core.
- A host app builds and ships its own container image; the core image stays the open-source one.
- The packages must keep a small, explicit public surface and share one version, because a host app depends on all three.

## Alternatives considered

- **Load plugins into the built server at runtime.** Next.js cannot add routes or React components to a built app, and code imported at runtime escapes type checking.
- **Put a separate service in front that forwards requests to the core.** It cannot change permission checks, add UI or see domain events without patching the core, and it doubles authentication.
- **Fork the core.** Every upstream fix would have to be merged by hand.
