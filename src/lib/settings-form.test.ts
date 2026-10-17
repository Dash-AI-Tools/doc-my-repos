import { describe, expect, it } from "vitest";

import { configSchema } from "@/server/config/schema";

import {
  buildSettings,
  formatRepoLines,
  formFromSettings,
  parseRepoLines,
  type SettingsFormState,
} from "./settings-form";

const base = configSchema.parse({});
const blank = (over: Partial<SettingsFormState> = {}): SettingsFormState => ({
  ...formFromSettings(base),
  ...over,
});

describe("repository lines", () => {
  it("round-trips names, docs paths and API specs", () => {
    const text =
      "api-service\nweb-app docsPath=user-guide\npayments apiSpecs=api/v2/spec.yaml,openapi.json";
    const parsed = parseRepoLines(text);
    expect(parsed).toEqual({
      ok: true,
      entries: [
        "api-service",
        { name: "web-app", docsPath: "user-guide" },
        { name: "payments", apiSpecs: ["api/v2/spec.yaml", "openapi.json"] },
      ],
    });
    if (parsed.ok) expect(formatRepoLines(parsed.entries)).toBe(text);
  });

  it("ignores blank lines and surrounding spaces, and reports unknown options by line", () => {
    expect(parseRepoLines("\n  a  \n\n b \n")).toEqual({ ok: true, entries: ["a", "b"] });
    const bad = parseRepoLines("a\nb color=red\nc docsPath");
    expect(bad).toEqual({
      ok: false,
      errors: [
        'Line 2: "color" is not understood. Use docsPath=… or apiSpecs=….',
        'Line 3: "docsPath" is not understood. Use docsPath=… or apiSpecs=….',
      ],
    });
  });

  it("refuses options when only names are allowed", () => {
    expect(parseRepoLines("a docsPath=x", false)).toEqual({
      ok: false,
      errors: ["Line 1: only a repository name is allowed here."],
    });
  });
});

describe("formFromSettings / buildSettings", () => {
  it("defaults round-trip into a settings object the schema accepts unchanged", () => {
    const built = buildSettings(blank(), base);
    expect(built.ok).toBe(true);
    if (built.ok) expect(configSchema.parse(built.settings)).toEqual(base);
  });

  it("reads every mode back out of the settings", () => {
    const only = configSchema.parse({ repos: ["a", { name: "b", docsPath: "guide" }] });
    expect(formFromSettings(only)).toMatchObject({
      mode: "only",
      repoLines: "a\nb docsPath=guide",
    });
    const except = configSchema.parse({ exclude: ["x", "y"] });
    expect(formFromSettings(except)).toMatchObject({ mode: "except", repoLines: "x\ny" });
    expect(formFromSettings(base)).toMatchObject({ mode: "all", repoLines: "" });
  });

  it("builds repos or exclude from the chosen mode, never both", () => {
    const only = buildSettings(blank({ mode: "only", repoLines: "a\nb docsPath=guide" }), base);
    expect(only.ok && only.settings).toMatchObject({
      repos: ["a", { name: "b", docsPath: "guide" }],
    });
    expect(only.ok && "exclude" in only.settings).toBe(false);
    const except = buildSettings(blank({ mode: "except", repoLines: "x" }), base);
    expect(except.ok && except.settings).toMatchObject({ exclude: ["x"] });
    expect(except.ok && "repos" in except.settings).toBe(false);
  });

  it("asks for at least one repository when a list mode is empty", () => {
    expect(buildSettings(blank({ mode: "only", repoLines: " \n" }), base)).toEqual({
      ok: false,
      errors: ["List at least one repository, or choose all repositories."],
    });
    expect(buildSettings(blank({ mode: "except", repoLines: "" }), base).ok).toBe(false);
  });

  it("names numeric fields that are not whole numbers, and leaves blanks to the defaults", () => {
    const bad = buildSettings(
      blank({ appId: "abc", maxFileBytes: "1.5", questionsPerDay: "x" }),
      base,
    );
    expect(bad).toEqual({
      ok: false,
      errors: [
        "App ID must be a whole number.",
        "Largest document must be a whole number.",
        "Questions per day must be a whole number.",
      ],
    });
    const blanks = buildSettings(blank({ maxFileBytes: "", intervalMinutes: " " }), base);
    expect(blanks.ok && configSchema.parse(blanks.settings).limits.maxFileBytes).toBe(262144);
  });

  it("keeps the provider endpoint it was loaded with", () => {
    const withUrl = configSchema.parse({
      providers: { openaiBaseUrl: "https://m.example.com/v1" },
    });
    const built = buildSettings(formFromSettings(withUrl), withUrl);
    expect(built.ok && built.settings.providers).toEqual({
      openaiBaseUrl: "https://m.example.com/v1",
    });
  });

  it("loads the MCP switch from the settings and sends it back", () => {
    const off = configSchema.parse({ mcp: { enabled: false } });
    expect(formFromSettings(off).mcpEnabled).toBe(false);
    expect(formFromSettings(configSchema.parse({})).mcpEnabled).toBe(true);
    const built = buildSettings(blank({ mcpEnabled: false }), base);
    expect(built.ok && configSchema.parse(built.settings).mcp).toEqual({ enabled: false });
    const on = buildSettings(blank({ mcpEnabled: true }), base);
    expect(on.ok && configSchema.parse(on.settings).mcp).toEqual({ enabled: true });
  });

  it("carries the App identifiers and toggles", () => {
    const built = buildSettings(
      blank({ appId: "12", installationId: "34", onStartup: false, commentsEnabled: false }),
      base,
    );
    expect(built.ok && configSchema.parse(built.settings)).toMatchObject({
      github: { appId: 12, installationId: 34 },
      sync: { onStartup: false },
      comments: { enabled: false },
    });
  });
});
