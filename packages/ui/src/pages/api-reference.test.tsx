import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiReferenceData } from "@docmyrepos/server/internal/api-reference-page";
import type { ApiSpecDetail, RepoDetail } from "@docmyrepos/server/internal/queries/index";

const loadApiReference =
  vi.fn<(owner: string, name: string, segments: readonly string[]) => Promise<ApiReferenceData>>();
vi.mock("@docmyrepos/server/internal/api-reference-page", () => ({
  loadApiReference: (owner: string, name: string, segments: readonly string[]) =>
    loadApiReference(owner, name, segments),
}));
vi.mock("../components/api-reference", () => ({
  ApiReference: ({ spec, sourceUrl }: { spec: { marker?: string }; sourceUrl: string | null }) => (
    <div data-testid="widget" data-source={sourceUrl ?? ""}>
      {spec.marker}
    </div>
  ),
}));

import { ApiReferencePage, generateMetadata } from "./api-reference";
import { testApp } from "./test-app";

const TEST_APP = testApp();

const NOW = new Date("2026-10-10T12:00:00Z");
const SOURCE = "https://github.com/acme/api/blob/main/api/openapi.yaml";

const repo = {
  id: 1,
  owner: "acme",
  name: "api",
  htmlUrl: "https://github.com/acme/api",
  defaultBranch: "main",
} as unknown as RepoDetail;

function ok(
  over: Partial<Extract<ApiReferenceData, { status: "ok" }>> = {},
  spec: Partial<ApiSpecDetail> = {},
): ApiReferenceData {
  return {
    status: "ok",
    repo,
    spec: {
      id: 1,
      repoId: 1,
      path: "api/openapi.yaml",
      format: "openapi",
      specVersion: "3.1.0",
      title: "Pets API",
      apiVersion: "1.2.0",
      operationCount: 1,
      sizeBytes: 1,
      blobSha: "x",
      updatedAt: NOW,
      spec: { marker: "SPEC-OBJECT" },
      ...spec,
    },
    sourceUrl: SOURCE,
    url: "/acme/api/api-reference/api/openapi.yaml",
    loadedAt: NOW,
    ...over,
  };
}

async function html(path = ["api", "openapi.yaml"]): Promise<string> {
  return renderToStaticMarkup(
    await ApiReferencePage({
      app: TEST_APP,
      params: Promise.resolve({ owner: "acme", repo: "api", path }),
    }),
  );
}

beforeEach(() => loadApiReference.mockReset());

describe("API reference page", () => {
  it("renders the header, the widget with the spec and the source link", async () => {
    loadApiReference.mockResolvedValue(ok());
    const out = await html();
    expect(out).toMatch(/<h1[^>]*>Pets API<\/h1>/);
    expect(out).toContain("Version 1.2.0");
    expect(out).toContain("OpenAPI 3.1");
    expect(out).toContain('href="/acme/api"');
    expect(out).toContain(`href="${SOURCE}"`);
    expect(out).toContain("View source on GitHub");
    expect(out).toContain("SPEC-OBJECT");
    expect(out).toContain(`data-source="${SOURCE}"`);
    expect(loadApiReference).toHaveBeenCalledWith("acme", "api", ["api", "openapi.yaml"]);
  });

  it("labels Swagger 2.0 as text", async () => {
    loadApiReference.mockResolvedValue(ok({}, { format: "swagger", specVersion: "2.0" }));
    expect(await html()).toContain("Swagger 2.0");
  });

  it("omits the version and the links gracefully", async () => {
    loadApiReference.mockResolvedValue(ok({ sourceUrl: null }, { apiVersion: null }));
    const out = await html();
    expect(out).not.toContain("Version ");
    expect(out).not.toContain("View source on GitHub");
    expect(out).toContain("The API reference needs JavaScript to display.");
  });

  it("has a noscript notice with the source link", async () => {
    loadApiReference.mockResolvedValue(ok());
    const out = await html();
    const notice = out.match(/<noscript>(.*?)<\/noscript>/s)?.[1] ?? "";
    expect(notice).toContain("needs JavaScript");
    expect(notice).toContain(`href="${SOURCE}"`);
  });

  it("calls notFound (404) for an unknown or blocked spec", async () => {
    loadApiReference.mockResolvedValue({ status: "not_found" });
    await expect(html(["nope.yaml"])).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
  });

  it("answers 404 for a malformed escape without loading", async () => {
    await expect(html(["%E0%A4%A"])).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
    expect(loadApiReference).not.toHaveBeenCalled();
  });

  it("redirects to the canonical address", async () => {
    loadApiReference.mockResolvedValue({
      status: "redirect",
      to: "/acme/api/api-reference/a.yaml",
    });
    await expect(html(["A.yaml"])).rejects.toMatchObject({
      digest: expect.stringContaining("/acme/api/api-reference/a.yaml"),
    });
  });

  it("renders the in-page error state", async () => {
    loadApiReference.mockResolvedValue({ status: "error", loadedAt: NOW });
    const out = await html();
    expect(out).toContain("This repository could not be loaded");
    expect(out).toContain('href="/acme/api/api-reference/api/openapi.yaml"');
  });
});

describe("generateMetadata", () => {
  const meta = () =>
    generateMetadata({
      app: TEST_APP,
      params: Promise.resolve({ owner: "acme", repo: "api", path: ["api", "openapi.yaml"] }),
    });

  it("titles an ok page and sets the canonical URL", async () => {
    loadApiReference.mockResolvedValue(ok());
    expect(await meta()).toEqual({
      title: { absolute: "Pets API · API reference · acme/api" },
      alternates: { canonical: "/acme/api/api-reference/api/openapi.yaml" },
    });
  });

  it("titles not found and leaves the rest alone", async () => {
    loadApiReference.mockResolvedValue({ status: "not_found" });
    expect(await meta()).toEqual({ title: "API reference not found" });
    loadApiReference.mockResolvedValue({ status: "error", loadedAt: NOW });
    expect(await meta()).toEqual({});
  });
});
