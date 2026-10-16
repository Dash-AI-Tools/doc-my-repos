import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildManifest,
  buildManifestFrom,
  isPublicHttpsAddress,
  parseManifestTemplate,
  WEBHOOK_PATH,
} from "./manifest.js";
import { MANIFEST_TEMPLATE_JSON } from "./manifest-template.generated.js";

const docs = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url)), "utf8");

const redirectUrl = "http://127.0.0.1:41234/callback";
const base = { organization: "acme", redirectUrl };

describe("buildManifest", () => {
  it("requests exactly contents: read and metadata: read, and is not public", () => {
    const manifest = buildManifest({ ...base, portalUrl: "https://docs.example.com" });
    expect(manifest.default_permissions).toEqual({ contents: "read", metadata: "read" });
    expect(manifest.public).toBe(false);
    expect(manifest.default_events).toEqual(["push", "repository"]);
    expect(manifest.redirect_url).toBe(redirectUrl);
  });

  it("is active with the right path for a public https address", () => {
    const manifest = buildManifest({ ...base, portalUrl: "https://docs.example.com" });
    expect(manifest.url).toBe("https://docs.example.com");
    expect(manifest.hook_attributes).toEqual({
      url: `https://docs.example.com${WEBHOOK_PATH}`,
      active: true,
    });
    expect(WEBHOOK_PATH).toBe("/api/webhooks/github");
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://localhost",
    "https://intranet",
    "https://10.1.2.3",
    "https://192.168.0.5",
    "https://172.20.0.1",
    "https://docs.local",
    "https://[::1]",
    "http://docs.example.com",
  ])("is inactive for %s", (portalUrl) => {
    expect(buildManifest({ ...base, portalUrl }).hook_attributes.active).toBe(false);
  });

  it("recognizes public https addresses", () => {
    expect(isPublicHttpsAddress("https://docs.example.com")).toBe(true);
    expect(isPublicHttpsAddress("https://8.8.8.8")).toBe(true);
    expect(isPublicHttpsAddress("not a url")).toBe(false);
  });

  it("keeps the App name within GitHub's limit", () => {
    const name = buildManifest({
      ...base,
      organization: "a".repeat(39),
      portalUrl: "http://localhost:3000",
    }).name;
    expect(name.length).toBeLessThanOrEqual(34);
  });

  it("refuses a template that asks for more than read access", () => {
    const tamper = (patch: Record<string, unknown>): string =>
      JSON.stringify({ ...JSON.parse(MANIFEST_TEMPLATE_JSON), ...patch });
    expect(() =>
      parseManifestTemplate(
        tamper({ default_permissions: { contents: "write", metadata: "read" } }),
      ),
    ).toThrow(/exactly/);
    expect(() =>
      parseManifestTemplate(
        tamper({ default_permissions: { contents: "read", metadata: "read", issues: "read" } }),
      ),
    ).toThrow(/exactly/);
    expect(() => parseManifestTemplate(tamper({ public: true }))).toThrow(/public/);
    const ok = parseManifestTemplate(MANIFEST_TEMPLATE_JSON);
    expect(buildManifestFrom(ok, { ...base, portalUrl: "http://localhost:3000" }).public).toBe(
      false,
    );
  });
});

describe("single source", () => {
  it("the bundled template equals docs/github-app-manifest.json (run `pnpm build` to refresh)", () => {
    expect(JSON.parse(MANIFEST_TEMPLATE_JSON)).toEqual(
      JSON.parse(docs("github-app-manifest.json")),
    );
    expect(MANIFEST_TEMPLATE_JSON).toBe(docs("github-app-manifest.json"));
  });

  it("the permission list matches the table in docs/github-app-setup.md", () => {
    const guide = docs("github-app-setup.md");
    const section = /## 2\. Permissions([\s\S]*?)\n## /.exec(guide)?.[1] ?? "";
    const rows = [...section.matchAll(/^\|\s*([A-Za-z ]+?)\s*\|\s*([A-Za-z-]+)\s*\|/gm)]
      .map((m) => [m[1]?.toLowerCase().trim() ?? "", m[2] ?? ""] as const)
      .filter(([name]) => name !== "permission");
    const fromGuide = Object.fromEntries(
      rows.map(([name, access]) => [
        name,
        access.toLowerCase().startsWith("read") ? "read" : access,
      ]),
    );
    expect(Object.keys(fromGuide).length).toBe(2);
    expect(
      buildManifest({ ...base, portalUrl: "http://localhost:3000" }).default_permissions,
    ).toEqual(fromGuide);
  });
});
