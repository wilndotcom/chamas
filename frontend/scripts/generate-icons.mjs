/**
 * Generates the PWA icon set.
 *
 * Written as a script rather than committed binaries so the mark stays in one
 * editable place and can be regenerated at any size. Uses only Node's zlib, so
 * there is no image dependency to install.
 *
 *   node scripts/generate-icons.mjs
 *
 * The mark is a monogram on the emerald brand colour: at 48px on a phone home
 * screen anything more detailed turns to mud. The maskable variant keeps the
 * glyph inside the 80% safe circle, because Android crops the outer fifth to
 * whatever shape the launcher uses.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public');

// ---------------------------------------------------------------- PNG writer

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** RGBA pixel buffer -> PNG bytes. */
const encodePng = (width, height, rgba) => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 means "none".
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
};

// ------------------------------------------------------------------- drawing

class Canvas {
  constructor(size) {
    this.size = size;
    this.data = Buffer.alloc(size * size * 4);
  }

  /** Source-over blend of one pixel. */
  blend(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size || a <= 0) return;
    const i = (y * this.size + x) * 4;
    const sa = a / 255;
    const da = this.data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    this.data[i] = Math.round((r * sa + this.data[i] * da * (1 - sa)) / oa);
    this.data[i + 1] = Math.round((g * sa + this.data[i + 1] * da * (1 - sa)) / oa);
    this.data[i + 2] = Math.round((b * sa + this.data[i + 2] * da * (1 - sa)) / oa);
    this.data[i + 3] = Math.round(oa * 255);
  }

  /**
   * Fills every pixel whose centre falls inside the shape, with 4x4 supersampling
   * so edges are smooth without needing a canvas library.
   */
  fill(colour, inside) {
    const S = 4;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let hits = 0;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            if (inside(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) hits++;
          }
        }
        if (hits > 0) this.blend(x, y, [colour[0], colour[1], colour[2], Math.round((colour[3] ?? 255) * hits / (S * S))]);
      }
    }
  }

  toPng() {
    return encodePng(this.size, this.size, this.data);
  }
}

const roundedRect = (x0, y0, x1, y1, radius) => (px, py) => {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(py, y0 + radius), y1 - radius);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
};

const circle = (cx, cy, r) => (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;

// Emerald, matching the default skin in index.css.
const BRAND = [22, 163, 74];
const WHITE = [255, 255, 255];

/**
 * Draws the monogram.
 *
 * `inset` shrinks the mark towards the centre: a maskable icon needs its content
 * inside the safe zone, while a plain icon may fill more of the tile.
 */
const drawMark = (canvas, { bleed }) => {
  const s = canvas.size;
  const radius = bleed ? 0 : s * 0.22;

  canvas.fill(BRAND, roundedRect(0, 0, s - 1, s - 1, radius));

  const cx = s / 2;
  const cy = s / 2;
  // Proportions are of the tile, then pulled in for the safe zone.
  const k = bleed ? 0.62 : 0.78;
  const barH = s * 0.13 * k;
  const stemW = s * 0.13 * k;
  const barW = s * 0.46 * k;
  const stemH = s * 0.40 * k;

  // Crossbar of the T.
  canvas.fill(WHITE, roundedRect(cx - barW / 2, cy - s * 0.24 * k, cx + barW / 2, cy - s * 0.24 * k + barH, barH / 2));
  // Stem.
  canvas.fill(WHITE, roundedRect(cx - stemW / 2, cy - s * 0.24 * k, cx + stemW / 2, cy - s * 0.24 * k + stemH, stemW / 2));
  // Base, suggesting a shared foundation rather than a bare letter.
  const baseW = s * 0.40 * k;
  const baseH = s * 0.075 * k;
  const baseY = cy + s * 0.20 * k;
  canvas.fill(WHITE, roundedRect(cx - baseW / 2, baseY, cx + baseW / 2, baseY + baseH, baseH / 2));

  // A coin slot detail: a thin ring, kept large enough to survive downscaling.
  canvas.fill([255, 255, 255, 70], circle(cx, cy - s * 0.02 * k, s * 0.30 * k));
};

// --------------------------------------------------------------------- write

mkdirSync(outDir, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, bleed: false },
  { file: 'icon-512.png', size: 512, bleed: false },
  { file: 'icon-maskable-512.png', size: 512, bleed: true },
  { file: 'apple-touch-icon.png', size: 180, bleed: false },
  { file: 'favicon-64.png', size: 64, bleed: false }
];

for (const { file, size, bleed } of targets) {
  const c = new Canvas(size);
  drawMark(c, { bleed });
  const png = c.toPng();
  writeFileSync(join(outDir, file), png);
  console.log(`  ${file.padEnd(24)} ${size}x${size}  ${png.length} bytes`);
}

console.log('\nIcons written to frontend/public/');