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
// measured on real assemblies (e.g. a 34 MB Onshape export: 1.0 / 5.4 / 2.3 /
// 0.05 s); turns OCCT's per-phase progress into one time-proportional bar.
const WEIGHTS = [0.11, 0.62, 0.26, 0.01];
// OCCT's transfer reports unevenly (its first quarter takes ~60% of the time);
// remap its fraction so the bar tracks time. Piecewise linear [in, out].
const TRANSFER_CURVE = [[0, 0], [0.25, 0.6], [0.5, 0.93], [1, 1]];
const LABELS = ['Reading', 'Building B-rep', 'Tessellating', 'Collecting faces'];

function remap(curve, f) {
  for (let i = 1; i < curve.length; i++) {
    const [x0, y0] = curve[i - 1], [x1, y1] = curve[i];
    if (f <= x1) return y0 + ((f - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 1;
}

export async function parseCad(format, bytes, ctx) {
  const occt = ctx.occt || (await loadOcct(ctx.baseUrl));
  const name = format === 'iges' ? 'IGES' : format === 'brep' ? 'BREP' : 'STEP';
  const onProgress = (phase, f) => {
    let done = 0;
    for (let i = 0; i < phase; i++) done += WEIGHTS[i];
    if (phase === 1) f = remap(TRANSFER_CURVE, f);
    // `cap` = end of this phase: the UI may creep towards it during stalls.
    const cap = done + WEIGHTS[phase];
    ctx.progress('cad', Math.min(1, done + WEIGHTS[phase] * f), phase === 0 ? `Reading ${name}` : LABELS[phase], cap);
  };
  onProgress(0, 0);
  const res = occt.read(format, bytes, 0.001, 0.5, onProgress, true);
  if (res.error) throw new Error(res.error);
  ctx.timings = res.timings;
  if (!res.index.length) throw new Error('The file contains no surfaces to display.');
  return [{
    position: res.position,
    normal: res.normal,
    index: res.index,
    vertexColor: res.color,
    faceGroup: res.faceGroup,
  }];
}
