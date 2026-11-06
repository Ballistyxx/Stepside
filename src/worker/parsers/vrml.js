import { Scanner, latin1, isNumStart } from '../scanner.js';
import { GrowF64, GrowU32 } from '../grow.js';

// VRML97 (V2.0) and VRML 1.0 subset: transforms, groups, DEF/USE, Shape +
// IndexedFaceSet (colours/normals/creaseAngle), Box/Sphere/Cylinder/Cone.
// Everything is baked into world space; PROTO/ROUTE/Script are skipped.

const V1_ENUMS = new Set(['value', 'vertexOrdering', 'shapeType', 'faceType', 'parts', 'style']);
const DECL = new Set(['eventIn', 'eventOut', 'field', 'exposedField', 'inputOnly', 'outputOnly', 'initializeOnly', 'inputOutput']);

class Parser extends Scanner {
  constructor(bytes) {
    super(bytes);
    this.defs = new Map();
    this.tmp = new GrowF64(1 << 16);
  }

  skip() {
    const b = this.b, n = this.n;
    let p = this.p;
    for (;;) {
      while (p < n && (b[p] <= 32 || b[p] === 44)) p++;
      if (p < n && b[p] === 35) { const i = b.indexOf(10, p); p = i < 0 ? n : i + 1; continue; }
      break;
    }
    this.p = p;
  }

  peek() { this.skip(); return this.p < this.n ? this.b[this.p] : -1; }

  ident() {
    this.skip();
    const b = this.b, n = this.n, s = this.p;
    let p = s;
    while (p < n) {
      const c = b[p];
      if (c <= 32 || c === 44 || c === 123 || c === 125 || c === 91 || c === 93 || c === 34 || c === 35) break;
      p++;
    }
    this.p = p;
    return latin1(b, s, p);
  }

  string() {
    const b = this.b, n = this.n;
    let p = this.p + 1;
    let out = '';
    let s = p;
    while (p < n && b[p] !== 34) {
      if (b[p] === 92) { out += latin1(b, s, p); p++; s = p; }
      p++;
    }
    out += latin1(b, s, p);
    this.p = p + 1;
    return out;
  }

  skipBalanced() {
    const b = this.b, n = this.n;
    let depth = 0;
    let p = this.p;
    while (p < n) {
      const c = b[p];
      if (c === 34) { this.p = p; this.string(); p = this.p; continue; }
      if (c === 35) { const i = b.indexOf(10, p); p = i < 0 ? n : i + 1; continue; }
      if (c === 123 || c === 91) depth++;
      else if (c === 125 || c === 93) { depth--; if (depth === 0) { p++; break; } }
      p++;
    }
    this.p = p;
  }

  statement() {
    const c = this.peek();
    if (c < 0 || c === 125 || c === 93) return undefined;
    if (c === 123 || c === 91) { this.skipBalanced(); return null; }
    const id = this.ident();
    if (!id) { this.p++; return null; }
    return this.statementFrom(id);
  }

  statementFrom(id) {
    if (id === 'DEF') {
      const name = this.ident();
      const node = this.statementFrom(this.ident());
      if (node) this.defs.set(name, node);
      return node;
    }
    if (id === 'USE') return this.defs.get(this.ident()) || null;
    if (id === 'PROTO') { this.ident(); if (this.peek() === 91) this.skipBalanced(); if (this.peek() === 123) this.skipBalanced(); return null; }
    if (id === 'EXTERNPROTO') {
      this.ident(); if (this.peek() === 91) this.skipBalanced();
      this.fieldValue(); return null;
    }
    if (id === 'ROUTE') { this.ident(); this.ident(); this.ident(); return null; }
    if (id === 'NULL') return null;
    if (id === 'PROFILE' || id === 'COMPONENT' || id === 'META' || id === 'IMPORT' || id === 'EXPORT') {
      // X3D classic header statements: skip to end of line
      this.skipLine(); return null;
    }
    return this.node(id);
  }

  node(type) {
    if (this.peek() !== 123) return null;
    this.p++;
    const node = { type, f: Object.create(null), c: null };
    for (;;) {
      const c = this.peek();
      if (c < 0) break;
      if (c === 125) { this.p++; break; }
      if (c === 91 || c === 123) { this.skipBalanced(); continue; }
      const name = this.ident();
      if (!name) { this.p++; continue; }
      if (name === 'DEF' || name === 'USE') {
        const child = this.statementFrom(name);
        if (child) (node.c ||= []).push(child);
        continue;
      }
      if (DECL.has(name)) {
        this.ident(); const fname = this.ident();
        if (name === 'field' || name === 'exposedField' || name === 'initializeOnly' || name === 'inputOutput') node.f[fname] = this.fieldValue();
        continue;
      }
      if (this.peek() === 123) { // V1-style child node
        const child = this.node(name);
        if (child) (node.c ||= []).push(child);
        continue;
      }
      if (V1_ENUMS.has(name) && !isNumStart(this.peek()) && this.peek() !== 91 && this.peek() !== 34) {
        if (this.peek() === 40) { // ( A | B )
          const e = this.b.indexOf(41, this.p);
          node.f[name] = latin1(this.b, this.p + 1, e < 0 ? this.n : e).trim();
          this.p = e < 0 ? this.n : e + 1;
        } else node.f[name] = this.ident();
        continue;
      }
      node.f[name] = this.fieldValue();
    }
    return node;
  }

  numbers() {
    const t = this.tmp;
    t.n = 0;
    const b = this.b, n = this.n;
    for (;;) {
      // inline skip for speed
      let p = this.p;
      for (;;) {
        while (p < n && (b[p] <= 32 || b[p] === 44)) p++;
        if (p < n && b[p] === 35) { const i = b.indexOf(10, p); p = i < 0 ? n : i + 1; continue; }
        break;
      }
      this.p = p;
      if (p >= n || !isNumStart(b[p])) break;
      t.push(this.readNumber());
    }
    return t.a.slice(0, t.n);
  }

  fieldValue() {
    const c = this.peek();
    if (c === 91) {
      this.p++;
      const c2 = this.peek();
      if (c2 === 93) { this.p++; return []; }
      if (isNumStart(c2)) { const a = this.numbers(); if (this.peek() === 93) this.p++; return a; }
      if (c2 === 34) {
        const out = [];
        while (this.peek() === 34) out.push(this.string());
        if (this.peek() === 93) this.p++;
        return out;
      }
      const out = [];
      for (;;) {
        const s = this.statement();
        if (s === undefined) break;
        if (s) out.push(s);
      }
      if (this.peek() === 93) this.p++;
      return out;
    }
    if (c === 34) return this.string();
    if (isNumStart(c)) { const a = this.numbers(); return a.length === 1 ? a[0] : a; }
    if (c === 123) { this.skipBalanced(); return undefined; }
    if (c < 0 || c === 125) return undefined;
    const save = this.p;
    const id = this.ident();
    if (id === 'TRUE') return true;
    if (id === 'FALSE') return false;
    if (id === 'NULL') return null;
    if (id === 'IS') { this.ident(); return undefined; }
    if (id === 'DEF' || id === 'USE') return this.statementFrom(id);
    if (this.peek() === 123) return this.node(id);
    this.p = save; // not a value; let the caller read it as the next field name
    return undefined;
  }

  parse() {
    const nodes = [];
    while (this.peek() >= 0) {
      const s = this.statement();
      if (s === undefined) { this.p++; continue; }
      if (s) nodes.push(s);
    }
    return nodes;
  }
}

// ---------------------------------------------------------------------------
// 4x4 column-major matrices (Float64)
// ---------------------------------------------------------------------------
const I4 = () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
const T = (x, y, z) => { const m = I4(); m[12] = x; m[13] = y; m[14] = z; return m; };
const S = (x, y, z) => { const m = I4(); m[0] = x; m[5] = y; m[10] = z; return m; };
function R(ax, ay, az, ang) {
  const l = Math.hypot(ax, ay, az);
  if (!l || !ang) return I4();
  const x = ax / l, y = ay / l, z = az / l, c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  return new Float64Array([
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ]);
}
const vec = (v, d) => (v && v.length >= d.length ? v : d);
const num = (v, d) => (typeof v === 'number' ? v : v && v.length ? v[0] : d);

function transformMatrix(f) {
  const t = vec(f.translation, [0, 0, 0]);
  const c = vec(f.center, [0, 0, 0]);
  const r = vec(f.rotation, [0, 0, 1, 0]);
  const s = vec(f.scale || f.scaleFactor, [1, 1, 1]);
  const so = vec(f.scaleOrientation, [0, 0, 1, 0]);
  let m = T(t[0], t[1], t[2]);
  m = mul(m, T(c[0], c[1], c[2]));
  m = mul(m, R(r[0], r[1], r[2], r[3]));
  m = mul(m, R(so[0], so[1], so[2], so[3]));
  m = mul(m, S(s[0], s[1], s[2]));
  m = mul(m, R(so[0], so[1], so[2], -so[3]));
  m = mul(m, T(-c[0], -c[1], -c[2]));
  return m;
}

function normalMatrix(m) {
  // inverse-transpose of upper 3x3
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  return [
    A / det, B / det, C / det,
    -(b * i - c * h) / det, (a * i - c * g) / det, -(a * h - b * g) / det,
    (b * f - c * e) / det, -(a * f - c * d) / det, (a * e - b * d) / det,
  ]; // row-major rows of inverse-transpose applied as n' = M * n
}

function applyPoints(pts, m) {
  const n = (pts.length / 3) | 0;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = pts[3 * i], y = pts[3 * i + 1], z = pts[3 * i + 2];
    out[3 * i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[3 * i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[3 * i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

function applyNormals(nrm, m) {
  const k = normalMatrix(m);
  const out = new Float32Array(nrm.length);
  for (let i = 0; i + 2 < nrm.length; i += 3) {
    const x = nrm[i], y = nrm[i + 1], z = nrm[i + 2];
    const X = k[0] * x + k[1] * y + k[2] * z, Y = k[3] * x + k[4] * y + k[5] * z, Z = k[6] * x + k[7] * y + k[8] * z;
    const l = Math.hypot(X, Y, Z) || 1;
    out[i] = X / l; out[i + 1] = Y / l; out[i + 2] = Z / l;
  }
  return out;
}

const c8 = (v) => (v >= 1 ? 255 : v > 0 ? Math.round(v * 255) : 0);
const rgb = (arr, i) => [c8(arr[3 * i]), c8(arr[3 * i + 1]), c8(arr[3 * i + 2])];

// ---------------------------------------------------------------------------
// Scene extraction
// ---------------------------------------------------------------------------

export function parseVrml(bytes) {
  const head = latin1(bytes, 0, Math.min(64, bytes.length));
  const v1 = /^#VRML V1\.0/.test(head);
  if (!/^#(VRML|X3D)/.test(head)) throw new Error('Not a VRML file (missing #VRML header).');
  const parser = new Parser(bytes);
  parser.skipLine();
  const roots = parser.parse();
  const parts = [];
  const ctx = { parts, depth: 0, v1 };
  const st = {
    m: I4(), coords: null, diffuse: null, binding: 'OVERALL', ccw: true, crease: 0.5,
  };
  if (v1) for (const n of roots) traverseV1(n, st, ctx);
  else for (const n of roots) traverse(n, st.m, ctx);
  return parts;
}

function children(node) {
  const f = node.f;
  const out = [];
  for (const k of ['children', 'choice', 'level']) if (Array.isArray(f[k])) out.push(...f[k].filter((x) => x && x.type));
  if (node.c) out.push(...node.c);
  return out;
}

function traverse(node, m, ctx) {
  if (!node || !node.type || ctx.depth > 256) return;
  ctx.depth++;
  const f = node.f;
  switch (node.type) {
    case 'Transform': {
      const mm = mul(m, transformMatrix(f));
      for (const ch of children(node)) traverse(ch, mm, ctx);
      break;
    }
    case 'Switch': {
      const list = Array.isArray(f.choice) ? f.choice : Array.isArray(f.children) ? f.children : [];
      const w = num(f.whichChoice, -1);
      if (w >= 0 && list[w]) traverse(list[w], m, ctx);
      break;
    }
    case 'LOD': {
      const list = Array.isArray(f.level) ? f.level : Array.isArray(f.children) ? f.children : [];
      if (list[0]) traverse(list[0], m, ctx);
      break;
    }
    case 'Shape':
      shape(node, m, ctx);
      break;
    default:
      for (const ch of children(node)) traverse(ch, m, ctx);
  }
  ctx.depth--;
}

function shape(node, m, ctx) {
  const geo = node.f.geometry;
  if (!geo || !geo.type) return;
  const app = node.f.appearance;
  const mat = app && app.f && app.f.material;
  let color = [204, 204, 204];
  if (mat && mat.f) {
    const d = mat.f.diffuseColor;
    if (d && d.length >= 3) color = rgb(d, 0);
    else if (mat.f.emissiveColor && mat.f.emissiveColor.length >= 3) color = rgb(mat.f.emissiveColor, 0);
  }
  const g = geo.f;
  if (geo.type === 'IndexedFaceSet') {
    const coord = g.coord && g.coord.f && g.coord.f.point;
    if (!coord || !coord.length || !g.coordIndex || !g.coordIndex.length) return;
    const colorNode = g.color && g.color.f && g.color.f.color;
    const normalNode = g.normal && g.normal.f && g.normal.f.vector;
    ctx.parts.push(faceSet({
      m, coord, coordIndex: g.coordIndex, ccw: g.ccw !== false,
      crease: num(g.creaseAngle, 0),
      colors: colorNode && colorNode.length ? colorNode : null,
      colorIndex: g.colorIndex, colorPerVertex: g.colorPerVertex !== false,
      normals: normalNode && normalNode.length ? normalNode : null,
      normalIndex: g.normalIndex, normalPerVertex: g.normalPerVertex !== false,
      color,
    }));
  } else {
    const prim = primitive(geo.type, g);
    if (prim) ctx.parts.push(bakePrim(prim, m, color));
  }
}

/** Build a part from an indexed face set. */
function faceSet(o) {
  const ci = o.coordIndex;
  const nv = (o.coord.length / 3) | 0;
  const tris = new GrowU32(ci.length * 2);
  const polyOf = new GrowU32(ci.length); // triangle -> polygon index
  const cornerPos = new GrowU32(ci.length * 2); // triangle corner -> position in coordIndex
  let start = 0, poly = 0;
  for (let i = 0; i <= ci.length; i++) {
    if (i === ci.length || ci[i] < 0) {
      const n = i - start;
      for (let j = 1; j + 1 < n; j++) {
        const a = start, b = start + j, c = start + j + 1;
        if (ci[a] < nv && ci[b] < nv && ci[c] < nv) {
          if (o.ccw) { tris.push3(ci[a], ci[b], ci[c]); cornerPos.push3(a, b, c); }
          else { tris.push3(ci[a], ci[c], ci[b]); cornerPos.push3(a, c, b); }
          polyOf.push(poly);
        }
      }
      start = i + 1;
      poly++;
    }
  }
  const index = tris.trim();
  const nt = index.length / 3;
  const cpos = cornerPos.a, pof = polyOf.a;
  const part = {
    position: applyPoints(o.coord, o.m), index, color: o.color, crease: o.crease,
    normal: null, vertexColor: null, cornerColor: null, faceColor: null,
  };
  if (o.colors) {
    const cols = o.colors, ncol = (cols.length / 3) | 0;
    const cidx = o.colorIndex && o.colorIndex.length ? o.colorIndex : null;
    if (o.colorPerVertex) {
      if (cidx) {
        const cc = new Uint8Array(nt * 9);
        for (let k = 0; k < nt * 3; k++) {
          const ix = cidx[cpos[k]];
          const c = ix >= 0 && ix < ncol ? rgb(cols, ix) : o.color;
          cc[3 * k] = c[0]; cc[3 * k + 1] = c[1]; cc[3 * k + 2] = c[2];
        }
        part.cornerColor = cc;
      } else {
        const vc = new Uint8Array(nv * 3);
        for (let v = 0; v < nv; v++) {
          const c = v < ncol ? rgb(cols, v) : o.color;
          vc[3 * v] = c[0]; vc[3 * v + 1] = c[1]; vc[3 * v + 2] = c[2];
        }
        part.vertexColor = vc;
      }
    } else {
      const fc = new Uint8Array(nt * 3);
      for (let t = 0; t < nt; t++) {
        const p = pof[t];
        const ix = cidx ? cidx[p] : p;
        const c = ix >= 0 && ix < ncol ? rgb(cols, ix) : o.color;
        fc[3 * t] = c[0]; fc[3 * t + 1] = c[1]; fc[3 * t + 2] = c[2];
      }
      part.faceColor = fc;
    }
  }
  if (o.normals && o.normalPerVertex && !(o.normalIndex && o.normalIndex.length) && o.normals.length >= nv * 3) {
    part.normal = applyNormals(o.normals.subarray ? o.normals.subarray(0, nv * 3) : o.normals.slice(0, nv * 3), o.m);
  }
  return part;
}

// --- primitives -----------------------------------------------------------

function primitive(type, g) {
  switch (type) {
    case 'Box': { const s = vec(g.size, [2, 2, 2]); return box(s[0] / 2, s[1] / 2, s[2] / 2); }
    case 'Cube': return box(num(g.width, 2) / 2, num(g.height, 2) / 2, num(g.depth, 2) / 2);
    case 'Sphere': return sphere(num(g.radius, 1));
    case 'Cylinder': return cylinder(num(g.radius, 1), num(g.radius, 1), num(g.height, 2), g.top !== false, g.bottom !== false, g.side !== false);
    case 'Cone': return cylinder(num(g.bottomRadius, 1), 0, num(g.height, 2), false, g.bottom !== false, g.side !== false);
    default: return null;
  }
}

function box(x, y, z) {
  const P = [], N = [], I = [];
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = P.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      P.push((n[0] + su * u[0] + sv * v[0]) * x, (n[1] + su * u[1] + sv * v[1]) * y, (n[2] + su * u[2] + sv * v[2]) * z);
      N.push(...n);
    }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { P, N, I };
}

function sphere(r) {
  const P = [], N = [], I = [], W = 32, H = 16;
  for (let j = 0; j <= H; j++) {
    const th = (j / H) * Math.PI;
    for (let i = 0; i <= W; i++) {
      const ph = (i / W) * Math.PI * 2;
      const x = Math.sin(th) * Math.sin(ph), y = Math.cos(th), z = Math.sin(th) * Math.cos(ph);
      P.push(x * r, y * r, z * r); N.push(x, y, z);
    }
  }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const a = j * (W + 1) + i, b = a + W + 1;
    I.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { P, N, I };
}

function cylinder(rb, rt, h, top, bottom, side) {
  const P = [], N = [], I = [], W = 32, hy = h / 2;
  const slope = (rb - rt) / h;
  if (side) {
    for (let i = 0; i <= W; i++) {
      const a = (i / W) * Math.PI * 2, s = Math.sin(a), c = Math.cos(a);
      const l = Math.hypot(1, slope);
      P.push(rt * s, hy, rt * c); N.push(s / l, slope / l, c / l);
      P.push(rb * s, -hy, rb * c); N.push(s / l, slope / l, c / l);
    }
    for (let i = 0; i < W; i++) { const a = 2 * i; I.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
  }
  const cap = (r, y, ny) => {
    if (r <= 0) return;
    const base = P.length / 3;
    P.push(0, y, 0); N.push(0, ny, 0);
    for (let i = 0; i <= W; i++) { const a = (i / W) * Math.PI * 2; P.push(r * Math.sin(a), y, r * Math.cos(a)); N.push(0, ny, 0); }
    for (let i = 0; i < W; i++) ny > 0 ? I.push(base, base + 1 + i, base + 2 + i) : I.push(base, base + 2 + i, base + 1 + i);
  };
  if (top) cap(rt, hy, 1);
  if (bottom) cap(rb, -hy, -1);
  return { P, N, I };
}

function bakePrim({ P, N, I }, m, color) {
  return {
    position: applyPoints(P, m), normal: applyNormals(N, m), index: Uint32Array.from(I), color,
  };
}

// --- VRML 1.0 -------------------------------------------------------------

function traverseV1(node, st, ctx) {
  if (!node || !node.type || ctx.depth > 256) return;
  ctx.depth++;
  const f = node.f;
  switch (node.type) {
    case 'Separator': case 'TransformSeparator': case 'WWWAnchor': {
      const local = { ...st };
      if (node.type === 'TransformSeparator') local.m = st.m;
      for (const ch of node.c || []) traverseV1(ch, local, ctx);
      if (node.type === 'TransformSeparator') { /* only transform is restored */ }
      break;
    }
    case 'Group': case 'Switch': case 'LOD':
      if (node.type === 'Switch') {
        const w = num(f.whichChild, -1);
        const list = node.c || [];
        if (w === -3) for (const ch of list) traverseV1(ch, st, ctx);
        else if (w >= 0 && list[w]) traverseV1(list[w], st, ctx);
      } else if (node.type === 'LOD') { if (node.c && node.c[0]) traverseV1(node.c[0], st, ctx); }
      else for (const ch of node.c || []) traverseV1(ch, st, ctx);
      break;
    case 'Transform': st.m = mul(st.m, transformMatrix(f)); break;
    case 'Translation': { const t = vec(f.translation, [0, 0, 0]); st.m = mul(st.m, T(t[0], t[1], t[2])); break; }
    case 'Rotation': { const r = vec(f.rotation, [0, 0, 1, 0]); st.m = mul(st.m, R(r[0], r[1], r[2], r[3])); break; }
    case 'Scale': { const s = vec(f.scaleFactor, [1, 1, 1]); st.m = mul(st.m, S(s[0], s[1], s[2])); break; }
    case 'MatrixTransform': {
      const a = f.matrix;
      if (a && a.length === 16) st.m = mul(st.m, Float64Array.from(a)); // V1 row-major == our column-major layout
      break;
    }
    case 'Coordinate3': st.coords = f.point || null; break;
    case 'Material': st.diffuse = f.diffuseColor && f.diffuseColor.length >= 3 ? f.diffuseColor : null; break;
    case 'MaterialBinding': st.binding = String(f.value || 'OVERALL'); break;
    case 'ShapeHints':
      st.ccw = f.vertexOrdering !== 'CLOCKWISE';
      st.crease = num(f.creaseAngle, 0.5);
      break;
    case 'IndexedFaceSet': {
      if (!st.coords || !f.coordIndex || !f.coordIndex.length) break;
      const color = st.diffuse ? rgb(st.diffuse, 0) : [204, 204, 204];
      const b = st.binding;
      let colors = null, colorIndex = null, perVertex = true;
      if (st.diffuse && st.diffuse.length > 3 && b !== 'OVERALL' && b !== 'DEFAULT') {
        colors = st.diffuse;
        perVertex = b.startsWith('PER_VERTEX');
        if (b.endsWith('INDEXED')) colorIndex = f.materialIndex && f.materialIndex.length ? f.materialIndex : null;
        else if (perVertex) {
          // PER_VERTEX: material per coordIndex entry (skipping -1)
          colorIndex = [];
          let k = 0;
          for (const v of f.coordIndex) colorIndex.push(v < 0 ? -1 : k++);
        }
      }
      ctx.parts.push(faceSet({
        m: st.m, coord: st.coords, coordIndex: f.coordIndex, ccw: st.ccw, crease: st.crease,
        colors, colorIndex, colorPerVertex: perVertex, normals: null, color,
      }));
      break;
    }
    case 'Cube': case 'Sphere': case 'Cylinder': case 'Cone': {
      const prim = primitive(node.type, f);
      if (prim) ctx.parts.push(bakePrim(prim, st.m, st.diffuse ? rgb(st.diffuse, 0) : [204, 204, 204]));
      break;
    }
    default:
      for (const ch of node.c || []) traverseV1(ch, st, ctx);
  }
  ctx.depth--;
}
