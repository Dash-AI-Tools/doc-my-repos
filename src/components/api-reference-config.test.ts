import { describe, expect, it } from "vitest";

import {
  API_REFERENCE_OPTIONS,
  REQUEST_BLOCKED_MESSAGE,
  apiReferenceProps,
  blockAllRequests,
} from "./api-reference-config";

describe("API reference widget options (design decision 6)", () => {
  it("are exactly the locked-down set", () => {
    const { requestInterceptor, ...rest } = API_REFERENCE_OPTIONS;
    expect(rest).toEqual({
      supportedSubmitMethods: [],
      tryItOutEnabled: false,
      queryConfigEnabled: false,
      deepLinking: true,
      docExpansion: "list",
      defaultModelsExpandDepth: 1,
      persistAuthorization: false,
    });
    expect(requestInterceptor).toBe(blockAllRequests);
  });

  it("never include url, urls, configUrl or an OAuth redirect", () => {
    const props = apiReferenceProps({ openapi: "3.1.0" }) as Record<string, unknown>;
    for (const key of ["url", "urls", "configUrl", "oauth2RedirectUrl", "responseInterceptor"]) {
      expect(key in props, key).toBe(false);
    }
  });

  it("pass the spec as data, by reference", () => {
    const spec = { openapi: "3.0.3" };
    expect(apiReferenceProps(spec).spec).toBe(spec);
  });

  it("are frozen", () => {
    expect(Object.isFrozen(API_REFERENCE_OPTIONS)).toBe(true);
  });
});

describe("request interceptor", () => {
  it("rejects every request, whatever it is", async () => {
    for (const req of [
      { url: "https://evil.example/x.json" },
      { url: "/api/status", credentials: "include" },
      { url: "./other.yaml#/components/schemas/A" },
      {},
    ]) {
      await expect(blockAllRequests(req)).rejects.toThrow(REQUEST_BLOCKED_MESSAGE);
    }
  });
});
