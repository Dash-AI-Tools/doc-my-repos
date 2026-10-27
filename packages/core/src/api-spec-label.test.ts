import { describe, expect, it } from "vitest";

import { apiSpecFormatLabel } from "./api-spec-label";

describe("apiSpecFormatLabel", () => {
  it("keeps major and minor", () => {
    expect(apiSpecFormatLabel("openapi", "3.1.0")).toBe("OpenAPI 3.1");
    expect(apiSpecFormatLabel("openapi", "3.0.3")).toBe("OpenAPI 3.0");
    expect(apiSpecFormatLabel("swagger", "2.0")).toBe("Swagger 2.0");
  });
  it("shows an odd version as stored", () => {
    expect(apiSpecFormatLabel("openapi", "3")).toBe("OpenAPI 3");
  });
});
