import { Scanner, latin1 } from '../scanner.js';
import { GrowU32, GrowU8 } from '../grow.js';

/** Stanford PLY: ascii, binary_little_endian, binary_big_endian. Faces optional (point cloud). */
export function parsePly(bytes) {
  const end = findHeaderEnd(bytes);
  if (end < 0) throw new Error('Not a PLY file (no end_header).');
  const header = latin1(bytes, 0, end).split(/\r?\n/);
  let format = 'ascii';
  const elements = [];
  for (const line of header) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') elements.push({ name: t[1], count: parseInt(t[2], 10) || 0, props: [] });
    else if (t[0] === 'property' && elements.length) {
      const el = elements[elements.length - 1];
      if (t[1] === 'list') el.props.push({ list: true, countType: t[2], type: t[3], name: t[4] });
      else el.props.push({ list: false, type: t[1], name: t[2] });
    }
  }
  let body = end;
  // skip the newline after end_header
  while (body < bytes.length && bytes[body] !== 10) body++;
  body++;

  const vEl = elements.find((e) => e.name === 'vertex');
  if (!vEl) throw new Error('PLY has no vertex element.');
  const nv = vEl.count;
  const position = new Float32Array(nv * 3);
  const vp = roles(vEl.props);
  const hasNormal = vp.nx >= 0 && vp.ny >= 0 && vp.nz >= 0;
  const hasColor = vp.r >= 0 && vp.g >= 0 && vp.b >= 0;
  const normal = hasNormal ? new Float32Array(nv * 3) : null;
  const vertexColor = hasColor ? new Uint8Array(nv * 3) : null;
  const colorScale = hasColor ? (isFloat(vEl.props[vp.r].type) ? 255 : isShort(vEl.props[vp.r].type) ? 1 / 257 : 1) : 1;

  const index = new GrowU32(1 << 16);
  let faceColor = null;
  const fcol = new GrowU8(0);

  const reader = format === 'ascii' ? new AsciiReader(bytes, body)
    : new BinReader(bytes, body, format === 'binary_little_endian');
  const row = new Float64Array(64);
  const poly = new Uint32Array(1024);

  for (const el of elements) {
    const isV = el === vEl;
    const isF = el.name === 'face';
    const fp = isF ? faceRoles(el.props) : null;
    if (isF && fp.r >= 0) faceColor = true;
    for (let i = 0; i < el.count; i++) {
      if (isV) {
        for (let k = 0; k < el.props.length; k++) {
          const pr = el.props[k];
          if (pr.list) { const c = reader.read(pr.countType); for (let j = 0; j < c; j++) reader.read(pr.type); row[k] = 0; }
          else row[k] = reader.read(pr.type);
        }
        position[3 * i] = row[vp.x]; position[3 * i + 1] = row[vp.y]; position[3 * i + 2] = row[vp.z];
        if (normal) { normal[3 * i] = row[vp.nx]; normal[3 * i + 1] = row[vp.ny]; normal[3 * i + 2] = row[vp.nz]; }
        if (vertexColor) {
          vertexColor[3 * i] = c8(row[vp.r] * colorScale);
          vertexColor[3 * i + 1] = c8(row[vp.g] * colorScale);
          vertexColor[3 * i + 2] = c8(row[vp.b] * colorScale);
        }
      } else if (isF) {
        let k = 0;
        let r = 200, g = 200, bl = 200;
        for (let q = 0; q < el.props.length; q++) {
          const pr = el.props[q];
          if (pr.list) {
            const c = reader.read(pr.countType);
            if (q === fp.list) {
              for (let j = 0; j < c; j++) { const v = reader.read(pr.type); if (k < 1024) poly[k++] = v; }
            } else for (let j = 0; j < c; j++) reader.read(pr.type);
          } else {
            const v = reader.read(pr.type);
            const s = isFloat(pr.type) ? 255 : 1;
            if (q === fp.r) r = c8(v * s); else if (q === fp.g) g = c8(v * s); else if (q === fp.b) bl = c8(v * s);
          }
        }
        for (let j = 1; j + 1 < k; j++) {
          const a = poly[0], b2 = poly[j], c = poly[j + 1];
          if (a < nv && b2 < nv && c < nv) {
            index.push3(a, b2, c);
            if (faceColor) fcol.push3(r, g, bl);
          }
        }
      } else {
        for (const pr of el.props) {
          if (pr.list) { const c = reader.read(pr.countType); for (let j = 0; j < c; j++) reader.read(pr.type); }
          else reader.read(pr.type);
        }
      }
    }
  }

  if (index.n === 0) return [{ points: true, position, vertexColor }];
  if (normal) normalizeInPlace(normal);
  return [{
    position, index: index.trim(), normal,
    vertexColor, faceColor: faceColor ? fcol.trim() : null,
  }];
}

function findHeaderEnd(b) {
  const lim = Math.min(b.length, 1 << 20);
  const pat = [101, 110, 100, 95, 104, 101, 97, 100, 101, 114]; // end_header
  outer: for (let i = 0; i < lim - pat.length; i++) {
    for (let j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
    return i + pat.length;
  }
  return -1;
}

function roles(props) {
  const f = (...names) => props.findIndex((p) => !p.list && names.includes(p.name));
  return {
    x: f('x'), y: f('y'), z: f('z'),
    nx: f('nx', 'normal_x'), ny: f('ny', 'normal_y'), nz: f('nz', 'normal_z'),
    r: f('red', 'r', 'diffuse_red'), g: f('green', 'g', 'diffuse_green'), b: f('blue', 'b', 'diffuse_blue'),
  };
}

function faceRoles(props) {
  let list = props.findIndex((p) => p.list && (p.name === 'vertex_indices' || p.name === 'vertex_index'));
  if (list < 0) list = props.findIndex((p) => p.list);
  const f = (...names) => props.findIndex((p) => !p.list && names.includes(p.name));
  return { list, r: f('red', 'r'), g: f('green', 'g'), b: f('blue', 'b') };
}

const isFloat = (t) => t === 'float' || t === 'double' || t === 'float32' || t === 'float64';
const isShort = (t) => t === 'ushort' || t === 'uint16';
const c8 = (v) => (v > 255 ? 255 : v > 0 ? Math.round(v) : 0);

function normalizeInPlace(n) {
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l > 0) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  }
}

class AsciiReader {
  constructor(bytes, p) { this.s = new Scanner(bytes, p); }
  read() {
    const s = this.s;
    s.skipWs();
    if (s.p >= s.n) throw new Error('PLY body ended early.');
    return s.readNumber();
  }
}

const SIZES = {
  char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

class BinReader {
  constructor(bytes, p, le) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = p;
    this.le = le;
  }
  read(type) {
    const dv = this.dv, p = this.p, le = this.le;
    const sz = SIZES[type];
    if (!sz) throw new Error(`Unknown PLY type "${type}".`);
    if (p + sz > dv.byteLength) throw new Error('PLY body ended early.');
    this.p = p + sz;
    switch (type) {
      case 'float': case 'float32': return dv.getFloat32(p, le);
      case 'double': case 'float64': return dv.getFloat64(p, le);
      case 'uchar': case 'uint8': return dv.getUint8(p);
      case 'char': case 'int8': return dv.getInt8(p);
      case 'short': case 'int16': return dv.getInt16(p, le);
      case 'ushort': case 'uint16': return dv.getUint16(p, le);
      case 'int': case 'int32': return dv.getInt32(p, le);
      default: return dv.getUint32(p, le);
    }
  }
}
