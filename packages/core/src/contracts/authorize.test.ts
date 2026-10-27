import { describe, expect, it } from "vitest";

import { ACTIONS, type Action, type Resource } from "./authorization";
import { defaultAuthorize } from "./authorize";
import type { User } from "./user";

/**
 * The open-source permission rules, as they were inline before the `authorize` hook existed
 * (access-control "Roles", document-comments "Who may read and write", "Edit and delete your
 * own comments", "Resolve threads", comment-moderation, agent-tokens).
 */
const ADMIN: User = { id: 1, email: "admin@example.com", role: "admin" };
const AUTHOR: User = { id: 2, email: "author@example.com", role: "user" };
const OTHER: User = { id: 3, email: "other@example.com", role: "user" };

const WORKSPACE: Resource = { kind: "workspace" };
const DOCUMENT: Resource = { kind: "document", githubRepoId: 7, path: "docs/a.md" };
const OWN_COMMENT: Resource = { kind: "comment", authorId: AUTHOR.id, asOrganization: false };
const ORG_COMMENT: Resource = { kind: "comment", authorId: AUTHOR.id, asOrganization: true };
const AUTHORS_TOKEN: Resource = { kind: "token", ownerId: AUTHOR.id };

type Row = readonly [Action, Resource, admin: boolean, author: boolean, other: boolean];

const TABLE: readonly Row[] = [
  ["admin.manage", WORKSPACE, true, false, false],
  ["content.read", WORKSPACE, true, true, true],
  ["ask.use", WORKSPACE, true, true, true],
  ["comment.create", DOCUMENT, true, true, true],
  ["comment.create_as_organization", DOCUMENT, true, false, false],
  ["comment.edit", OWN_COMMENT, false, true, false],
  ["comment.edit", ORG_COMMENT, true, false, false],
  ["comment.delete", OWN_COMMENT, false, true, false],
  ["comment.delete", ORG_COMMENT, true, false, false],
  ["comment.resolve", OWN_COMMENT, true, true, false],
  ["comment.resolve", ORG_COMMENT, true, true, false],
  ["comment.moderate", OWN_COMMENT, true, false, false],
  ["comment.view_author_email", WORKSPACE, true, false, false],
  ["token.manage_own", AUTHORS_TOKEN, false, true, false],
  ["token.manage_any", AUTHORS_TOKEN, true, false, false],
];

describe("defaultAuthorize", () => {
  it("covers every action", () => {
    expect(new Set(TABLE.map(([action]) => action))).toEqual(new Set(ACTIONS));
  });

  for (const [action, resource, admin, author, other] of TABLE) {
    const what = `${action} on ${resource.kind}${"asOrganization" in resource && resource.asOrganization ? " (organization)" : ""}`;
    it(`${what}: admin ${admin}, author ${author}, other user ${other}`, () => {
      expect(defaultAuthorize(ADMIN, action, resource)).toBe(admin);
      expect(defaultAuthorize(AUTHOR, action, resource)).toBe(author);
      expect(defaultAuthorize(OTHER, action, resource)).toBe(other);
    });
  }

  it("lets a signed-out visitor do nothing", () => {
    for (const [action, resource] of TABLE) {
      expect(defaultAuthorize(null, action, resource), action).toBe(false);
    }
  });

  it("refuses resource-bound actions on the wrong kind of resource", () => {
    expect(defaultAuthorize(ADMIN, "comment.edit", WORKSPACE)).toBe(false);
    expect(defaultAuthorize(AUTHOR, "comment.resolve", DOCUMENT)).toBe(false);
    expect(defaultAuthorize(AUTHOR, "token.manage_own", WORKSPACE)).toBe(false);
  });
});
