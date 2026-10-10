/** Test support: small byte sequences carrying each image signature. */

const enc = (text: string) => new TextEncoder().encode(text);

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** A real 1x1 PNG. */
export const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
export const JPEG = concat([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], enc("JFIF\0"), new Uint8Array(32));
export const GIF = concat(enc("GIF89a"), [1, 0, 1, 0, 0, 0, 0], new Uint8Array(16));
export const WEBP = concat(enc("RIFF"), [24, 0, 0, 0], enc("WEBPVP8 "), new Uint8Array(16));
export const AVIF = concat(
  [0, 0, 0, 0x1c],
  enc("ftypavif"),
  [0, 0, 0, 0],
  enc("avifmif1miaf"),
  new Uint8Array(16),
);
/** AVIF whose major brand is `mif1`, with `avif` only among the compatible brands. */
export const AVIF_COMPATIBLE = concat(
  [0, 0, 0, 0x18],
  enc("ftypmif1"),
  [0, 0, 0, 0],
  enc("miafavif"),
  new Uint8Array(16),
);
export const BMP = concat(enc("BM"), new Uint8Array(40));
export const ICO = concat([0, 0, 1, 0, 1, 0], new Uint8Array(32));
export const SVG = enc(
  '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: test -->\n<!DOCTYPE svg>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
);
export const SVG_WITH_SCRIPT = enc(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>',
);
export const HTML = enc("<!doctype html><html><body><script>alert(1)</script></body></html>");
