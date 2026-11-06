import { Scanner, latin1 } from '../scanner.js';
import { GrowF32, GrowI32, GrowU8, GrowU16 } from '../grow.js';

/**
 * Wavefront OBJ. Supports v (with optional vertex colours), vn, f (any
 * polygon, v/vt/vn forms, negative indices), usemtl + mtllib (Kd colours).
 * Faces-free files render as point clouds.
 */
export async function parseObj(bytes, ctx) {
  const s = new Scanner(bytes);
  const b = bytes, n = bytes.length;
  const pos = new GrowF32(1 << 16);
  const nrm = new GrowF32(1024);
  let col = null;
  const cv = new GrowI32(1 << 16);
  const cn = new GrowI32(1 << 16);
  const tm = new GrowU16(1 << 14);
  const materials = [];
  const matIndex = new Map();
  const mtllibs = [];
  let mat = 0;
  let anyNormalRef = false, missingNormalRef = false;
  const poly = new Int32Array(1024), polyN = new Int32Array(1024);
  const tmp = [0, 0, 0, 0, 0, 0, 0];

  while (s.p < n) {
    s.skipWs();
    if (s.p >= n) break;
    const c0 = b[s.p], c1 = b[s.p + 1];
    if (c0 === 118 && (c1 === 32 || c1 === 9)) { // "v "
      s.p += 2;
      let k = 0;
      for (;;) {
        s.skipSpaces();
        if (s.atEol() || k === 7) break;
        const v = s.readNumber();
        tmp[k++] = v;
      }
      pos.push3(tmp[0] || 0, tmp[1] || 0, tmp[2] || 0);
      if (k >= 6) {
        if (!col) {
          col = new GrowU8(pos.a.length);
          for (let i = 0; i < pos.n - 3; i++) col.push(200);
        }
        const o = k - 3;
        col.push3(clamp255(tmp[o]), clamp255(tmp[o + 1]), clamp255(tmp[o + 2]));
      } else if (col) col.push3(200, 200, 200);
      s.skipLine();
    } else if (c0 === 118 && c1 === 110) { // "vn"
      s.p += 2;
      s.skipSpaces(); const x = s.readNumber();
      s.skipSpaces(); const y = s.readNumber();
      s.skipSpaces(); const z = s.readNumber();
      nrm.push3(x, y, z);
      s.skipLine();
    } else if (c0 === 102 && (c1 === 32 || c1 === 9)) { // "f "
      s.p += 2;
      const nvCount = pos.n / 3, nnCount = nrm.n / 3;
      let k = 0;
      for (;;) {
        s.skipSpaces();
        if (s.atEol()) break;
        if (b[s.p] === 92) { s.p++; s.skipSpaces(); if (b[s.p] === 10) s.p++; continue; } // line continuation
        let vi = s.readInt();
        if (Number.isNaN(vi)) { s.p++; continue; }
        let ni = 0;
        if (b[s.p] === 47) {
          s.p++;
          if (b[s.p] !== 47) s.readInt(); // vt (ignored)
          if (b[s.p] === 47) { s.p++; const r = s.readInt(); if (!Number.isNaN(r)) ni = r; }
        }
        while (s.p < n && b[s.p] > 32) s.p++; // skip any trailing junk on the token
        vi = vi < 0 ? nvCount + vi : vi - 1;
        if (ni) { ni = ni < 0 ? nnCount + ni : ni - 1; anyNormalRef = true; } else { ni = -1; missingNormalRef = true; }
        if (k < 1024) { poly[k] = vi; polyN[k] = ni; k++; }
      }
      for (let i = 1; i + 1 < k; i++) {
        cv.push3(poly[0], poly[i], poly[i + 1]);
        cn.push3(polyN[0], polyN[i], polyN[i + 1]);
        tm.push(mat);
      }
      s.skipLine();
    } else if (c0 === 117 && matchWord(b, s.p, 'usemtl')) {
      s.p += 6; s.skipSpaces();
      const name = readRest(s);
      if (!matIndex.has(name)) { matIndex.set(name, materials.length); materials.push(name); }
      mat = matIndex.get(name) + 1;
    } else if (c0 === 109 && matchWord(b, s.p, 'mtllib')) {
      s.p += 6; s.skipSpaces();
      const name = readRest(s);
      if (name) mtllibs.push(name);
    } else {
      s.skipLine();
    }
  }

  const position = pos.trim();
  const nv = position.length / 3;
  const vertexColor = col ? col.trim() : null;
  const ntri = cv.n / 3;

  if (ntri === 0) return [{ points: true, position, vertexColor }];

  // validate indices
  const ci = cv.a, nci = cn.a;
  for (let i = 0; i < cv.n; i++) {
    if (ci[i] < 0 || ci[i] >= nv) ci[i] = 0;
  }

  // material colours
  let colors = null;
  if (materials.length && mtllibs.length && ctx.fetchText) {
    colors = new Map();
    for (const lib of mtllibs) {
      try { parseMtl(await ctx.fetchText(lib), colors); } catch { /* missing mtl: ignore */ }
    }
  }
  let faceColor = null, uniform = null;
  if (colors && colors.size) {
    const table = [null, ...materials.map((m) => colors.get(m) || null)];
    const distinct = new Set(table.filter(Boolean).map(String));
    const usedMats = new Set(tm.a.subarray(0, ntri));
    if (distinct.size === 1 && usedMats.size === 1) uniform = table[usedMats.values().next().value];
    else if (distinct.size >= 1) {
      faceColor = new Uint8Array(ntri * 3);
      const def = [200, 200, 200];
      for (let t = 0; t < ntri; t++) {
        const c = table[tm.a[t]] || def;
        faceColor[3 * t] = c[0]; faceColor[3 * t + 1] = c[1]; faceColor[3 * t + 2] = c[2];
      }
    }
  }

  const useNormals = anyNormalRef && !missingNormalRef && nrm.n > 0;
  if (!useNormals) {
    return [{
      position, index: new Uint32Array(ci.buffer, 0, cv.n), vertexColor, faceColor, color: uniform,
    }];
  }

  // Unify (v, vn) pairs into vertices with a per-vertex chain (most v map to 1–3 normals).
  const nn = nrm.n / 3, na = nrm.a;
  const head = new Int32Array(nv).fill(-1);
  const next = new GrowI32(nv), nOf = new GrowI32(nv), vOf = new GrowI32(nv);
  const index = new Uint32Array(cv.n);
  let count = 0;
  for (let i = 0; i < cv.n; i++) {
    const v = ci[i];
    let ni = nci[i];
    if (ni < 0 || ni >= nn) ni = -1;
    let e = head[v];
    while (e !== -1 && nOf.a[e] !== ni) e = next.a[e];
    if (e === -1) {
      e = count++;
      next.push(head[v]); nOf.push(ni); vOf.push(v);
      head[v] = e;
    }
    index[i] = e;
  }
  const P = new Float32Array(count * 3), N = new Float32Array(count * 3);
  const C = vertexColor ? new Uint8Array(count * 3) : null;
  for (let e = 0; e < count; e++) {
    const v = vOf.a[e] * 3, ni = nOf.a[e];
    P[3 * e] = position[v]; P[3 * e + 1] = position[v + 1]; P[3 * e + 2] = position[v + 2];
    if (ni >= 0) {
      const x = na[3 * ni], y = na[3 * ni + 1], z = na[3 * ni + 2];
      const l = Math.hypot(x, y, z) || 1;
      N[3 * e] = x / l; N[3 * e + 1] = y / l; N[3 * e + 2] = z / l;
    }
    if (C) { C[3 * e] = vertexColor[v]; C[3 * e + 1] = vertexColor[v + 1]; C[3 * e + 2] = vertexColor[v + 2]; }
  }
  return [{ position: P, normal: N, index, vertexColor: C, faceColor, color: uniform }];
}

function clamp255(v) {
  if (!(v > 0)) return 0;
  if (v > 1) return v > 255 ? 255 : Math.round(v); // 0..255 style
  return Math.round(v * 255);
}

function matchWord(b, p, w) {
  for (let i = 0; i < w.length; i++) if (b[p + i] !== w.charCodeAt(i)) return false;
  const c = b[p + w.length];
  return c === 32 || c === 9;
}

function readRest(s) {
  const st = s.p;
  let e = s.b.indexOf(10, st);
  if (e < 0) e = s.n;
  s.p = e;
  return latin1(s.b, st, e).trim();
}

export function parseMtl(text, out) {
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('newmtl')) cur = line.slice(6).trim();
    else if (cur && /^Kd\s/.test(line)) {
      const [r, g, b] = line.slice(2).trim().split(/\s+/).map(Number);
      out.set(cur, [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v || 0)) * 255)));
    }
  }
}
