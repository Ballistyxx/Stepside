// Shared mesh pipeline: normals, de-indexing, merging, centering, feature edges.
//
// Parsers emit "parts":
//   position     Float32Array  nv*3
//   index        Uint32Array | null   nt*3 (null => non-indexed triangle soup)
//   normal       Float32Array | null  per vertex
//   vertexColor  Uint8Array | null    per vertex sRGB
//   cornerColor  Uint8Array | null    per triangle corner sRGB (nt*9)
//   faceColor    Uint8Array | null    per triangle sRGB (nt*3)
//   color        [r,g,b] sRGB 0..255 | null (uniform)
//   faceGroup    Uint32Array | null   per triangle id (B-rep face) for CAD edges
//   crease       radians; normals are creased at this angle when computed
//   points       true for point clouds (position + optional vertexColor only)
//
// finalize() turns a part list into ONE geometry (one draw call) with Int16
// normals and Uint8 linear-space colours, centred at the origin.

export const DEFAULT_COLOR = [196, 200, 206];
/** faceGroup value meaning "no B-rep face info here: use the dihedral angle". */
export const ANGLE_GROUP = 0xffffffff;
const CREASE_LIMIT = 2_500_000; // above this many triangles, use cheap smooth normals
const EDGE_LIMIT = 6_000_000;

const SRGB_TO_LINEAR = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  const l = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  SRGB_TO_LINEAR[i] = Math.round(l * 255);
}

export function triCount(p) {
  return p.index ? p.index.length / 3 : p.position.length / 9;
}

/** Area-weighted face normals (unnormalised cross products). */
function faceNormals(pos, idx, nt) {
  const fn = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    let a, b, c;
    if (idx) { a = idx[3 * t] * 3; b = idx[3 * t + 1] * 3; c = idx[3 * t + 2] * 3; }
    else { a = 9 * t; b = a + 3; c = a + 6; }
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    fn[3 * t] = uy * vz - uz * vy;
    fn[3 * t + 1] = uz * vx - ux * vz;
    fn[3 * t + 2] = ux * vy - uy * vx;
  }
  return fn;
}

function unitize(src) {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    const l = Math.hypot(x, y, z);
    if (l > 0) { out[i] = x / l; out[i + 1] = y / l; out[i + 2] = z / l; }
  }
  return out;
}

export function smoothNormals(pos, idx) {
  const nv = pos.length / 3, nt = idx.length / 3;
  const fn = faceNormals(pos, idx, nt);
  const vn = new Float32Array(nv * 3);
  for (let t = 0; t < nt; t++) {
    const x = fn[3 * t], y = fn[3 * t + 1], z = fn[3 * t + 2];
    for (let k = 0; k < 3; k++) {
      const v = idx[3 * t + k] * 3;
      vn[v] += x; vn[v + 1] += y; vn[v + 2] += z;
    }
  }
  return unitize(vn);
}

/** Per-corner normals that average only across faces within `crease` radians. */
function creasedCornerNormals(pos, idx, crease) {
  const nv = pos.length / 3, nt = idx.length / 3;
  const fn = faceNormals(pos, idx, nt);
  const out = new Float32Array(nt * 9);
  if (crease <= 0) {
    const un = unitize(fn);
    for (let t = 0; t < nt; t++) {
      for (let k = 0; k < 3; k++) {
        out[9 * t + 3 * k] = un[3 * t];
        out[9 * t + 3 * k + 1] = un[3 * t + 1];
        out[9 * t + 3 * k + 2] = un[3 * t + 2];
      }
    }
    return out;
  }
  const un = unitize(fn);
  const cosT = Math.cos(crease);
  // vertex -> triangles (CSR)
  const off = new Int32Array(nv + 1);
  for (let i = 0; i < idx.length; i++) off[idx[i] + 1]++;
  for (let v = 0; v < nv; v++) off[v + 1] += off[v];
  const cur = off.slice(0, nv);
  const adj = new Int32Array(idx.length);
  for (let i = 0; i < idx.length; i++) adj[cur[idx[i]]++] = (i / 3) | 0;

  for (let t = 0; t < nt; t++) {
    const tx = un[3 * t], ty = un[3 * t + 1], tz = un[3 * t + 2];
    for (let k = 0; k < 3; k++) {
      const v = idx[3 * t + k];
      let sx = 0, sy = 0, sz = 0;
      for (let j = off[v], e = off[v + 1]; j < e; j++) {
        const u = adj[j] * 3;
        if (tx * un[u] + ty * un[u + 1] + tz * un[u + 2] >= cosT) {
          sx += fn[u]; sy += fn[u + 1]; sz += fn[u + 2];
        }
      }
      const l = Math.hypot(sx, sy, sz);
      const o = 9 * t + 3 * k;
      if (l > 0) { out[o] = sx / l; out[o + 1] = sy / l; out[o + 2] = sz / l; }
      else { out[o] = tx; out[o + 1] = ty; out[o + 2] = tz || (tx || ty ? 0 : 1); }
    }
  }
  return out;
}

/** Normalise one part into {position, normal, color|null, index|null, faceGroup, uniform}. */
function processPart(p) {
  const nt = triCount(p);
  const crease = p.crease ?? (40 * Math.PI) / 180;
  const perCorner = !!(p.cornerColor || p.faceColor) ||
    (!p.normal && p.index && nt <= CREASE_LIMIT);

  if (!perCorner) {
    let normal = p.normal;
    if (!normal) {
      if (p.index) normal = smoothNormals(p.position, p.index);
      else normal = creasedCornerNormals(p.position, identity(p.position.length / 3), 0);
    }
    return {
      position: p.position, normal, index: p.index,
      color: p.vertexColor || null, uniform: p.color || DEFAULT_COLOR,
      faceGroup: p.faceGroup || null, nt,
    };
  }

  // De-index: every triangle corner gets its own vertex.
  const idx = p.index || identity(p.position.length / 3);
  const pos = p.position;
  const position = new Float32Array(nt * 9);
  for (let i = 0; i < nt * 3; i++) {
    const v = idx[i] * 3;
    position[3 * i] = pos[v]; position[3 * i + 1] = pos[v + 1]; position[3 * i + 2] = pos[v + 2];
  }
  let normal;
  if (p.normal) {
    normal = new Float32Array(nt * 9);
    const n = p.normal;
    for (let i = 0; i < nt * 3; i++) {
      const v = idx[i] * 3;
      normal[3 * i] = n[v]; normal[3 * i + 1] = n[v + 1]; normal[3 * i + 2] = n[v + 2];
    }
  } else {
    normal = creasedCornerNormals(pos, idx, crease);
  }
  let color = null;
  if (p.cornerColor) color = p.cornerColor;
  else if (p.faceColor) {
    color = new Uint8Array(nt * 9);
    const f = p.faceColor;
    for (let t = 0; t < nt; t++) {
      const r = f[3 * t], g = f[3 * t + 1], b = f[3 * t + 2];
      for (let k = 0; k < 3; k++) { const o = 9 * t + 3 * k; color[o] = r; color[o + 1] = g; color[o + 2] = b; }
    }
  } else if (p.vertexColor) {
    color = new Uint8Array(nt * 9);
    const vc = p.vertexColor;
    for (let i = 0; i < nt * 3; i++) {
      const v = idx[i] * 3;
      color[3 * i] = vc[v]; color[3 * i + 1] = vc[v + 1]; color[3 * i + 2] = vc[v + 2];
    }
  }
  return {
    position, normal, index: null, color, uniform: p.color || DEFAULT_COLOR,
    faceGroup: p.faceGroup || null, nt,
  };
}

function identity(n) {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

function sameColor(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function bounds(pos) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (x0 > x1) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}

function centre(pos) {
  const { min, max } = bounds(pos);
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
  for (let i = 0; i < pos.length; i += 3) { pos[i] -= cx; pos[i + 1] -= cy; pos[i + 2] -= cz; }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { center: [cx, cy, cz], size, radius: Math.hypot(size[0], size[1], size[2]) / 2 };
}

export function toInt16Normals(n) {
  const out = new Int16Array(n.length);
  for (let i = 0; i < n.length; i++) {
    const v = n[i];
    out[i] = v >= 1 ? 32767 : v <= -1 ? -32767 : Math.round(v * 32767);
  }
  return out;
}

export function linearize(c) {
  for (let i = 0; i < c.length; i++) c[i] = SRGB_TO_LINEAR[c[i]];
  return c;
}

/**
 * Merge parts into a single renderable mesh message.
 * Returns { mesh, transfer, edgeInput } — edgeInput (copies) is for featureEdges
 * after the mesh has been posted so first paint isn't delayed.
 */
export function finalize(parts, { wantEdges = true, edgeAngle = 30 } = {}) {
  parts = parts.filter((p) => p && p.position && p.position.length >= 3);
  if (!parts.length) throw new Error('The file contains no renderable geometry.');

  const pointParts = parts.filter((p) => p.points);
  const meshParts = parts.filter((p) => !p.points && triCount(p) > 0);
  if (!meshParts.length) return finalizePoints(pointParts.length ? pointParts : parts);

  const procs = meshParts.map(processPart);
  let nv = 0, nt = 0;
  for (const q of procs) { nv += q.position.length / 3; nt += q.nt; }

  const position = new Float32Array(nv * 3);
  const normalF = new Float32Array(nv * 3);
  const allUniform = procs.every((q) => !q.color);
  const oneColor = allUniform && procs.every((q) => sameColor(q.uniform, procs[0].uniform));
  const color = oneColor ? null : new Uint8Array(nv * 3);
  // Always indexed: the viewer keeps only the index on the CPU (for wireframe).
  const IndexCtor = nv <= 65535 ? Uint16Array : Uint32Array;
  const index = new IndexCtor(nt * 3);
  const anyGroups = procs.some((q) => q.faceGroup);
  const faceGroup = anyGroups && wantEdges ? new Uint32Array(nt) : null;

  let vo = 0, io = 0, to = 0, go = 0;
  const partRanges = [];
  for (const q of procs) {
    partRanges.push([to, q.nt]);
    const qnv = q.position.length / 3;
    position.set(q.position, vo * 3);
    normalF.set(q.normal, vo * 3);
    if (color) {
      if (q.color) color.set(q.color, vo * 3);
      else {
        const [r, g, b] = q.uniform;
        for (let i = vo * 3, e = (vo + qnv) * 3; i < e; i += 3) { color[i] = r; color[i + 1] = g; color[i + 2] = b; }
      }
    }
    if (index) {
      if (q.index) for (let i = 0; i < q.index.length; i++) index[io + i] = q.index[i] + vo;
      else for (let i = 0; i < qnv; i++) index[io + i] = vo + i;
      io += q.nt * 3;
    }
    if (faceGroup) {
      let maxG = 0;
      if (q.faceGroup) {
        for (let t = 0; t < q.nt; t++) {
          const g = q.faceGroup[t];
          if (g === ANGLE_GROUP) { faceGroup[to + t] = ANGLE_GROUP; continue; }
          faceGroup[to + t] = g + go;
          if (g > maxG) maxG = g;
        }
      } else faceGroup.fill(ANGLE_GROUP, to, to + q.nt);
      go += maxG + 1;
    }
    vo += qnv;
    to += q.nt;
  }

  const box = centre(position);
  const tree = buildTree(meshParts, partRanges, position, index);
  const mesh = {
    type: 'mesh',
    tree: tree ? tree.nodes : null,
    treeBounds: tree ? tree.bounds : null,
    position,
    normal: toInt16Normals(normalF),
    color: color ? linearize(color) : null,
    uniformColor: oneColor ? procs[0].uniform : null,
    index,
    triangles: nt,
    vertices: nv,
    ...box,
  };
  const transfer = [position.buffer, mesh.normal.buffer];
  if (mesh.color) transfer.push(mesh.color.buffer);
  transfer.push(index.buffer);
  if (tree) transfer.push(tree.bounds.buffer);

  let edgeInput = null;
  if (wantEdges && nt <= EDGE_LIMIT) {
    edgeInput = { position: position.slice(), index: index.slice(), faceGroup, edgeAngle };
  }
  return { mesh, transfer, edgeInput };
}

/**
 * Model tree with absolute triangle ranges [start, count] and a bounding box
 * per node (in the centred frame). CAD parts bring their own assembly tree;
 * other formats get one node per named part when there is more than one.
 */
function buildTree(parts, ranges, position, index) {
  let nodes = null;
  if (parts.length === 1 && parts[0].tree) nodes = parts[0].tree.map((n) => ({ ...n }));
  else if (parts.length > 1 && parts.some((p) => p.name)) {
    nodes = parts.map((p, i) => ({ name: p.name || `Part ${i + 1}`, depth: 0, start: ranges[i][0], count: ranges[i][1] }));
  } else if (parts.length === 1 && parts[0].groups && parts[0].groups.length > 1) {
    nodes = parts[0].groups.map((g) => ({ name: g.name, depth: 0, start: g.start, count: g.count }));
  }
  if (!nodes || !nodes.length) return null;
  const bounds = new Float32Array(nodes.length * 6);
  for (let k = 0; k < nodes.length; k++) {
    const { start, count } = nodes[k];
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = start * 3, e = (start + count) * 3; i < e; i++) {
      const v = index[i] * 3, x = position[v], y = position[v + 1], z = position[v + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    if (x0 > x1) x0 = y0 = z0 = x1 = y1 = z1 = 0;
    bounds.set([x0, y0, z0, x1, y1, z1], k * 6);
  }
  return { nodes, bounds };
}

function finalizePoints(parts) {
  let nv = 0;
  for (const p of parts) nv += p.position.length / 3;
  const position = new Float32Array(nv * 3);
  const anyColor = parts.some((p) => p.vertexColor);
  const color = anyColor ? new Uint8Array(nv * 3) : null;
  let vo = 0;
  for (const p of parts) {
    const n = p.position.length / 3;
    position.set(p.position, vo * 3);
    if (color) {
      if (p.vertexColor) color.set(p.vertexColor.subarray(0, n * 3), vo * 3);
      else color.fill(200, vo * 3, (vo + n) * 3);
    }
    vo += n;
  }
  const box = centre(position);
  const mesh = {
    type: 'points', position, color: color ? linearize(color) : null,
    uniformColor: color ? null : (parts[0].color || DEFAULT_COLOR),
    vertices: nv, triangles: 0, ...box,
  };
  const transfer = [position.buffer];
  if (color) transfer.push(color.buffer);
  return { mesh, transfer, edgeInput: null };
}

// ---------------------------------------------------------------------------
// Feature edges
// ---------------------------------------------------------------------------

function nextPow2(n) {
  let p = 16;
  while (p < n) p *= 2;
  return p;
}

/** Weld coincident vertices. Returns {id: Int32Array(nv), rep: Int32Array(count)}. */
function weld(pos) {
  const nv = pos.length / 3;
  const { min, max } = bounds(pos);
  const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const inv = 1 / (ext * 1e-6);
  const cap = nextPow2(nv * 2), mask = cap - 1;
  const slot = new Int32Array(cap).fill(-1); // -> canonical id
  const qx = new Int32Array(nv), qy = new Int32Array(nv), qz = new Int32Array(nv);
  const rep = new Int32Array(nv);
  const id = new Int32Array(nv);
  let count = 0;
  for (let v = 0; v < nv; v++) {
    const x = Math.round(pos[3 * v] * inv), y = Math.round(pos[3 * v + 1] * inv), z = Math.round(pos[3 * v + 2] * inv);
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
    for (;;) {
      const s = slot[h];
      if (s === -1) {
        slot[h] = count; qx[count] = x; qy[count] = y; qz[count] = z; rep[count] = v; id[v] = count++;
        break;
      }
      if (qx[s] === x && qy[s] === y && qz[s] === z) { id[v] = s; break; }
      h = (h + 1) & mask;
    }
  }
  return { id, rep: rep.subarray(0, count), count };
}

/**
 * Edges between triangles of different groups (CAD B-rep faces), or whose
 * dihedral angle exceeds `edgeAngle`, plus open boundaries.
 */
export function featureEdges({ position, index, faceGroup, edgeAngle = 30 }) {
  const nv = position.length / 3;
  const nt = index ? index.length / 3 : nv / 3;
  const { id, rep } = weld(position);
  const un = unitize(faceNormals(position, index, nt));
  const cosT = Math.cos((edgeAngle * Math.PI) / 180);

  const cap = nextPow2(nt * 3), mask = cap - 1;
  const ka = new Int32Array(cap).fill(-1), kb = new Int32Array(cap);
  const t1 = new Int32Array(cap), t2 = new Int32Array(cap);
  const used = new Int32Array(Math.min(cap, nt * 3));
  let nused = 0;

  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const i0 = index ? index[3 * t + k] : 3 * t + k;
      const i1 = index ? index[3 * t + ((k + 1) % 3)] : 3 * t + ((k + 1) % 3);
      let a = id[i0], b = id[i1];
      if (a === b) continue;
      if (a > b) { const tmp = a; a = b; b = tmp; }
      let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) & mask;
      for (;;) {
        const s = ka[h];
        if (s === -1) { ka[h] = a; kb[h] = b; t1[h] = t; t2[h] = -1; used[nused++] = h; break; }
        if (s === a && kb[h] === b) { t2[h] = t2[h] === -1 ? t : -2; break; }
        h = (h + 1) & mask;
      }
    }
  }

  let ne = 0;
  const keep = new Uint8Array(nused);
  for (let i = 0; i < nused; i++) {
    const h = used[i], u = t1[h], w = t2[h];
    let k;
    if (w < 0) k = true; // boundary or non-manifold
    else if (faceGroup && faceGroup[u] !== ANGLE_GROUP && faceGroup[w] !== ANGLE_GROUP) k = faceGroup[u] !== faceGroup[w];
    else {
      const nu = 3 * u, nw = 3 * w;
      const d = un[nu] * un[nw] + un[nu + 1] * un[nw + 1] + un[nu + 2] * un[nw + 2];
      const zero = (un[nu] === 0 && un[nu + 1] === 0 && un[nu + 2] === 0) || (un[nw] === 0 && un[nw + 1] === 0 && un[nw + 2] === 0);
      k = !zero && d < cosT;
    }
    if (k) { keep[i] = 1; ne++; }
  }
  const out = new Float32Array(ne * 6);
  // Source triangle of each segment. Slots were appended in triangle order, so
  // this is ascending: the edges of any triangle range form a contiguous run.
  const tri = new Uint32Array(ne);
  let o = 0, e = 0;
  for (let i = 0; i < nused; i++) {
    if (!keep[i]) continue;
    const h = used[i];
    tri[e++] = t1[h];
    const a = rep[ka[h]] * 3, b = rep[kb[h]] * 3;
    out[o++] = position[a]; out[o++] = position[a + 1]; out[o++] = position[a + 2];
    out[o++] = position[b]; out[o++] = position[b + 1]; out[o++] = position[b + 2];
  }
  return { positions: out, tri };
}
