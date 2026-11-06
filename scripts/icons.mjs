// Generates the extension icons (isometric cube) as PNG + SVG with no deps.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const out = new URL('../icons/', import.meta.url);
mkdirSync(out, { recursive: true });

// Geometry in a 0..1 box.
const c = 0.5, r = 0.42, h = r * Math.sin(Math.PI / 6);
const top = [c, c - r], right = [c + r * Math.cos(Math.PI / 6), c - h], rb = [right[0], c + h];
const bot = [c, c + r], lb = [c - r * Math.cos(Math.PI / 6), c + h], left = [lb[0], c - h], mid = [c, c];
const faces = [
  { pts: [top, right, mid, left], color: [118, 170, 250] },
  { pts: [left, mid, bot, lb], color: [47, 111, 214] },
  { pts: [mid, right, rb, bot], color: [29, 79, 168] },
];

function inside(pts, x, y) {
  let k = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) k = !k;
  }
  return k;
}

function crc32(buf) {
  let c2 = ~0;
  for (const b of buf) { c2 ^= b; for (let k = 0; k < 8; k++) c2 = (c2 >>> 1) ^ (0xedb88320 & -(c2 & 1)); }
  return ~c2 >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const S = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const px = (x + (sx + 0.5) / S) / size, py = (y + (sy + 0.5) / S) / size;
        for (const f of faces) {
          if (inside(f.pts, px, py)) { R += f.color[0]; G += f.color[1]; B += f.color[2]; A++; break; }
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = A ? R / A : 0; raw[o + 1] = A ? G / A : 0; raw[o + 2] = A ? B / A : 0;
      raw[o + 3] = Math.round((255 * A) / (S * S));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of [16, 32, 48, 96, 128]) writeFileSync(new URL(`icon-${s}.png`, out), png(s));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${faces
  .map((f) => `<polygon points="${f.pts.map((p) => p.map((v) => v.toFixed(4)).join(',')).join(' ')}" fill="rgb(${f.color})"/>`)
  .join('')}</svg>`;
writeFileSync(new URL('icon.svg', out), svg);
console.log('icons written');
