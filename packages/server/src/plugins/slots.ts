import type { SlotItems, SlotName } from "@docmyrepos/core";

import type { RequestContext } from "../app/types";
import { askStateFor } from "../ask/settings";
import { errorFields } from "../log";
import { mcpEnabled } from "../workspace";
import type { PluginRegistry } from "./registry";

/** The items of each slot as the server resolves them; UI nodes are opaque here. */
export type ResolvedItems = SlotItems<RequestContext, unknown>;

/** What the core's own items depend on: whether Ask and the AI agent pages are on. */
export interface CoreSlotState {
  readonly askEnabled: boolean;
  readonly agentAccess: boolean;
}

/** Nothing on: a signed-out visitor, or a request without a tenant. */
export const NO_FEATURES: CoreSlotState = { askEnabled: false, agentAccess: false };

/**
 * The core's items, the first contributions to each slot, in the order the pages always showed
 * them. Workspace tabs and banners have no core items here: the UI renders its own tabs first.
 */
export function coreSlotItems<S extends SlotName>(
  slot: S,
  state: CoreSlotState,
): readonly ResolvedItems[S][] {
  const items: { readonly [K in SlotName]: readonly ResolvedItems[K][] } = {
    "header.nav": [
      { href: "/", label: "Repositories" },
      ...(state.askEnabled ? [{ href: "/ask", label: "Ask" }] : []),
    ],
    "account.menu": [
      { href: "/admin/users", label: "Users", adminOnly: true },
      { href: "/admin/workspace", label: "Workspace configuration", adminOnly: true },
      { href: "/admin/branding", label: "Branding", adminOnly: true },
      ...(state.agentAccess
        ? [
            { href: "/admin/tokens", label: "AI agent tokens", adminOnly: true },
            { href: "/account/agent-access", label: "AI agent access" },
          ]
        : []),
    ],
    "admin.sections": [
      {
        href: "/admin/users",
        label: "Users",
        description: "Add users, change roles, disable access.",
      },
      {
        href: "/admin/workspace?tab=repos",
        label: "Repository access",
        description: "Allow or block repositories for all viewers.",
      },
      {
        href: "/admin/comments",
        label: "Comments",
        description: "Review, delete and permanently remove document comments.",
      },
      ...(state.agentAccess
        ? [
            {
              href: "/admin/tokens",
              label: "AI agent tokens",
              description: "See and revoke the tokens users created for AI agents.",
            },
          ]
        : []),
      {
        href: "/admin/workspace",
        label: "Workspace configuration",
        description: "The GitHub App, which repositories are shown, limits and sync.",
      },
      {
        href: "/admin/branding",
        label: "Branding",
        description: "Logo, organization name, page title and brand colors.",
      },
    ],
    "admin.workspace.tabs": [],
    "layout.banner": [],
    "footer.links": [{ href: "/status", label: "Sync status" }],
  };
  return items[slot];
}

/** The core state for a request: Ask and the agent pages, for a signed-in user only. */
export async function coreSlotState(ctx: RequestContext): Promise<CoreSlotState> {
  if ((await ctx.user()) === null) return NO_FEATURES;
  const [ask, agentAccess] = await Promise.all([
    askStateFor(ctx),
    mcpEnabled(ctx).catch(() => false),
  ]);
  return { askEnabled: ask.state === "ready", agentAccess };
}

/**
 * A slot's items for one request: the core's first, then each plugin's in plugin order. A
 * contribution that throws is left out and logged as `plugin.failed` with the plugin and slot.
 */
export async function resolveSlot<S extends SlotName>(
  registry: Pick<PluginRegistry, "plugins">,
  slot: S,
  ctx: RequestContext,
  state?: CoreSlotState,
): Promise<readonly ResolvedItems[S][]> {
  const core = coreSlotItems(slot, state ?? (await coreSlotState(ctx)));
  const contributed = await Promise.all(
    registry.plugins.map(async (plugin) => {
      const contribution = plugin.slots?.[slot];
      if (contribution === undefined) return [];
      try {
        const items = await contribution(ctx);
        if (items === null || items === undefined) return [];
        return (Array.isArray(items) ? items : [items]) as ResolvedItems[S][];
      } catch (error) {
        ctx.log.warn("plugin.failed", {
          plugin: plugin.id,
          slot,
          errorName: errorFields(error).errorName,
        });
        return [];
      }
    }),
  );
  return [...core, ...contributed.flat()];
}
