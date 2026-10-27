import { describe, expect, it } from "vitest";

import {
  bytesMatchType,
  CONTENT_TYPES,
  imageTypeForPath,
  type ImageType,
  sniffImageType,
} from "./image-types";
import {
  AVIF,
  AVIF_COMPATIBLE,
  BMP,
  GIF,
  HTML,
  ICO,
  JPEG,
  PNG,
  SVG,
  SVG_WITH_SCRIPT,
  WEBP,
} from "./test-images";

const enc = (text: string) => new TextEncoder().encode(text);

describe("imageTypeForPath", () => {
  it.each<[string, ImageType]>([
    ["a.png", "png"],
    ["img/A.PNG", "png"],
    ["x.jpg", "jpeg"],
    ["x.JPEG", "jpeg"],
    ["x.gif", "gif"],
    ["x.webp", "webp"],
    ["x.avif", "avif"],
    ["x.bmp", "bmp"],
    ["x.ico", "ico"],
    ["diagrams/arch.svg", "svg"],
    [".github/logo.png", "png"],
  ])("%s is %s", (path, type) => {
    expect(imageTypeForPath(path)).toBe(type);
  });

  it.each([
    "README.md",
    "index.html",
    "app.js",
    "notes.txt",
    "data.json",
    "x.svgz",
    "x.png.html",
    "x.tiff",
    "png",
    ".png",
    "x.",
    "folder.png/file",
    "",
  ])("refuses %j", (path) => {
    expect(imageTypeForPath(path)).toBeNull();
  });

  it("maps every type to an image content type", () => {
    for (const type of Object.values(CONTENT_TYPES)) expect(type).toMatch(/^image\//);
  });
});

describe("sniffImageType", () => {
  it.each<[string, Uint8Array, ImageType]>([
    ["png", PNG, "png"],
    ["jpeg", JPEG, "jpeg"],
    ["gif", GIF, "gif"],
    ["gif87a", enc("GIF87a\u0001\u0000\u0001\u0000"), "gif"],
    ["webp", WEBP, "webp"],
    ["avif", AVIF, "avif"],
    ["avif (compatible brand)", AVIF_COMPATIBLE, "avif"],
    ["bmp", BMP, "bmp"],
    ["ico", ICO, "ico"],
    ["svg with prolog", SVG, "svg"],
    ["bare svg", enc('<svg xmlns="http://www.w3.org/2000/svg"/>'), "svg"],
    ["svg with BOM and space", enc('﻿  \n<svg width="1"></svg>'), "svg"],
  ])("recognizes %s", (_name, bytes, type) => {
    expect(sniffImageType(bytes)).toBe(type);
  });

  it.each<[string, Uint8Array]>([
    ["empty", new Uint8Array(0)],
    ["html", HTML],
    ["html mentioning svg", enc("<html><svg></svg></html>")],
    ["text", enc("hello <svg>")],
    ["json", enc('{"svg": "<svg>"}')],
    ["truncated png", PNG.subarray(0, 4)],
    ["riff without webp", enc("RIFF\u0000\u0000\u0000\u0000WAVEfmt ")],
    ["mp4 ftyp", enc("\u0000\u0000\u0000\u0018ftypisom\u0000\u0000\u0000\u0000isomavc1")],
    ["invalid utf-8 svg", Uint8Array.from([0x3c, 0x73, 0x76, 0x67, 0x20, 0xff, 0xfe, 0x3e])],
    ["svgz (gzip)", Uint8Array.from([0x1f, 0x8b, 0x08, 0x00])],
    ["unterminated comment before svg", enc("<!-- never closed <svg>")],
  ])("refuses %s", (_name, bytes) => {
    expect(sniffImageType(bytes)).toBeNull();
  });

  it("treats an SVG with a script as SVG (served with a sandboxing CSP, see serve.ts)", () => {
    expect(sniffImageType(SVG_WITH_SCRIPT)).toBe("svg");
  });

  it("only finds the svg root near the start", () => {
    expect(sniffImageType(enc(`${" ".repeat(5000)}<svg></svg>`))).toBeNull();
  });

  it("bytesMatchType requires the claimed type exactly", () => {
    expect(bytesMatchType(PNG, "png")).toBe(true);
    expect(bytesMatchType(JPEG, "png")).toBe(false);
    expect(bytesMatchType(HTML, "png")).toBe(false);
    expect(bytesMatchType(SVG, "png")).toBe(false);
    expect(bytesMatchType(PNG, "svg")).toBe(false);
  });
});
