import {
  WORKSPACE,
  defaultAuthorize,
  type Action,
  type DomainEventInput,
  type Resource,
  type User,
} from "@docmyrepos/core";

import type { RequestContext } from "../app/types";
import type { Db } from "../db/client";
import { getCurrentUser } from "./current-user";

/**
 * Who is asking and what they may do: the one way handlers make permission checks. Routes build
 * it from the request context (`contextAccess`), so the `authenticate` and `authorize` hooks
 * decide; code called without a context (tests, the built-in tenant's server components that
 * have not been given one) gets `legacyAccess`, the open-source rules over the session cookie.
 */
export interface Access {
  /** The signed-in user, or a 401 error (`status: 401`). */
  user(): Promise<User>;
  /** The signed-in user if they may administer the workspace; otherwise a 401 or 403 error. */
  admin(): Promise<User>;
  /** Whether the signed-in user may take `action` on `resource`; false when signed out. */
  can(action: Action, resource?: Resource): Promise<boolean>;
  /**
   * Records a domain event of what the signed-in user did, for `onEvent`, stamped with their id
   * unless the event names its actor. Never waits and never throws. No-op without a context.
   */
  emit(event: DomainEventInput): void;
}

function denied(status: 401 | 403): Error & { status: 401 | 403 } {
  return Object.assign(new Error(status === 401 ? "unauthorized" : "forbidden"), { status });
}

function accessOf(
  currentUser: () => Promise<User | null>,
  can: (user: User | null, action: Action, resource: Resource) => Promise<boolean>,
  emit: (event: DomainEventInput) => void = () => undefined,
): Access {
  const user = async () => {
    const found = await currentUser();
    if (found === null) throw denied(401);
    return found;
  };
  return {
    user,
    admin: async () => {
      const found = await user();
      if (!(await can(found, "admin.manage", WORKSPACE))) throw denied(403);
      return found;
    },
    can: async (action, resource = WORKSPACE) => can(await currentUser(), action, resource),
    emit,
  };
}

/** Access decided by the request context: its `authenticate` and `authorize` hooks. */
export function contextAccess(ctx: Pick<RequestContext, "user" | "can" | "emit">): Access {
  return accessOf(
    () => ctx.user(),
    async (user, action, resource) => user !== null && ctx.can(action, resource),
    (event) => {
      if (event.actorId !== undefined) return ctx.emit(event);
      void ctx
        .user()
        .catch(() => null)
        .then((user) => ctx.emit({ ...event, actorId: user?.id ?? null }));
    },
  );
}

/**
 * The open-source rules over the built-in tenant's session cookie, for code called without a
 * request context. `user` replaces the session lookup (tests).
 */
export function legacyAccess(db: Db, user?: () => Promise<User | null>): Access {
  return accessOf(user ?? (() => getCurrentUser(db)), async (found, action, resource) =>
    defaultAuthorize(found, action, resource),
  );
}
