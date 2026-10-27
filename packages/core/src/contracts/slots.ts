/**
 * Named places in the UI that plugins add to. Contributions are evaluated per request with the
 * request context and may return nothing. `Ctx` is the request context and `Node` a rendered UI
 * node; `@docmyrepos/server` and `@docmyrepos/ui` fix both.
 */
export const SLOT_NAMES = [
  "header.nav",
  "account.menu",
  "admin.sections",
  "admin.workspace.tabs",
  "layout.banner",
  "footer.links",
] as const;

export type SlotName = (typeof SLOT_NAMES)[number];

export interface LinkItem {
  readonly href: string;
  readonly label: string;
}

export interface AccountMenuItem extends LinkItem {
  /** Shown to administrators only. */
  readonly adminOnly?: boolean;
}

export interface AdminSectionItem extends LinkItem {
  readonly description: string;
}

export interface WorkspaceTabItem<Ctx, Node> {
  /** The `?tab=` value; a lowercase slug. */
  readonly id: string;
  readonly label: string;
  render(ctx: Ctx): Node | Promise<Node>;
}

export interface BannerItem<Ctx, Node> {
  render(ctx: Ctx): Node | Promise<Node>;
}

/** The item type of each slot. */
export interface SlotItems<Ctx, Node> {
  "header.nav": LinkItem;
  "account.menu": AccountMenuItem;
  "admin.sections": AdminSectionItem;
  "admin.workspace.tabs": WorkspaceTabItem<Ctx, Node>;
  "layout.banner": BannerItem<Ctx, Node>;
  "footer.links": LinkItem;
}

/**
 * A contribution to a slot: the items for one request, or nothing. Evaluated per request, so it
 * can depend on the user, the tenant or an entitlement.
 */
export type SlotContribution<S extends SlotName, Ctx, Node> = (
  ctx: Ctx,
) =>
  | SlotItems<Ctx, Node>[S]
  | readonly SlotItems<Ctx, Node>[S][]
  | null
  | Promise<SlotItems<Ctx, Node>[S] | readonly SlotItems<Ctx, Node>[S][] | null>;

export type SlotContributions<Ctx, Node> = {
  readonly [S in SlotName]?: SlotContribution<S, Ctx, Node>;
};
