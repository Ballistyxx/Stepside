// Parse worker. Protocol (viewer <-> worker):
//   -> {type:'init', format}             start loading heavy deps (OCCT) early
//   -> {type:'parse', format, buffer, options}   buffer is transferred
//        options: {quality, fastFirstLook, progressive, names}
//   -> {type:'fetch-result', id, buffer|error}
//   <- {type:'progress', phase, value?, label?, cap?}   value 0..1 when determinate
//   <- {type:'fetch', id, path}          request a sibling file (mtllib)
//   <- {type:'bounds', center, radius}   CAD: model frame, before any preview
//   <- {type:'chunk', pass, chunk, count, position, normal, color, indices}
//        CAD previews (pass 0 = coarse, 1 = fine); replaced by the final mesh
//   <- {type:'mesh'|'points', ...}       final, transferred typed arrays
//   <- {type:'edges', positions, tri}    tri = source triangle per segment
//   <- {type:'done'} | {type:'error', message}

import { finalize, featureEdges, toInt16Normals, linearize } from './mesh.js';
import { parseObj } from './parsers/obj.js';
import { parsePly } from './parsers/ply.js';
import { parseOff } from './parsers/off.js';
import { parseVrml } from './parsers/vrml.js';
import { parseCad, loadOcct } from './parsers/cad.js';

const CAD = new Set(['step', 'iges', 'brep']);
const baseUrl = self.location.href;
const pending = new Map();
let seq = 0;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (phase, value, label, cap) => post({ type: 'progress', phase, value, label, cap });

function fetchSibling(path) {
  const id = ++seq;
  post({ type: 'fetch', id, path });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const ctx = {
  baseUrl,
  progress,
  fetchText: async (path) => new TextDecoder().decode(await fetchSibling(path)),
};

// CAD previews arrive in absolute model coordinates; centre them on the
// engine's bounding box so they share a frame with the final mesh.
let frameCenter = [0, 0, 0];
function onChunk(c) {
  if (c.type === 'bounds') {
    frameCenter = c.center;
    post({ type: 'bounds', center: c.center, radius: c.radius });
    return;
  }
  const position = c.position;
  const [cx, cy, cz] = frameCenter;
  for (let i = 0; i < position.length; i += 3) { position[i] -= cx; position[i + 1] -= cy; position[i + 2] -= cz; }
  const normal = toInt16Normals(c.normal);
  const color = linearize(c.color);
  const index = c.index;
  if (c.baseVertex) for (let i = 0; i < index.length; i++) index[i] -= c.baseVertex;
  post({ type: 'chunk', pass: c.pass, chunk: c.chunk, count: c.count, position, normal, color, indices: index },
    [position.buffer, normal.buffer, color.buffer, index.buffer]);
}

async function parse(format, buffer, options = {}) {
  const t0 = performance.now();
  const bytes = new Uint8Array(buffer);
  let parts;
  if (CAD.has(format)) {
    progress('engine');
    ctx.options = options;
    ctx.onChunk = options.fastFirstLook || options.progressive ? onChunk : null;
    parts = await parseCad(format, bytes, ctx);
  } else {
    progress('parse');
    switch (format) {
      case 'obj': parts = await parseObj(bytes, ctx); break;
      case 'ply': parts = parsePly(bytes); break;
      case 'off': parts = parseOff(bytes); break;
      case 'vrml': parts = parseVrml(bytes); break;
      default: throw new Error(`Unsupported format "${format}".`);
    }
  }
  progress('build');
  const cad = CAD.has(format);
  const { mesh, transfer, edgeInput } = finalize(parts, { wantEdges: true, edgeAngle: cad ? 30 : 35 });
  parts = null;
  mesh.parseMs = performance.now() - t0;
  if (ctx.timings) mesh.timings = ctx.timings;
  if (ctx.skipped) mesh.skipped = ctx.skipped;
  mesh.units = cad ? 'mm' : null;
  post(mesh, transfer);
  if (edgeInput) {
    const { positions, tri } = featureEdges(edgeInput);
    post({ type: 'edges', positions, tri }, [positions.buffer, tri.buffer]);
  }
  post({ type: 'done' });
}

self.addEventListener('unhandledrejection', (e) => post({ type: 'error', message: String((e.reason && e.reason.message) || e.reason) }));

self.onmessage = (e) => {
  const d = e.data;
  if (d.type === 'init') {
    if (CAD.has(d.format)) loadOcct(baseUrl).catch(() => {}); // warm up in parallel with download
  } else if (d.type === 'parse') {
    parse(d.format, d.buffer, d.options).catch((err) => post({ type: 'error', message: String((err && err.message) || err) }));
  } else if (d.type === 'fetch-result') {
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.error) p.reject(new Error(d.error)); else p.resolve(d.buffer);
  }
};
