/**
 * Image types the asset proxy serves (task 7.5). Pure: no I/O. Shared by the image rewriting
 * plugin (which marks an image with any other extension as broken) and the proxy (which refuses
 * any other extension before touching the database or GitHub, then checks the bytes).
 *
 * The extension decides the claimed type; the bytes must then carry that type's signature
 * (`sniffImageType`), and the response `Content-Type` is ours, never GitHub's. A JPEG saved as
 * `.png` is refused (415) like an HTML file saved as `.png`: the rule is "the content must match
 * the claimed type", with no guessing.
 *
 * SVG is served. It is a common docs format (diagrams, logos), and inside `<img>` a browser
 * never runs its scripts or loads its external resources. The danger is a reader opening the
 * asset URL directly, where an SVG is a document in our origin. The proxy therefore sends every
 * response with `Content-Security-Policy: default-src 'none'; sandbox` (SVG additionally allows
 * inline styles, nothing else), `X-Content-Type-Options: nosniff` and
 * `Cross-Origin-Resource-Policy: same-origin`: opened directly, the SVG runs in an opaque origin
 * with scripts, plugins, forms and every fetch blocked. The SVG bytes must also be UTF-8 text
 * whose root element is `<svg` (`isSvg`).
 */

export type ImageType = "png" | "jpeg" | "gif" | "webp" | "avif" | "bmp" | "ico" | "svg";

export const CONTENT_TYPES: Readonly<Record<ImageType, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/** File extension (lowercase, without the dot) to claimed type. Anything else is refused. */
export const IMAGE_EXTENSIONS: ReadonlyMap<string, ImageType> = new Map<string, ImageType>([
  ["png", "png"],
  ["jpg", "jpeg"],
  ["jpeg", "jpeg"],
  ["gif", "gif"],
  ["webp", "webp"],
  ["avif", "avif"],
  ["bmp", "bmp"],
  ["ico", "ico"],
  ["svg", "svg"],
]);

/** The claimed image type of a file name or path, by extension (case-insensitive), or null. */
export function imageTypeForPath(path: string): ImageType | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return IMAGE_EXTENSIONS.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = ascii("GIF87a");
const GIF89 = ascii("GIF89a");
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");
const FTYP = ascii("ftyp");
const BMP = ascii("BM");
const ICO = [0x00, 0x00, 0x01, 0x00];
const AVIF_BRANDS = new Set(["avif", "avis"]);

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** ISO-BMFF `ftyp` box whose major or a compatible brand is `avif` or `avis`. */
function isAvif(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, FTYP, 4)) return false;
  const size =
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  if (size < 16 || size > 4096 || size > bytes.length) return false;
  if (AVIF_BRANDS.has(readAscii(bytes, 8, 4))) return true;
  for (let offset = 16; offset + 4 <= size; offset += 4) {
    if (AVIF_BRANDS.has(readAscii(bytes, offset, 4))) return true;
  }
  return false;
}

/** How much of an SVG is inspected for the root element. */
const SVG_PROBE_CHARS = 4096;

/**
 * UTF-8 text (a BOM is skipped) whose root element is `<svg`, found within the first
 * `SVG_PROBE_CHARS` characters. Only an XML declaration, comments, processing instructions, a
 * doctype and whitespace may come before it, as editors write them. An HTML page, or text that
 * merely mentions `<svg` later, is not an SVG.
 */
function isSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    // `stream: true`: a multi-byte character cut at the probe boundary is held back, not an error.
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, SVG_PROBE_CHARS * 4),
      { stream: true },
    );
  } catch {
    return false;
  }
  const head = text.slice(0, SVG_PROBE_CHARS);
  const root = head.replace(/^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, "");
  return /^<svg[\s>/]/i.test(root);
}

/** The image type the bytes actually are, or null when they are none of the served types. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, PNG)) return "png";
  if (startsWith(bytes, JPEG)) return "jpeg";
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return "gif";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "webp";
  if (isAvif(bytes)) return "avif";
  if (startsWith(bytes, BMP) && bytes.length >= 26) return "bmp";
  if (startsWith(bytes, ICO) && bytes.length >= 22) return "ico";
  if (isSvg(bytes)) return "svg";
  return null;
}

/** Whether `bytes` are an image of exactly the type `claimed`. */
export function bytesMatchType(bytes: Uint8Array, claimed: ImageType): boolean {
  return sniffImageType(bytes) === claimed;
}
