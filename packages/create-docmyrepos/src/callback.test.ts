import { EventEmitter } from "node:events";
import { request } from "node:http";

import { describe, expect, it } from "vitest";

import { createBrowserOpener, openerCommand, type OpenerChild } from "./browser.js";
import {
  ManifestCallbackError,
  parsePastedCode,
  safeEqual,
  startManifestCallback,
  type ManifestCallbackHandle,
  type ManifestCallbackOptions,
} from "./callback.js";

const MANIFEST = { name: "docs", redirect_url: "x" };
const handles: ManifestCallbackHandle[] = [];

async function start(
  extra: Partial<ManifestCallbackOptions> = {},
): Promise<ManifestCallbackHandle> {
  const handle = await startManifestCallback({
    organization: "acme",
    manifest: MANIFEST,
    openBrowser: () => Promise.resolve(true),
    ...extra,
  });
  handles.push(handle);
  return handle;
}

import { afterEach } from "vitest";
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
});

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}
function get(url: string, options: { method?: string; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: options.method ?? "GET",
        headers: options.host === undefined ? {} : { Host: options.host },
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (d: string) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const callback = (h: ManifestCallbackHandle, code: string, state: string): string =>
  `${h.callbackUrl}?code=${code}&state=${encodeURIComponent(state)}`;

describe("startManifestCallback", () => {
  it("serves the form once and resolves with the code on the right state", async () => {
    const h = await start({
      manifest: (redirect) => ({ ...MANIFEST, redirect_url: redirect }),
    });
    expect(h.startUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/start\?t=/);
    expect(h.callbackUrl).toBe(`http://127.0.0.1:${h.port}/callback`);

    const form = await get(h.startUrl);
    expect(form.status).toBe(200);
    expect(form.body).toContain(
      `action="https://github.com/organizations/acme/settings/apps/new?state=${encodeURIComponent(h.state)}"`,
    );
    expect(form.body).toContain("&quot;redirect_url&quot;:&quot;" + h.callbackUrl);
    expect(String(form.headers["content-security-policy"])).toContain(
      "form-action https://github.com",
    );
    expect((await get(h.startUrl)).status).toBe(404);

    const done = await get(callback(h, "abc123", h.state));
    expect(done.status).toBe(200);
    expect(done.body).toContain("return to the terminal");
    expect(done.body).not.toContain("abc123");
    await expect(h.result).resolves.toEqual({ code: "abc123" });
  });

  it("escapes organization and manifest content", async () => {
    const h = await start({ organization: 'a"><b', manifest: { name: '"><script>x</script>' } });
    const form = await get(h.startUrl);
    expect(form.body).not.toContain("<script>x");
    expect(form.body).not.toContain('a"><b');
  });

  it("rejects a wrong or missing state and keeps waiting", async () => {
    const h = await start();
    for (const q of [
      "?code=abc&state=nope",
      "?code=abc",
      `?code=abc&state=${h.state}x`,
      `?state=${h.state}`,
    ]) {
      const r = await get(h.callbackUrl + q);
      expect(r.status).toBe(400);
      expect(r.body).not.toContain("abc");
    }
    expect((await get(callback(h, "good", h.state))).status).toBe(200);
    await expect(h.result).resolves.toEqual({ code: "good" });
  });

  it("is single use: a replay finds nothing listening", async () => {
    const h = await start();
    await get(callback(h, "once", h.state));
    await h.result;
    await new Promise((r) => setTimeout(r, 50));
    await expect(get(callback(h, "twice", h.state))).rejects.toThrow();
  });

  it("times out with a typed error and closes", async () => {
    const h = await start({ timeoutMs: 40 });
    await expect(h.result).rejects.toMatchObject({
      name: "ManifestCallbackError",
      reason: "timeout",
    });
    await expect(get(h.callbackUrl)).rejects.toThrow();
  });

  it("closes on abort and leaves nothing listening", async () => {
    const ac = new AbortController();
    const h = await start({ signal: ac.signal });
    ac.abort();
    await expect(h.result).rejects.toMatchObject({ reason: "aborted" });
    await expect(get(h.callbackUrl)).rejects.toThrow();
    await expect(
      startManifestCallback({ organization: "a", manifest: {}, signal: ac.signal }),
    ).rejects.toBeInstanceOf(ManifestCallbackError);
  });

  it("close() rejects the pending result", async () => {
    const h = await start();
    await h.close();
    await expect(h.result).rejects.toMatchObject({ reason: "closed" });
  });

  it("binds only to the loopback interface", async () => {
    const h = await start();
    // A different Host header (DNS rebinding) is refused even from loopback.
    expect((await get(h.callbackUrl, { host: "evil.example" })).status).toBe(404);
    expect((await get(h.startUrl, { host: `localhost:${h.port}` })).status).toBe(200);
    const { networkInterfaces } = await import("node:os");
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i !== undefined && !i.internal && i.family === "IPv4");
    if (external !== undefined) {
      await expect(get(`http://${external.address}:${h.port}/callback`)).rejects.toThrow();
    }
  });

  it("answers 404 and 405 for other paths and methods", async () => {
    const h = await start();
    expect((await get(`http://127.0.0.1:${h.port}/`)).status).toBe(404);
    expect((await get(`http://127.0.0.1:${h.port}/start`)).status).toBe(404);
    const post = await get(h.callbackUrl, { method: "POST" });
    expect(post.status).toBe(405);
    expect((await get(callback(h, "ok", h.state))).status).toBe(200);
  });

  it("serves no code or key material on any page", async () => {
    const h = await start();
    const pages = [
      (await get(h.startUrl)).body,
      (await get(`${h.callbackUrl}?code=SECRETCODE&state=wrong`)).body,
      (await get(`http://127.0.0.1:${h.port}/nothing`)).body,
      (await get(callback(h, "SECRETCODE", h.state))).body,
    ];
    for (const body of pages) {
      expect(body).not.toContain("SECRETCODE");
      expect(body).not.toMatch(/PRIVATE KEY|webhook_secret|"pem"/);
    }
    expect(pages[1]).not.toContain(h.state);
    expect(pages[3]).not.toContain(h.state);
  });

  it("reports whether the browser opened, and tolerates a throwing opener", async () => {
    const urls: string[] = [];
    const a = await start({ openBrowser: (u) => (urls.push(u), Promise.resolve(false)) });
    expect(a.opened).toBe(false);
    expect(urls).toEqual([a.startUrl]);
    const b = await start({ openBrowser: () => Promise.reject(new Error("boom")) });
    expect(b.opened).toBe(false);
  });
});

describe("browser opener", () => {
  const URL_OK = "http://127.0.0.1:4321/start?t=abc-_9";

  function fakeSpawn(outcome: "spawn" | "error" | "throw") {
    const calls: { command: string; args: readonly string[]; options: unknown }[] = [];
    const fn = (command: string, args: readonly string[], options: unknown): OpenerChild => {
      calls.push({ command, args, options });
      if (outcome === "throw") throw new Error("nope");
      const ee = new EventEmitter();
      queueMicrotask(() => ee.emit(outcome, new Error("ENOENT")));
      return Object.assign(ee, { unref: () => undefined }) as unknown as OpenerChild;
    };
    return { fn, calls };
  }

  it("uses the platform opener with an argument array and no shell", async () => {
    for (const [platform, command, args] of [
      ["darwin", "open", [URL_OK]],
      ["linux", "xdg-open", [URL_OK]],
      ["win32", "cmd", ["/c", "start", "", URL_OK]],
    ] as const) {
      const { fn, calls } = fakeSpawn("spawn");
      await expect(createBrowserOpener(platform, fn)(URL_OK)).resolves.toBe(true);
      expect(calls[0]?.command).toBe(command);
      expect(calls[0]?.args).toEqual(args);
      expect(calls[0]?.options).toMatchObject({ shell: false });
    }
  });

  it("resolves false when launching fails, and refuses unexpected addresses", async () => {
    await expect(createBrowserOpener("linux", fakeSpawn("error").fn)(URL_OK)).resolves.toBe(false);
    await expect(createBrowserOpener("linux", fakeSpawn("throw").fn)(URL_OK)).resolves.toBe(false);
    const { fn, calls } = fakeSpawn("spawn");
    await expect(
      createBrowserOpener("win32", fn)("http://127.0.0.1:1/start?t=a&calc"),
    ).resolves.toBe(false);
    await expect(createBrowserOpener("win32", fn)("https://evil.example/")).resolves.toBe(false);
    expect(calls).toHaveLength(0);
    expect(() => openerCommand("linux", "file:///etc/passwd")).toThrow();
  });
});

describe("parsePastedCode", () => {
  it("accepts a bare code", () => {
    expect(parsePastedCode("  a1b2c3d4  ")).toEqual({ ok: true, code: "a1b2c3d4" });
  });

  it("accepts a callback address and checks state when present", () => {
    const url = "http://127.0.0.1:5000/callback?code=abc123&state=S1";
    expect(parsePastedCode(url, "S1")).toEqual({ ok: true, code: "abc123" });
    expect(parsePastedCode(url)).toEqual({ ok: true, code: "abc123" });
    expect(parsePastedCode(url, "S2")).toEqual({ ok: false, reason: "state-mismatch" });
    expect(parsePastedCode("http://127.0.0.1:5000/callback?code=abc123", "S1")).toEqual({
      ok: true,
      code: "abc123",
    });
  });

  it("rejects everything else without echoing the input", () => {
    for (const bad of [
      "",
      "   ",
      "has spaces and $(rm)",
      "ftp://x/?code=abc",
      "javascript:alert(1)",
    ]) {
      expect(parsePastedCode(bad).ok).toBe(false);
    }
    expect(parsePastedCode("http://x/callback?state=S")).toEqual({ ok: false, reason: "no-code" });
    expect(parsePastedCode("http://x/?code=bad%20code")).toEqual({ ok: false, reason: "no-code" });
    expect(JSON.stringify(parsePastedCode("nope nope"))).not.toContain("nope");
  });
});

describe("safeEqual", () => {
  it("compares by value and length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
