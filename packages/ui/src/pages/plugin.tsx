import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import type { App, RequestContext } from "@docmyrepos/server";
import { matchPluginPage } from "@docmyrepos/server/internal/plugins/dispatch";
import type { AppProps } from "../bind-page";
import { pageContext } from "../page-context";

/**
 * `/-/<plugin id>/<path>`: a plugin's page, rendered inside the site layout. An unknown plugin or
 * path is the not-found page. A page that is not public has the same gate as the core pages
 * (signed in, allowed to read content); a public page (`public/...`) only needs a tenant.
 */
interface PluginRouteProps {
  readonly params: Promise<{ readonly plugin: string; readonly path?: readonly string[] }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function find(app: App, params: PluginRouteProps["params"]) {
  const { plugin, path = [] } = await params;
  return matchPluginPage(app, plugin, path);
}

async function contextFor(app: App, isPublic: boolean): Promise<RequestContext> {
  if (!isPublic) return pageContext(app);
  const ctx = await app.pageContext();
  if (ctx === null) notFound();
  return ctx;
}

export async function generateMetadata({
  app,
  params,
}: AppProps & PluginRouteProps): Promise<Metadata> {
  const match = await find(app, params);
  return match === null ? {} : { title: match.page.title };
}

export async function PluginPage({ app, params, searchParams }: AppProps & PluginRouteProps) {
  const match = await find(app, params);
  if (match === null) notFound();
  const ctx = await contextFor(app, match.page.public === true);
  return (await match.page.render(ctx, {
    rest: match.rest,
    searchParams: await searchParams,
  })) as ReactNode;
}
