import { describe, expect, it } from "vitest";

import { requireSameOrigin } from "./same-origin";

function req(headers: Record<string, string>, url = "https://docs.example.com/api/comments") {
  return new Request(url, { method: "POST", headers });
}
const JSON_TYPE = { "Content-Type": "application/json" };

function code(request: Request): string {
  const r = requireSameOrigin(request);
  return r.ok ? "ok" : `${r.status}:${r.code}`;
}

describe("requireSameOrigin", () => {
  it("accepts a same-origin JSON request", () => {
    expect(code(req({ ...JSON_TYPE, Origin: "https://docs.example.com" }))).toBe("ok");
    expect(code(req({ ...JSON_TYPE, Origin: "https://DOCS.example.com" }))).toBe("ok");
    expect(
      code(
        req(
          { ...JSON_TYPE, Origin: "http://localhost:3000" },
          "http://localhost:3000/api/comments",
        ),
      ),
    ).toBe("ok");
  });

  it("accepts a missing Origin from a non-browser client", () => {
    expect(code(req(JSON_TYPE))).toBe("ok");
  });

  it("accepts the JSON type with parameters and any case", () => {
    expect(code(req({ "Content-Type": "Application/JSON; charset=utf-8" }))).toBe("ok");
  });

  it("refuses a foreign Origin, including a look-alike and another port or scheme", () => {
    for (const origin of [
      "https://evil.example.net",
      "https://docs.example.com.evil.net",
      "https://docs.example.com:8443",
      "http://docs.example.com",
      "null",
      "not a url",
      "https://docs.example.com/path",
      "https://user@docs.example.com",
    ]) {
      expect(code(req({ ...JSON_TYPE, Origin: origin })), origin).toBe("403:origin_mismatch");
    }
  });

  it("refuses cross-site fetch metadata even with a matching Origin, allows the others", () => {
    expect(
      code(
        req({ ...JSON_TYPE, Origin: "https://docs.example.com", "Sec-Fetch-Site": "cross-site" }),
      ),
    ).toBe("403:cross_site");
    expect(code(req({ ...JSON_TYPE, "Sec-Fetch-Site": "Cross-Site" }))).toBe("403:cross_site");
    for (const site of ["same-origin", "none", "same-site"]) {
      expect(code(req({ ...JSON_TYPE, "Sec-Fetch-Site": site })), site).toBe("ok");
    }
  });

  it("refuses form-encoded, plain text, multipart and missing content types", () => {
    for (const type of [
      "application/x-www-form-urlencoded",
      "text/plain",
      "multipart/form-data; boundary=x",
      "application/jsonp",
      "text/json",
    ]) {
      expect(code(req({ "Content-Type": type, Origin: "https://docs.example.com" })), type).toBe(
        "403:json_required",
      );
    }
    expect(code(new Request("https://docs.example.com/api/comments", { method: "DELETE" }))).toBe(
      "403:json_required",
    );
  });

  it("follows a proxy-style forwarded host and protocol", () => {
    // The app sees the internal address; the browser used the public one.
    const internal = "http://app:3000/api/comments";
    const via = {
      ...JSON_TYPE,
      "X-Forwarded-Host": "docs.example.com",
      "X-Forwarded-Proto": "https",
    };
    expect(code(req({ ...via, Origin: "https://docs.example.com" }, internal))).toBe("ok");
    expect(
      code(
        req(
          {
            ...via,
            "X-Forwarded-Host": "docs.example.com, app:3000",
            Origin: "https://docs.example.com",
          },
          internal,
        ),
      ),
    ).toBe("ok");
    expect(
      code(
        req(
          {
            ...JSON_TYPE,
            Host: "docs.example.com",
            "X-Forwarded-Proto": "https",
            Origin: "https://docs.example.com",
          },
          internal,
        ),
      ),
    ).toBe("ok");
    // A foreign origin is still refused behind the proxy.
    expect(code(req({ ...via, Origin: "https://evil.example.net" }, internal))).toBe(
      "403:origin_mismatch",
    );
    // A forwarded protocol that is not http(s) is ignored.
    expect(
      code(
        req(
          { ...via, "X-Forwarded-Proto": "javascript", Origin: "javascript://docs.example.com" },
          internal,
        ),
      ),
    ).toBe("403:origin_mismatch");
  });

  it("never reads the body", () => {
    const request = req({ ...JSON_TYPE, Origin: "https://docs.example.com" });
    requireSameOrigin(request);
    expect(request.bodyUsed).toBe(false);
  });
});
