// Stepside viewer. Runs inside an extension-origin iframe injected over the
// GitHub blob view. Renders on demand only: no animation loop runs unless the
// camera is actually moving.

import {
  WebGLRenderer, Scene, PerspectiveCamera, DirectionalLight, Object3D, PMREMGenerator,
  BufferGeometry, BufferAttribute, Mesh, LineSegments, Points, MeshStandardMaterial,
  LineBasicMaterial, PointsMaterial, Color, SRGBColorSpace, DoubleSide, Vector3, Box3, Sphere,
  NeutralToneMapping,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { cacheKey, cacheGet, cachePut } from './cache.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status'), statusText = $('status-text'), statusBar = $('status-bar');
const statusActions = $('status-actions'), toolsEl = $('tools'), infoEl = $('info');

// Up-axis defaults: CAD is Z-up; Stanford-style PLY, OBJ, VRML and glTF are Y-up.
const Z_UP = new Set(['step', 'iges', 'brep', 'off']);
const PHASES = {
  engine: 'Loading OpenCascade…',
  tessellate: 'Tessellating B-rep…',
  parse: 'Parsing…',
  build: 'Building mesh…',
};

let port = null, worker = null, init = null;
let renderer, scene, camera, controls, root, model = null, edges = null;
let upZ = false;
let radius = 1;
let t0 = performance.now();
const relays = new Map();
let relaySeq = 0;
let meshKey = null, pendingCache = null;
const CAD = new Set(['step', 'iges', 'brep']);

// ---------------------------------------------------------------------------
// Handshake with the content script (MessageChannel, transferred once)
// ---------------------------------------------------------------------------
window.addEventListener('message', (e) => {
  if (port || e.source !== window.parent || !e.data || e.data.stepside !== 'init' || !e.ports[0]) return;
  init = e.data;
  port = e.ports[0];
  port.onmessage = onPortMessage;
  document.documentElement.dataset.theme = init.theme && init.theme.dark ? 'dark' : 'light';
  if (init.theme && init.theme.bg) document.documentElement.style.setProperty('--bg', init.theme.bg);
  t0 = performance.now();
  setStatus('Downloading…');
  if (init.format !== 'gltf' && init.format !== 'glb') startWorker();
  try { setupRenderer(); } catch (err) { fail(`WebGL is not available: ${err.message}`); return; }
  port.postMessage({ type: 'ready' });
});

function onPortMessage(e) {
  const d = e.data;
  switch (d.type) {
    case 'progress': {
      if (d.total) setProgress(`Downloading ${fmtBytes(d.loaded)} / ${fmtBytes(d.total)}`, d.loaded / d.total, false);
      else setStatus(`Downloading… ${fmtBytes(d.loaded)}`);
      break;
    }
    case 'file':
      statusBar.hidden = true;
      if (init.format === 'gltf' || init.format === 'glb') loadGltf(d.buffer).catch((err) => fail(err.message || String(err)));
      else parseFile(d.buffer).catch((err) => fail(err.message || String(err)));
      break;
    case 'too-large':
      statusBar.hidden = true;
      setStatus(`This file is ${fmtBytes(d.size)}. Rendering it may take a while and use a lot of memory.`, [
        ['Render anyway', () => { setStatus('Downloading…'); port.postMessage({ type: 'force' }); }],
        ['Show source', showSource],
      ], true);
      break;
    case 'fetch-result': {
      const r = relays.get(d.id);
      if (!r) break;
      relays.delete(d.id);
      if (d.error) r.reject(new Error(d.error)); else r.resolve(d.buffer);
      break;
    }
    case 'error':
      fail(d.message);
      break;
  }
}

/** Fetch a file relative to the model through the content script (keeps GitHub auth). */
function relayFetch(url) {
  const id = ++relaySeq;
  port.postMessage({ type: 'fetch', id, url });
  return new Promise((resolve, reject) => relays.set(id, { resolve, reject }));
}

const showSource = () => port.postMessage({ type: 'show-source' });

// ---------------------------------------------------------------------------
// Worker (with a content-addressed cache in front of it)
// ---------------------------------------------------------------------------
async function parseFile(buffer) {
  let key = null;
  try { key = await cacheKey(init.format, buffer); } catch { /* no subtle crypto */ }
  const hit = key && (await cacheGet(key));
  if (hit) {
    if (worker) { worker.terminate(); worker = null; } // never needed: drop OCCT warm-up
    showMesh({ ...hit.mesh, cached: true });
    if (hit.edges) showEdges(hit.edges);
    return;
  }
  meshKey = key;
  setStatus(CAD.has(init.format) ? PHASES.engine : PHASES.parse);
  worker.postMessage({ type: 'parse', format: init.format, buffer }, [buffer]);
}

function startWorker() {
  worker = new Worker(new URL('../worker/worker.js', import.meta.url));
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => fail(e.message || 'The parser crashed.');
  worker.postMessage({ type: 'init', format: init.format });
}

function onWorkerMessage(e) {
  const d = e.data;
  switch (d.type) {
    case 'progress':
      if (d.value != null) setProgress(d.label || PHASES[d.phase] || 'Working…', d.value, true, d.cap);
      else setStatus(PHASES[d.phase] || 'Working…');
      break;
    case 'mesh': case 'points':
      if (meshKey && d.parseMs > 200) pendingCache = d; // only worth caching if it was slow
      showMesh(d);
      break;
    case 'edges':
      if (pendingCache) { cachePut(meshKey, pendingCache, d.positions); pendingCache = null; }
      showEdges(d.positions);
      break;
    case 'fetch':
      relayFetch(new URL(d.path, init.fileUrl).href).then(
        (buffer) => worker && worker.postMessage({ type: 'fetch-result', id: d.id, buffer }, [buffer]),
        (err) => worker && worker.postMessage({ type: 'fetch-result', id: d.id, error: err.message }),
      );
      break;
    case 'done':
      if (pendingCache) { cachePut(meshKey, pendingCache, null); pendingCache = null; }
      // Free the worker and everything it holds (incl. the OCCT WASM heap).
      worker.terminate();
      worker = null;
      break;
    case 'error': fail(d.message); break;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function setupRenderer() {
  renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = NeutralToneMapping;
  renderer.setClearColor(new Color(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#f6f8fa'));
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  $('stage').appendChild(canvas);

  scene = new Scene();
  camera = new PerspectiveCamera(35, 1, 0.01, 1000);
  scene.add(camera);
  // Everything lives under `root`; a Z-up model is turned so +Z points up.
  root = new Object3D();
  scene.add(root);
  setUp(Z_UP.has(init.format), false);
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(0.4, 0.8, 1);
  camera.add(key);
  camera.add(key.target);

  // Image-based lighting (cheap: one PMREM render while the worker is busy).
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.7;
  pmrem.dispose();

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.18;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.addEventListener('change', requestRender);

  new ResizeObserver(resize).observe(document.body);
  resize();

  canvas.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); fail('The WebGL context was lost. Reload the page to try again.'); });
  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === 'f' || ev.key === 'F') fit();
    else if (ev.key === 'e' || ev.key === 'E') toggleEdges();
    else if (ev.key === 'u' || ev.key === 'U') setUp(!upZ, true);
  });
  $('b-up').onclick = () => setUp(!upZ, true);
  $('b-fit').onclick = () => fit();
  $('b-edges').onclick = toggleEdges;
  const full = $('b-full');
  if (document.fullscreenEnabled) {
    full.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  } else full.disabled = true;
}

function resize() {
  const w = document.body.clientWidth, h = document.body.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  requestRender();
}

let frameQueued = false;
function requestRender() {
  if (frameQueued || !renderer) return;
  frameQueued = true;
  requestAnimationFrame(frame);
}

function frame() {
  frameQueued = false;
  controls.update(); // emits 'change' (=> next frame) while damping is in progress
  updateClip();
  renderer.render(scene, camera);
}

function updateClip() {
  const d = camera.position.length(); // model is centred at the origin
  const near = Math.max(radius * 1e-4, (d - radius) * 0.5, d * 1e-3);
  const far = d + radius * 2;
  if (Math.abs(camera.near - near) > near * 1e-3 || Math.abs(camera.far - far) > far * 1e-3) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}

function fit() {
  const vfov = (camera.fov * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.02;
  const dir = new Vector3(1, 0.8, 1.25);
  camera.position.copy(dir.normalize().multiplyScalar(dist));
  controls.target.set(0, 0, 0);
  controls.minDistance = radius * 1e-3;
  controls.maxDistance = radius * 40;
  controls.update();
  requestRender();
}

/** Drop CPU-side copies once data is on the GPU: halves steady-state memory. */
function releaseAfterUpload(attr) {
  attr.onUpload(function () { this.array = null; });
  return attr;
}

function geometryFrom(d) {
  const g = new BufferGeometry();
  g.setAttribute('position', releaseAfterUpload(new BufferAttribute(d.position, 3)));
  if (d.normal) g.setAttribute('normal', releaseAfterUpload(new BufferAttribute(d.normal, 3, true)));
  if (d.color) g.setAttribute('color', releaseAfterUpload(new BufferAttribute(d.color, 3, true)));
  if (d.index) g.setIndex(releaseAfterUpload(new BufferAttribute(d.index, 1)));
  g.boundingSphere = new Sphere(new Vector3(), d.radius);
  g.boundingBox = new Box3(new Vector3(-d.size[0] / 2, -d.size[1] / 2, -d.size[2] / 2), new Vector3(d.size[0] / 2, d.size[1] / 2, d.size[2] / 2));
  return g;
}

function srgb(c) {
  return new Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, SRGBColorSpace);
}

function showMesh(d) {
  radius = d.radius || 1;
  const g = geometryFrom(d);
  if (d.type === 'points') {
    const size = (2.5 * radius) / Math.sqrt(Math.max(1, d.vertices));
    model = new Points(g, new PointsMaterial({
      size, sizeAttenuation: true, vertexColors: !!d.color, color: d.color ? 0xffffff : srgb(d.uniformColor),
    }));
  } else {
    model = new Mesh(g, new MeshStandardMaterial({
      color: d.color ? 0xffffff : srgb(d.uniformColor),
      vertexColors: !!d.color,
      metalness: 0.05,
      roughness: 0.5,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }));
  }
  model.matrixAutoUpdate = false;
  model.userData.triangles = d.triangles;
  root.add(model);
  fit();
  hideStatus();
  toolsEl.hidden = false;
  $('b-edges').disabled = true; // enabled once edges arrive
  const total = performance.now() - t0;
  infoEl.textContent = [
    d.type === 'points' ? `${fmtInt(d.vertices)} points` : `${fmtInt(d.triangles)} triangles`,
    fmtSize(d.size, d.units),
    `${(total / 1000).toFixed(2)} s${d.cached ? ' (cached)' : ''}`,
  ].filter(Boolean).join('  ·  ');
  infoEl.title = d.cached
    ? `Loaded from cache · total incl. download: ${total.toFixed(0)} ms`
    : `Parse + mesh: ${d.parseMs.toFixed(0)} ms${d.timings ? ` (read ${d.timings.read.toFixed(0)} · mesh ${d.timings.mesh.toFixed(0)} · export ${d.timings.export.toFixed(0)})` : ''} · total incl. download: ${total.toFixed(0)} ms`;
  infoEl.hidden = false;
}

function showEdges(positions) {
  if (!positions.length) return;
  const g = new BufferGeometry();
  g.setAttribute('position', releaseAfterUpload(new BufferAttribute(positions, 3)));
  g.boundingSphere = new Sphere(new Vector3(), radius);
  const dark = document.documentElement.dataset.theme === 'dark';
  edges = new LineSegments(g, new LineBasicMaterial({ color: dark ? 0x0b0e12 : 0x24292f }));
  edges.matrixAutoUpdate = false;
  // CAD gets edges by default; meshes only when they look hard-surface (few
  // feature edges per triangle) so dense organic scans don't turn into noise.
  const cad = init.format === 'step' || init.format === 'iges' || init.format === 'brep';
  const ratio = positions.length / 6 / Math.max(1, model ? model.userData.triangles : 0);
  edges.visible = cad || ratio < (init.format === 'vrml' || init.format === 'off' ? 0.25 : 0.05);
  root.add(edges);
  const btn = $('b-edges');
  btn.disabled = false;
  btn.setAttribute('aria-pressed', String(edges.visible));
  requestRender();
}

function setUp(z, refit) {
  upZ = z;
  root.rotation.x = z ? -Math.PI / 2 : 0;
  root.updateMatrixWorld(true);
  const b = $('b-up');
  b.textContent = z ? 'Z' : 'Y';
  b.title = `Up axis: ${z ? 'Z' : 'Y'} — click to switch (U)`;
  if (refit) fit(); else requestRender();
}

function toggleEdges() {
  if (!edges) return;
  edges.visible = !edges.visible;
  $('b-edges').setAttribute('aria-pressed', String(edges.visible));
  requestRender();
}

// ---------------------------------------------------------------------------
// glTF / GLB (three's loader, loaded on demand as a separate chunk)
// ---------------------------------------------------------------------------
async function loadGltf(buffer) {
  setStatus('Parsing glTF…');
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
  ]);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const bytes = new Uint8Array(buffer);
  const isGlb = bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
  const blobs = [];
  let data = buffer;
  let json;
  if (isGlb) {
    const len = new DataView(buffer).getUint32(12, true);
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
  } else {
    json = JSON.parse(new TextDecoder().decode(bytes));
  }
  const used = json.extensionsRequired || json.extensionsUsed || [];
  if (used.includes('KHR_draco_mesh_compression')) throw new Error('Draco-compressed glTF is not supported yet.');
  if (!isGlb) {
    const resolve = async (o) => {
      if (!o.uri || o.uri.startsWith('data:')) return;
      const buf = await relayFetch(new URL(o.uri, init.fileUrl).href);
      const url = URL.createObjectURL(new Blob([buf], o.mimeType ? { type: o.mimeType } : undefined));
      blobs.push(url);
      o.uri = url;
    };
    setStatus('Fetching glTF resources…');
    await Promise.all([...(json.buffers || []), ...(json.images || [])].map(resolve));
    data = JSON.stringify(json);
    setStatus('Parsing glTF…');
  }
  let gltf;
  try { gltf = await loader.parseAsync(data, ''); } finally { blobs.forEach((u) => URL.revokeObjectURL(u)); }

  const gltfRoot = gltf.scene || gltf.scenes[0];
  const box = new Box3().setFromObject(gltfRoot);
  const center = box.getCenter(new Vector3()), size = box.getSize(new Vector3());
  gltfRoot.position.sub(center);
  radius = size.length() / 2 || 1;
  let tris = 0;
  gltfRoot.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  root.add(gltfRoot);
  model = gltfRoot;
  fit();
  hideStatus();
  toolsEl.hidden = false;
  $('b-edges').disabled = true;
  const total = performance.now() - t0;
  infoEl.textContent = [`${fmtInt(tris)} triangles`, fmtSize(size.toArray(), null), `${(total / 1000).toFixed(2)} s`].join('  ·  ');
  infoEl.hidden = false;
}

// ---------------------------------------------------------------------------
// Status UI
// ---------------------------------------------------------------------------
function setStatus(text, actions = null, isError = false) {
  statusEl.hidden = false;
  statusEl.classList.toggle('error', isError);
  statusEl.classList.remove('determinate');
  statusBar.hidden = true;
  bar.shown = 0;
  statusText.textContent = text;
  statusActions.replaceChildren(...(actions || []).map(([label, fn]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = fn;
    return b;
  }));
}

/**
 * Determinate progress: a bar instead of the spinner. Engines report in
 * bursts, so while no update arrives the bar creeps towards `cap` (the end of
 * the current phase) — it keeps moving but never claims more than is done.
 */
const bar = { shown: 0, cap: 0, label: '', percent: true, lastUpdate: 0, timer: 0 };
function setProgress(label, fraction, showPercent = true, cap = fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  if (label !== bar.label && !showPercent) bar.shown = 0; // new download bar
  bar.shown = showPercent ? Math.max(bar.shown, f) : f;
  bar.cap = Math.max(f, Math.min(1, cap));
  bar.label = label;
  bar.percent = showPercent;
  bar.lastUpdate = performance.now();
  statusEl.hidden = false;
  statusEl.classList.remove('error');
  statusEl.classList.add('determinate');
  statusBar.hidden = false;
  if (statusActions.firstChild) statusActions.replaceChildren();
  drawBar();
  if (!bar.timer && bar.cap > f) bar.timer = setInterval(creep, 100);
}

function creep() {
  if (statusEl.hidden || !statusEl.classList.contains('determinate')) { clearInterval(bar.timer); bar.timer = 0; return; }
  if (performance.now() - bar.lastUpdate > 250 && bar.shown < bar.cap) {
    bar.shown += (bar.cap - bar.shown) * 0.025;
    drawBar();
  }
}

function drawBar() {
  const pct = bar.shown * 100;
  statusBar.firstElementChild.style.width = `${pct.toFixed(1)}%`;
  statusText.textContent = bar.percent ? `${bar.label} · ${Math.floor(pct)}%` : bar.label;
}

function hideStatus() {
  clearInterval(bar.timer);
  bar.timer = 0;
  statusEl.hidden = true;
}

function fail(message) {
  if (worker) { worker.terminate(); worker = null; }
  statusBar.hidden = true;
  setStatus(`Couldn't render this file: ${message}`, port ? [['Show source', showSource]] : null, true);
}

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtSize(s, units) {
  if (!s) return '';
  const f = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toPrecision(3).replace(/\.?0+$/, ''));
  return `${f(s[0])} × ${f(s[1])} × ${f(s[2])}${units ? ' ' + units : ''}`;
}
