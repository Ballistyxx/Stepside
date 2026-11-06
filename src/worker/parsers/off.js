import { Scanner } from '../scanner.js';
import { GrowU32, GrowU8 } from '../grow.js';

/** Object File Format: OFF / COFF / NOFF / CNOFF / STOFF, per-vertex & per-face colours. */
export function parseOff(bytes) {
  const s = new Scanner(bytes);
  const b = bytes;
  skip(s);
  const word = s.readWord();
  const m = /^(ST)?(C)?(N)?(4)?(n)?OFF(.*)$/.exec(word);
  if (!m) throw new Error('Not an OFF file (missing OFF header).');
  const [, st, c, nrm, four, ndim] = m;
  if (four || ndim) throw new Error('Higher-dimensional OFF files are not supported.');
  let rest = m[6];
  const counts = [];
  if (rest && /^\d/.test(rest)) counts.push(parseInt(rest, 10));
  while (counts.length < 3) {
    skip(s);
    const v = s.readNumber();
    if (Number.isNaN(v)) throw new Error('Malformed OFF header.');
    counts.push(v);
  }
  const [nv, nf] = counts;
  const position = new Float32Array(nv * 3);
  const normal = nrm ? new Float32Array(nv * 3) : null;
  let vertexColor = null;
  const vals = new Float64Array(32);

  for (let i = 0; i < nv; i++) {
    skip(s);
    let k = 0;
    // read to end of line
    for (;;) {
      s.skipSpaces();
      if (s.atEol() || k === 32) break;
      vals[k++] = s.readNumber();
    }
    if (k < 3) throw new Error(`OFF vertex ${i} is malformed.`);
    position[3 * i] = vals[0]; position[3 * i + 1] = vals[1]; position[3 * i + 2] = vals[2];
    let o = 3;
    if (normal && k >= 6) { normal[3 * i] = vals[3]; normal[3 * i + 1] = vals[4]; normal[3 * i + 2] = vals[5]; o = 6; }
    if (c && k - o >= 3) {
      if (!vertexColor) vertexColor = new Uint8Array(nv * 3).fill(200);
      const scale = colorScale(vals, o, k - o - (st ? 2 : 0));
      vertexColor[3 * i] = c8(vals[o] * scale);
      vertexColor[3 * i + 1] = c8(vals[o + 1] * scale);
      vertexColor[3 * i + 2] = c8(vals[o + 2] * scale);
    }
  }

  const index = new GrowU32(nf * 3 + 16);
  const fcol = new GrowU8(0);
  let anyFaceColor = false;
  const poly = new Uint32Array(1024);
  for (let f = 0; f < nf; f++) {
    skip(s);
    if (s.eof()) break;
    const n = s.readInt();
    if (Number.isNaN(n)) { s.skipLine(); continue; }
    let k = 0;
    for (let j = 0; j < n; j++) {
      s.skipWs();
      const v = s.readInt();
      if (k < 1024) poly[k++] = v;
    }
    // optional colour: rest of the line
    let ck = 0;
    for (;;) {
      s.skipSpaces();
      if (s.atEol() || ck === 8) break;
      vals[ck++] = s.readNumber();
    }
    let r = 200, g = 200, bl = 200;
    if (ck >= 3) {
      anyFaceColor = true;
      const scale = colorScale(vals, 0, ck);
      r = c8(vals[0] * scale); g = c8(vals[1] * scale); bl = c8(vals[2] * scale);
    }
    for (let j = 1; j + 1 < k; j++) {
      const a = poly[0], b2 = poly[j], c2 = poly[j + 1];
      if (a < nv && b2 < nv && c2 < nv) {
        index.push3(a, b2, c2);
        fcol.push3(r, g, bl);
      }
    }
  }
  void b;
  if (index.n === 0) return [{ points: true, position, vertexColor }];
  if (normal) {
    for (let i = 0; i < normal.length; i += 3) {
      const l = Math.hypot(normal[i], normal[i + 1], normal[i + 2]) || 1;
      normal[i] /= l; normal[i + 1] /= l; normal[i + 2] /= l;
    }
  }
  return [{
    position, index: index.trim(), normal, vertexColor,
    faceColor: anyFaceColor ? fcol.trim() : null,
    crease: (35 * Math.PI) / 180,
  }];
}

/** Colours are either ints 0..255 or floats 0..1. */
function colorScale(vals, o, n) {
  for (let i = o; i < o + Math.min(n, 3); i++) {
    if (vals[i] > 1 || (vals[i] % 1 === 0 && vals[i] !== 0 && vals[i] !== 1)) return 1;
  }
  return 255;
}

const c8 = (v) => (v > 255 ? 255 : v > 0 ? Math.round(v) : 0);

/** Skip whitespace and # comments. */
function skip(s) {
  for (;;) {
    s.skipWs();
    if (s.p < s.n && s.b[s.p] === 35) s.skipLine();
    else return;
  }
}
