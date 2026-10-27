import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  API_SPEC_REJECTION_REASONS,
  MAX_API_SPEC_NODES,
  MAX_API_SPEC_OPERATIONS,
  parseApiSpec,
  type ApiSpecRejectionReason,
} from "./openapi";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/openapi/${name}`, import.meta.url), "utf8");

function rejected(text: string, path: string, maxBytes?: number): ApiSpecRejectionReason {
  const result = parseApiSpec(text, path, { maxBytes });
  if (result.ok) throw new Error("expected rejection");
  return result.reason;
}

describe("parseApiSpec accepts each valid format", () => {
  it("OpenAPI 3.0 in YAML", () => {
    const r = parseApiSpec(fixture("openapi-30.yaml"), "openapi.yaml");
    expect(r).toMatchObject({
      ok: true,
      format: "openapi",
      specVersion: "3.0.3",
      title: "Pet Store",
      apiVersion: "1.2.0",
      operationCount: 3,
    });
  });

  it("OpenAPI 3.0 in JSON", () => {
    expect(parseApiSpec(fixture("openapi-30.json"), "api/openapi.json")).toMatchObject({
      ok: true,
      format: "openapi",
      specVersion: "3.0.1",
      title: "JSON Store",
      apiVersion: "2",
      operationCount: 1,
    });
  });

  it("OpenAPI 3.1 in YAML with webhooks only", () => {
    expect(parseApiSpec(fixture("openapi-31.yaml"), "openapi.yml")).toMatchObject({
      ok: true,
      specVersion: "3.1.0",
      operationCount: 1,
    });
  });

  it("OpenAPI 3.1 in JSON with components only", () => {
    expect(parseApiSpec(fixture("openapi-31.json"), "openapi.json")).toMatchObject({
      ok: true,
      specVersion: "3.1.0",
      operationCount: 0,
    });
  });

  it("Swagger 2.0, quoted or not", () => {
    expect(parseApiSpec(fixture("swagger-20.yaml"), "swagger.yaml")).toMatchObject({
      ok: true,
      format: "swagger",
      specVersion: "2.0",
      title: "Legacy API",
    });
    const unquoted = "swagger: 2.0\ninfo: {title: T, version: 1}\npaths: {}\n";
    expect(parseApiSpec(unquoted, "swagger.yaml")).toMatchObject({
      ok: true,
      format: "swagger",
      specVersion: "2.0",
      apiVersion: "1",
    });
  });

  it("reads JSON text in a .yaml file and tolerates a BOM", () => {
    const json = fixture("openapi-30.json");
    expect(parseApiSpec(json, "openapi.yaml").ok).toBe(true);
    expect(parseApiSpec(`\ufeff${json}`, "openapi.json").ok).toBe(true);
  });

  it("falls back to the path when there is no title", () => {
    const r = parseApiSpec("openapi: 3.0.0\ninfo: {}\npaths: {}\n", "docs/openapi.yaml");
    expect(r).toMatchObject({ ok: true, title: "docs/openapi.yaml", apiVersion: null });
  });

  it("keeps the whole document, including unknown keys", () => {
    const r = parseApiSpec(fixture("openapi-30.yaml"), "openapi.yaml");
    if (!r.ok) throw new Error("expected ok");
    expect(Object.keys(r.spec)).toEqual(["openapi", "info", "paths", "components"]);
  });
});

describe("parseApiSpec rejects with fixed reasons", () => {
  it("invalid YAML and JSON are invalid_syntax", () => {
    expect(rejected(fixture("invalid.yaml"), "openapi.yaml")).toBe("invalid_syntax");
    expect(rejected("{ not json", "openapi.json")).toBe("invalid_syntax");
    expect(rejected("a: 1\na: 2\n", "openapi.yaml")).toBe("invalid_syntax");
    expect(rejected("a: !custom 1\n", "openapi.yaml")).not.toBe("too_large");
  });

  it("a file with no version or a non-mapping root is not_a_spec", () => {
    expect(rejected(fixture("not-a-spec.yaml"), "openapi.yaml")).toBe("not_a_spec");
    expect(rejected("[1, 2]", "openapi.json")).toBe("not_a_spec");
    expect(rejected("", "openapi.yaml")).toBe("not_a_spec");
    expect(rejected("just text", "openapi.yaml")).toBe("not_a_spec");
  });

  it("unsupported versions", () => {
    const base = "info: {title: T}\npaths: {}\n";
    expect(rejected(`openapi: "4.0.0"\n${base}`, "o.yaml")).toBe("unsupported_version");
    expect(rejected(`openapi: 3.0\n${base}`, "o.yaml")).toBe("unsupported_version");
    expect(rejected(`swagger: "1.2"\n${base}`, "o.yaml")).toBe("unsupported_version");
  });

  it("requires info and paths (components or webhooks only for 3.1)", () => {
    expect(rejected('openapi: "3.0.0"\npaths: {}\n', "o.yaml")).toBe("missing_info");
    expect(rejected('openapi: "3.0.0"\ninfo: []\npaths: {}\n', "o.yaml")).toBe("missing_info");
    expect(rejected('openapi: "3.0.0"\ninfo: {}\n', "o.yaml")).toBe("missing_paths");
    expect(rejected('openapi: "3.0.0"\ninfo: {}\ncomponents: {}\n', "o.yaml")).toBe(
      "missing_paths",
    );
    expect(rejected('swagger: "2.0"\ninfo: {}\ndefinitions: {}\n', "o.yaml")).toBe("missing_paths");
    expect(rejected('openapi: "3.1.0"\ninfo: {}\n', "o.yaml")).toBe("missing_paths");
  });

  it("enforces the byte limit by UTF-8 length, before parsing", () => {
    const text = fixture("openapi-30.yaml");
    const bytes = Buffer.byteLength(text);
    expect(parseApiSpec(text, "o.yaml", { maxBytes: bytes }).ok).toBe(true);
    expect(rejected(text, "o.yaml", bytes - 1)).toBe("too_large");
    expect(rejected("é".repeat(600), "o.yaml", 1000)).toBe("too_large");
  });

  it("rejects too many operations", () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_API_SPEC_OPERATIONS; i++) paths[`/p${i}`] = { get: {} };
    const text = JSON.stringify({ openapi: "3.0.0", info: { title: "T" }, paths });
    expect(rejected(text, "openapi.json")).toBe("too_many_operations");
    delete paths["/p0"];
    expect(parseApiSpec(JSON.stringify({ openapi: "3.0.0", info: {}, paths }), "o.json").ok).toBe(
      true,
    );
  });

  it("rejects too many nodes", () => {
    const text = JSON.stringify({
      openapi: "3.0.0",
      info: {},
      paths: {},
      "x-big": new Array<number>(MAX_API_SPEC_NODES).fill(1),
    });
    expect(rejected(text, "openapi.json")).toBe("too_many_nodes");
  });

  it("every reason code is in the exported list", () => {
    expect(new Set(API_SPEC_REJECTION_REASONS).size).toBe(API_SPEC_REJECTION_REASONS.length);
  });
});

describe("parseApiSpec hostile input finishes quickly", () => {
  it("rejects the alias bomb fixture", () => {
    const started = performance.now();
    expect(rejected(fixture("alias-bomb.yaml"), "openapi.yaml")).toBe("too_many_aliases");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("rejects a self-referencing alias", () => {
    const started = performance.now();
    const reason = rejected('openapi: "3.0.0"\ninfo: {}\npaths: {}\nx: &a [*a]\n', "openapi.yaml");
    expect(["too_deep", "too_many_aliases", "invalid_syntax", "too_many_nodes"]).toContain(reason);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("rejects deeply nested YAML and JSON", () => {
    const started = performance.now();
    expect(rejected(fixture("deep-nested.yaml"), "openapi.yaml")).toBe("too_deep");
    expect(rejected(fixture("deep-nested.json"), "openapi.json")).toBe("too_deep");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("survives absurd nesting without overflowing the stack", () => {
    const n = 200_000;
    const json = `{"openapi":"3.0.0","info":{},"paths":{},"x":${"[".repeat(n)}${"]".repeat(n)}}`;
    const started = performance.now();
    expect(rejected(json, "openapi.json")).toBe("too_deep");
    expect(rejected(`x: ${"[".repeat(n)}${"]".repeat(n)}`, "openapi.yaml")).toMatch(
      /^(?:too_deep|invalid_syntax)$/,
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("parseApiSpec cleanup and hostile content", () => {
  it("strips NUL and replaces lone surrogates in keys and strings", () => {
    const text = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Ti\u0000tle\ud800", version: "1" },
      paths: {},
      "x-k\u0000ey": "a\u0000b\udc00c",
    });
    const r = parseApiSpec(text, "openapi.json");
    if (!r.ok) throw new Error("expected ok");
    expect(r.title).toBe("Title\ufffd");
    expect(r.spec["x-key"]).toBe("ab\ufffdc");
    expect(JSON.stringify(r.spec)).not.toMatch(/\\u0000/);
  });

  it("keeps __proto__ as plain data", () => {
    const text = '{"openapi":"3.0.0","info":{},"paths":{},"x":{"__proto__":{"polluted":true}}}';
    const r = parseApiSpec(text, "openapi.json");
    if (!r.ok) throw new Error("expected ok");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const x = r.spec.x as Record<string, unknown>;
    expect(Object.getPrototypeOf(x)).toBe(Object.prototype);
    expect(Object.keys(x)).toEqual(["__proto__"]);
  });

  it("stores the XSS fixture verbatim as data (sanitizing happens at display)", () => {
    const r = parseApiSpec(fixture("xss.yaml"), "openapi.yaml");
    if (!r.ok) throw new Error("expected ok");
    expect(r.title).toBe("<script>alert(1)</script>");
    expect(r.spec.externalDocs).toEqual({ url: "javascript:alert(3)" });
  });

  it("never quotes the input in a result", () => {
    const r = parseApiSpec("SECRET-TOKEN: [", "openapi.yaml");
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
});
