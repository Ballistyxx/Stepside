// STEP / IGES / BREP via Stepside's own OpenCascade WASM build (native/).
// The module is only fetched + compiled when a CAD file is actually opened,
// and the whole worker (incl. the WASM heap) is terminated after delivery.

let enginePromise = null;

export function loadOcct(baseUrl) {
  if (!enginePromise) {
    enginePromise = (async () => {
      const wasmUrl = new URL('vendor/stepside-occt.wasm', baseUrl).href;
      // Start download + streaming compile while the JS glue loads.
      const modulePromise = WebAssembly.compileStreaming
        ? WebAssembly.compileStreaming(fetch(wasmUrl))
        : fetch(wasmUrl).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b));
      importScripts(new URL('vendor/stepside-occt.js', baseUrl).href);
      const module = await modulePromise;
      return self.stepsideOcct({
        locateFile: (p) => new URL('vendor/' + p, baseUrl).href,
        print() {},
        printErr() {},
        instantiateWasm(imports, done) {
          WebAssembly.instantiate(module, imports).then((inst) => done(inst, module), (err) => {
            self.postMessage({ type: 'error', message: `OpenCascade failed to start: ${err.message}` });
          });
          return {};
        },
      });
    })();
    enginePromise.catch(() => { enginePromise = null; });
  }
  return enginePromise;
}

// Share of total engine time per phase (read, transfer, mesh, export),
// measured on two large Onshape assemblies (34 MB and 75 MB); turns OCCT's
// per-phase progress into one time-proportional bar.
const WEIGHTS = [0.13, 0.6, 0.25, 0.02];
// OCCT's transfer progress is front-loaded (its first quarter covers ~87% of
// the phase's time, mostly per-part healing); remap so the bar tracks time.
// Piecewise linear [reported fraction, share of phase time]. Meshing is
// reported per part (weighted by face count) and is already ~linear.
const TRANSFER_CURVE = [[0, 0], [0.1, 0.14], [0.25, 0.87], [0.75, 0.96], [1, 1]];
const LABELS = ['Reading', 'Building B-rep', 'Tessellating', 'Collecting faces'];

function remap(curve, f) {
  for (let i = 1; i < curve.length; i++) {
    const [x0, y0] = curve[i - 1], [x1, y1] = curve[i];
    if (f <= x1) return y0 + ((f - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 1;
}

// Tessellation quality presets: [linear deflection as a fraction of the
// model's average size, angular deflection in radians].
export const QUALITY = {
  draft: [0.004, 0.8],
  low: [0.002, 0.6],
  standard: [0.001, 0.5],
  fine: [0.0004, 0.3],
};

/**
 * ctx: { occt?, baseUrl, progress(), options: {quality, fastFirstLook,
 * progressive, names}, onChunk?(chunk) } — onChunk receives early previews
 * ({type:'bounds'|'chunk', ...}) while the final mesh is still being built.
 */
export async function parseCad(format, bytes, ctx) {
  const occt = ctx.occt || (await loadOcct(ctx.baseUrl));
  const name = format === 'iges' ? 'IGES' : format === 'brep' ? 'BREP' : 'STEP';
  const o = ctx.options || {};
  const [linear, angular] = QUALITY[o.quality] || QUALITY.standard;
  const onProgress = (phase, f) => {
    let done = 0;
    for (let i = 0; i < phase; i++) done += WEIGHTS[i];
    if (phase === 1) f = remap(TRANSFER_CURVE, f);
    // `cap` = end of this phase: the UI may creep towards it during stalls.
    const cap = done + WEIGHTS[phase];
    ctx.progress('cad', Math.min(1, done + WEIGHTS[phase] * f), phase === 0 ? `Reading ${name}` : LABELS[phase], cap);
  };
  onProgress(0, 0);
  const res = occt.read(format, bytes, {
    linear, angular, heal: true,
    names: o.names !== false,
    coarse: o.fastFirstLook !== false,
    progressive: o.progressive !== false,
  }, onProgress, ctx.onChunk || null);
  if (res.error) throw new Error(res.error);
  ctx.timings = res.timings;
  ctx.skipped = res.skipped || 0;
  if (!res.index.length) throw new Error('The file contains no surfaces to display.');
  return [{
    position: res.position,
    normal: res.normal,
    index: res.index,
    vertexColor: res.color,
    faceGroup: res.faceGroup,
    tree: cadTree(res.tree, res.index.length / 3),
  }];
}

/**
 * Engine tree (DFS order, depth per node, triangle range per leaf) -> flat
 * node list with a triangle range for every node. In DFS order an assembly's
 * leaves are contiguous, so its range runs from its first leaf to the start
 * of the next node at the same or a shallower depth.
 */
export function cadTree(t, totalTris) {
  const n = t.depth.length;
  if (!n) return null;
  const minDepth = Math.min(...t.depth);
  const nodes = [];
  // start of each node = its own leaf start, or the next leaf's start
  const start = new Int32Array(n);
  let next = totalTris;
  for (let i = n - 1; i >= 0; i--) {
    if (t.leafStart[i] >= 0) next = t.leafStart[i];
    start[i] = next;
  }
  for (let i = 0; i < n; i++) {
    let end = totalTris;
    if (t.leafStart[i] >= 0) end = t.leafStart[i] + t.leafCount[i];
    else {
      for (let j = i + 1; j < n; j++) if (t.depth[j] <= t.depth[i]) { end = start[j]; break; }
    }
    nodes.push({
      name: t.names[i] || (t.leafStart[i] >= 0 ? 'Part' : 'Assembly'),
      depth: t.depth[i] - minDepth,
      start: start[i],
      count: Math.max(0, end - start[i]),
    });
  }
  return nodes;
}
