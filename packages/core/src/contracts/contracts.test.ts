import { describe, expect, it } from "vitest";

import {
  ACTIONS,
  DEFAULT_TENANT,
  EVENT_NAMES,
  EXTENSION_API_VERSION,
  PluginDefinitionError,
  definePlugin,
  isAction,
  isDefaultTenant,
  isTenantId,
  pluginProblems,
  type PluginDefinition,
} from "../index";

const ok = { id: "metering", apiVersion: EXTENSION_API_VERSION } as const;
const handler = async () => new Response("ok");

describe("DEFAULT_TENANT", () => {
  it("is the frozen built-in tenant with the id `default`", () => {
    expect(DEFAULT_TENANT).toEqual({ id: "default", attributes: {} });
    expect(Object.isFrozen(DEFAULT_TENANT)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TENANT.attributes)).toBe(true);
    expect(isDefaultTenant(DEFAULT_TENANT)).toBe(true);
    expect(isDefaultTenant({ id: "acme" })).toBe(false);
  });
});

describe("isTenantId", () => {
  it("accepts lowercase slugs up to 63 characters", () => {
    expect(isTenantId("default")).toBe(true);
    expect(isTenantId("acme-2")).toBe(true);
    expect(isTenantId("a".repeat(63))).toBe(true);
  });

  it("refuses anything else", () => {
    for (const value of ["", "Acme", "-acme", "acme_1", "a".repeat(64), "a b", 7, null]) {
      expect(isTenantId(value), String(value)).toBe(false);
    }
  });
});

describe("the catalogues", () => {
  it("lists each action and event once", () => {
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
    expect(isAction("admin.manage")).toBe(true);
    expect(isAction("admin.everything")).toBe(false);
  });
});

describe("definePlugin", () => {
  it("returns a valid plugin unchanged", () => {
    const plugin = definePlugin({
      ...ok,
      routes: [
        { method: "GET", path: "usage", handler },
        { method: "GET", path: "public/pricing", public: true, handler },
      ],
      pages: [{ path: "plan", title: "Plan", render: () => null }],
      jobs: [{ name: "metering.report", handler: async () => {} }],
      schedules: [{ job: "metering.report", everyMs: 3_600_000 }],
    });
    expect(plugin.id).toBe("metering");
  });

  it("refuses an id that is not a lowercase slug", () => {
    for (const id of ["", "Metering", "1meter", "me_ter", "a".repeat(41)]) {
      expect(() => definePlugin({ ...ok, id }), id).toThrow(PluginDefinitionError);
    }
  });

  it("refuses another extension API version and names both", () => {
    expect(() => definePlugin({ ...ok, apiVersion: 2 })).toThrow(
      'plugin "metering" targets extension API 2; this core supports 1',
    );
  });

  it("refuses job names outside the plugin's namespace", () => {
    for (const name of ["sync.full", "metering", "metering.", "other.report"]) {
      expect(pluginProblems({ ...ok, jobs: [{ name, handler: async () => {} }] }), name).toEqual([
        `job "${name}" must be named "metering.<name>"`,
      ]);
    }
  });

  it("ties `public/` paths to public routes and pages", () => {
    const plugin: PluginDefinition<unknown, unknown> = {
      ...ok,
      routes: [
        { method: "GET", path: "pricing", public: true, handler },
        { method: "GET", path: "public/invoices", handler },
      ],
      pages: [{ path: "public/plan", title: "Plan", render: () => null }],
    };
    expect(pluginProblems(plugin)).toEqual([
      'route "pricing": a public path starts with "public/"',
      'route "public/invoices": only a public route may use the "public/" prefix',
      'page "public/plan": only a public page may use the "public/" prefix',
    ]);
  });

  it("refuses malformed paths, duplicates and bad schedules", () => {
    const plugin: PluginDefinition<unknown, unknown> = {
      ...ok,
      routes: [
        { method: "GET", path: "/usage", handler },
        { method: "POST", path: "usage", handler },
        { method: "POST", path: "usage", handler },
      ],
      schedules: [
        { job: "metering.missing", everyMs: 60_000 },
        { job: "metering.missing", everyMs: 1000 },
      ],
    };
    expect(pluginProblems(plugin)).toEqual([
      'route "/usage": a path is lowercase segments separated by "/"',
      'route "POST usage" is registered twice',
      'schedule for "metering.missing" names no job of this plugin',
      'schedule for "metering.missing" names no job of this plugin',
      'schedule for "metering.missing" must run at most once a minute',
    ]);
  });
});
