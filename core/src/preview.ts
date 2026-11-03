import { deflateSync } from "node:zlib";

// A link-preview image of biscotti's ASCII art, drawn in a 5x7 pixel font: black on white, centered.

const GLYPHS: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00000", "00100"],
  "'": ["00100", "00100", "00000", "00000", "00000", "00000", "00000"],
  "~": ["00000", "00000", "01000", "10101", "00010", "00000", "00000"],
  o: ["00000", "00000", "01110", "10001", "10001", "10001", "01110"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "\\": ["10000", "01000", "01000", "00100", "00010", "00010", "00001"],
};
// Each character's cell: the glyph and a pixel of spacing to its right and below.
const CELL_W = 6;
const CELL_H = 8;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Buffer) {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

// An 8-bit greyscale PNG: black where `ink` is set (one byte per pixel, row by row), white elsewhere.
function greyPng(width: number, height: number, ink: Uint8Array) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth; colour type 0 (greyscale), default compression, filter and interlace
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rows[y * (width + 1) + 1 + x] = ink[y * width + x] ? 0 : 255;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function previewPng(art: string, width = 1200, height = 630): Buffer {
  const lines = art.split("\n");
  const cols = Math.max(...lines.map((l) => l.length));
  const scale = Math.max(1, Math.floor(Math.min((width * 0.8) / (cols * CELL_W), (height * 0.8) / (lines.length * CELL_H))));
  const left = Math.floor((width - cols * CELL_W * scale) / 2);
  const top = Math.floor((height - lines.length * CELL_H * scale) / 2);
  const ink = new Uint8Array(width * height);
  lines.forEach((line, row) =>
    [...line].forEach((char, col) =>
      (GLYPHS[char] ?? GLYPHS[" "]).forEach((bits, gy) =>
        [...bits].forEach((bit, gx) => {
          if (bit !== "1") return;
          const x0 = left + (col * CELL_W + gx) * scale;
          const y0 = top + (row * CELL_H + gy) * scale;
          for (let y = y0; y < y0 + scale; y++) ink.fill(1, y * width + x0, y * width + x0 + scale);
        }),
      ),
    ),
  );
  return greyPng(width, height, ink);
}
