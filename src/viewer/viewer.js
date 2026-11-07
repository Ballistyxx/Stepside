// Stepside viewer. Runs inside an extension-origin iframe injected over the
// GitHub blob view. Renders on demand only: no animation loop runs unless the
// camera is moving or an animation is in progress.

import {
  WebGLRenderer, Scene, PerspectiveCamera, OrthographicCamera, DirectionalLight, Object3D,
  PMREMGenerator, BufferGeometry, BufferAttribute, Mesh, LineSegments, Points,
  MeshStandardMaterial, MeshBasicMaterial, MeshDepthMaterial, LineBasicMaterial, PointsMaterial,
  SphereGeometry, Color, SRGBColorSpace, DoubleSide, Vector3, Box3, Sphere, Plane, Quaternion,
  NeutralToneMapping, WebGLRenderTarget, FloatType, NearestFilter, BasicDepthPacking, MOUSE,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import browser from 'webextension-polyfill';
import { cacheKey, cacheGet, cachePut, setCacheLimit } from './cache.js';
import { loadSettings, onSettingsChanged } from '../common/settings.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status'), statusText = $('status-text'), statusBar = $('status-bar');
const statusActions = $('status-actions'), infoEl = $('info');

const CAD = new Set(['step', 'iges', 'brep']);
// Up-axis defaults: CAD is Z-up; Stanford-style PLY, OBJ, VRML and glTF are Y-up.
const Z_UP = new Set(['step', 'iges', 'brep', 'off']);
const PHASES = {
  engine: 'Loading OpenCascade…',
  parse: 'Parsing…',
  build: 'Building mesh…',
};
// View presets as world-space directions from the target (world up is +Y; a
// Z-up model is rotated so its +Z is world +Y and its front (-Y) faces +Z).
const VIEWS = {
  iso: [1, 0.8, 1.25], front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0],
  right: [1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0],
};
const FOV = 35;

let settings = null;
let port = null, worker = null, init = null;
let renderer, scene, camera, perspCam, orthoCam, controls, rig, root;
let model = null, edges = null, edgeTri = null, isPoints = false, gltfRoot = null;
let previews = null; // Object3D holding progressive/coarse CAD chunks
const previewChunks = new Map();
let frameCenter = null; // absolute centre of the model frame (first one seen)
let radius = 1, upZ = false, fitted = false;
const modelMaterials = new Set(); // materials affected by display options
let t0 = performance.now();
const relays = new Map();
let relaySeq = 0;
let meshKey = null, pendingCache = null;
const display = { edges: false, wire: false, xray: false, section: false };
const section = { axis: 'x', pos: 0, flip: false, plane: new Plane(new Vector3(1, 0, 0), 0) };
const capUniform = { value: 0 };

// ---------------------------------------------------------------------------
// Handshake with the content script (MessageChannel, transferred once)
// ---------------------------------------------------------------------------
window.addEventListener('message', async (e) => {
  if (port || e.source !== window.parent || !e.data || e.data.stepside !== 'init' || !e.ports[0]) return;
  init = e.data;
  port = e.ports[0];
  port.onmessage = onPortMessage;
  document.documentElement.dataset.theme = init.theme && init.theme.dark ? 'dark' : 'light';
  if (init.theme && init.theme.bg) document.documentElement.style.setProperty('--bg', init.theme.bg);
  t0 = performance.now();
  setStatus('Downloading…');
  if (init.format !== 'gltf' && init.format !== 'glb') startWorker();
  settings = await loadSettings();
  setCacheLimit(settings.cacheMB);
  try { setupRenderer(); } catch (err) { fail(`WebGL is not available: ${err.message}`); return; }
  applyFeatures();
  onSettingsChanged((s) => { settings = s; setCacheLimit(s.cacheMB); applyFeatures(); });
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
      whenReady(() => {
        if (init.format === 'gltf' || init.format === 'glb') loadGltf(d.buffer).catch((err) => fail(err.message || String(err)));
        else parseFile(d.buffer).catch((err) => fail(err.message || String(err)));
      });
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

/** Runs `fn` once settings are loaded and the renderer exists. */
function whenReady(fn) {
  if (renderer) fn();
  else setTimeout(() => whenReady(fn), 10);
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
  const variant = CAD.has(init.format) ? settings.quality : '';
  let key = null;
  try { key = await cacheKey(init.format, buffer, variant); } catch { /* no subtle crypto */ }
  const hit = key && (await cacheGet(key));
  if (hit) {
    if (worker) { worker.terminate(); worker = null; } // never needed: drop OCCT warm-up
    showMesh({ ...hit.mesh, cached: true });
    if (hit.edges) showEdges(hit.edges.positions, hit.edges.tri);
    return;
  }
  meshKey = key;
  setStatus(CAD.has(init.format) ? PHASES.engine : PHASES.parse);
  worker.postMessage({
    type: 'parse', format: init.format, buffer,
    options: { quality: settings.quality, fastFirstLook: settings.fastFirstLook, progressive: settings.progressive, names: true },
  }, [buffer]);
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
    case 'bounds':
      if (!frameCenter) frameCenter = d.center;
      radius = d.radius || radius;
      break;
    case 'chunk':
      showChunk(d);
      break;
    case 'mesh': case 'points':
      if (meshKey && d.parseMs > 200) pendingCache = d; // only worth caching if it was slow
      showMesh(d);
      break;
    case 'edges':
      if (pendingCache) { cachePut(meshKey, pendingCache, { positions: d.positions, tri: d.tri }); pendingCache = null; }
      showEdges(d.positions, d.tri);
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
// Renderer, cameras, controls
// ---------------------------------------------------------------------------
function setupRenderer() {
  renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = NeutralToneMapping;
  renderer.localClippingEnabled = true;
  renderer.setClearColor(new Color(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#f6f8fa'));
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  $('stage').appendChild(canvas);

  scene = new Scene();
  perspCam = new PerspectiveCamera(FOV, 1, 0.01, 1000);
  orthoCam = new OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  camera = perspCam;
  // Everything lives under `root`; a Z-up model is turned so +Z points up.
  root = new Object3D();
  scene.add(root);
  // Headlight on a rig that follows whichever camera is active.
  rig = new Object3D();
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(0.4, 0.8, 1);
  rig.add(key, key.target);
  scene.add(rig);
  const z = settings.upAxis === 'z' || (settings.upAxis === 'auto' && Z_UP.has(init.format));
  setUp(z, false);

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
  // Middle click: orbit around the point under the cursor.
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button === 1 && settings.orbitPoint) { ev.preventDefault(); setPivot(ev); }
  });
  canvas.addEventListener('mousedown', (ev) => { if (ev.button === 1 && settings.orbitPoint) ev.preventDefault(); }); // no autoscroll
  canvas.addEventListener('auxclick', (ev) => { if (ev.button === 1) ev.preventDefault(); });

  window.addEventListener('keydown', onKey);
  wireUi();
}

function onKey(ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.target.tagName === 'INPUT') return;
  const k = ev.key.toLowerCase();
  const views = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'];
  if (k === 'f') setView('iso', true);
  else if (/^[0-6]$/.test(k) && settings.viewPresets) setView(views[Number(k)], true);
  else if (k === 'o' && settings.viewPresets) setOrtho(camera !== orthoCam);
  else if (k === 'e') toggleDisplay('edges');
  else if (k === 'w' && settings.displayOptions) toggleDisplay('wire');
  else if (k === 'x' && settings.displayOptions) toggleDisplay('xray');
  else if (k === 's' && settings.sectionPlane) toggleDisplay('section');
  else if (k === 'u') setUp(!upZ, true);
}

function resize() {
  const w = document.body.clientWidth, h = document.body.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  perspCam.aspect = w / h;
  perspCam.updateProjectionMatrix();
  updateOrthoFrustum();
  requestRender();
}

function updateOrthoFrustum() {
  const w = document.body.clientWidth || 1, h = document.body.clientHeight || 1;
  const half = radius * 1.05;
  orthoCam.top = half;
  orthoCam.bottom = -half;
  orthoCam.left = (-half * w) / h;
  orthoCam.right = (half * w) / h;
  orthoCam.updateProjectionMatrix();
}

// ---- render loop (on demand) ---------------------------------------------
let frameQueued = false;
const animations = new Set();
function requestRender() {
  if (frameQueued || !renderer) return;
  frameQueued = true;
  requestAnimationFrame(frame);
}

function frame(now) {
  frameQueued = false;
  for (const a of animations) {
    const f = Math.min(1, (now - a.start) / a.duration);
    a.step(f < 1 ? 1 - (1 - f) ** 3 : 1);
    if (f >= 1) { animations.delete(a); if (a.done) a.done(); }
  }
  controls.update(); // emits 'change' (=> next frame) while damping is in progress
  rig.position.copy(camera.position);
  rig.quaternion.copy(camera.quaternion);
  updateClip();
  renderer.render(scene, camera);
  if (animations.size) requestRender();
}

function animate(duration, step, done) {
  const a = { start: performance.now(), duration, step, done };
  animations.add(a);
  requestRender();
  return a;
}

function updateClip() {
  const d = camera.position.distanceTo(controls.target) + controls.target.length();
  let near, far;
  if (camera === orthoCam) {
    near = d - radius * 3; // negative is fine for an orthographic camera
    far = d + radius * 3;
  } else {
    near = Math.max(radius * 1e-4, (d - radius) * 0.5, d * 1e-3);
    far = d + radius * 2;
  }
  if (Math.abs(camera.near - near) > Math.abs(near) * 1e-3 + 1e-9 || Math.abs(camera.far - far) > far * 1e-3) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}

function fitDistance(r) {
  const vfov = (FOV * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * perspCam.aspect);
  return (r / Math.sin(Math.min(vfov, hfov) / 2)) * 1.02;
}

/** Animates (or jumps) to a preset view of the whole model. */
function setView(name, animated) {
  const dir = new Vector3(...VIEWS[name]).normalize();
  if (name === 'top' || name === 'bottom') dir.z += 1e-4; // avoid the orbit pole
  const dist = fitDistance(radius);
  moveCamera(new Vector3(), dir.normalize().multiplyScalar(dist), camera === orthoCam ? 1 : null, animated);
  controls.minDistance = radius * 1e-3;
  controls.maxDistance = radius * 40;
  document.querySelectorAll('#presets [data-view]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
}

/** Moves target to `target` and the camera to target + offset (zoom for ortho). */
function moveCamera(target, offset, zoom, animated) {
  const fromT = controls.target.clone(), fromP = camera.position.clone(), fromZ = camera.zoom;
  const toT = target.clone(), toP = target.clone().add(offset);
  // Interpolate the direction on the sphere so presets swing around the model.
  const fromOff = fromP.clone().sub(fromT), toOff = offset.clone();
  const fromLen = fromOff.length() || 1, toLen = toOff.length();
  const q = new Quaternion().setFromUnitVectors(fromOff.clone().normalize(), toOff.clone().normalize());
  const step = (f) => {
    controls.target.lerpVectors(fromT, toT, f);
    const dirQ = new Quaternion().slerp(q, f);
    const off = fromOff.clone().normalize().applyQuaternion(dirQ).multiplyScalar(fromLen + (toLen - fromLen) * f);
    camera.position.copy(controls.target).add(off);
    if (zoom != null && camera === orthoCam) { camera.zoom = fromZ + (zoom - fromZ) * f; camera.updateProjectionMatrix(); }
    camera.lookAt(controls.target);
  };
  if (!animated || fromOff.lengthSq() === 0) { step(1); camera.position.copy(toP); controls.update(); requestRender(); return; }
  animate(320, step, () => controls.update());
}

function setOrtho(on) {
  const target = controls.target.clone();
  const off = camera.position.clone().sub(target);
  const dist = off.length();
  const halfH = Math.tan(((FOV / 2) * Math.PI) / 180);
  if (on && camera !== orthoCam) {
    updateOrthoFrustum();
    orthoCam.position.copy(camera.position);
    orthoCam.quaternion.copy(camera.quaternion);
    orthoCam.zoom = (radius * 1.05) / Math.max(1e-9, dist * halfH);
    orthoCam.updateProjectionMatrix();
    camera = orthoCam;
  } else if (!on && camera !== perspCam) {
    const d = (radius * 1.05) / (orthoCam.zoom * halfH);
    perspCam.position.copy(target).add(off.normalize().multiplyScalar(d));
    perspCam.quaternion.copy(camera.quaternion);
    camera = perspCam;
  }
  controls.object = camera;
  controls.update();
  $('b-ortho').setAttribute('aria-pressed', String(camera === orthoCam));
  requestRender();
}

function setUp(z, refit) {
  upZ = z;
  root.rotation.x = z ? -Math.PI / 2 : 0;
  root.updateMatrixWorld(true);
  const b = $('b-up');
  b.textContent = z ? 'Z' : 'Y';
  b.title = `Up axis: ${z ? 'Z' : 'Y'} — click to switch (U)`;
  updateSectionPlane();
  if (refit) setView('iso', true); else requestRender();
}

// ---------------------------------------------------------------------------
// Orbit around a point (middle click): GPU depth pick of one pixel
// ---------------------------------------------------------------------------
let pickTarget = null, pickMaterial = null, marker = null;
function pickPoint(ev) {
  if (!renderer.extensions.has('EXT_color_buffer_float')) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  const pr = renderer.getPixelRatio();
  const W = Math.round(rect.width * pr), H = Math.round(rect.height * pr);
  const px = Math.round((ev.clientX - rect.left) * pr), py = Math.round((ev.clientY - rect.top) * pr);
  pickTarget ||= new WebGLRenderTarget(1, 1, { type: FloatType, minFilter: NearestFilter, magFilter: NearestFilter });
  pickMaterial ||= new MeshDepthMaterial({ depthPacking: BasicDepthPacking, side: DoubleSide });
  pickMaterial.clippingPlanes = display.section ? [section.plane] : null;
  const hidden = [edges, marker].filter((o) => o && o.visible);
  hidden.forEach((o) => { o.visible = false; });
  const clear = renderer.getClearColor(new Color()), alpha = renderer.getClearAlpha();
  scene.overrideMaterial = pickMaterial;
  renderer.setClearColor(0x000000, 0);
  camera.setViewOffset(W, H, px, py, 1, 1);
  renderer.setRenderTarget(pickTarget);
  renderer.render(scene, camera);
  const buf = new Float32Array(4);
  renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, buf);
  renderer.setRenderTarget(null);
  camera.clearViewOffset();
  scene.overrideMaterial = null;
  renderer.setClearColor(clear, alpha);
  hidden.forEach((o) => { o.visible = true; });
  const depth = 1 - buf[0];
  if (!(depth < 0.999999)) return null; // background
  const ndc = new Vector3(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1, depth * 2 - 1);
  return ndc.unproject(camera);
}

function setPivot(ev) {
  const p = pickPoint(ev);
  if (!p) return;
  // Pan so the picked point becomes the orbit centre (keeps distance & angle).
  const offset = camera.position.clone().sub(controls.target);
  moveCamera(p, offset, null, true);
  if (!marker) {
    marker = new Mesh(new SphereGeometry(1, 16, 12), new MeshBasicMaterial({ color: 0x0969da, depthTest: false, transparent: true, opacity: 0.85 }));
    marker.renderOrder = 10;
    scene.add(marker);
  }
  marker.position.copy(p);
  marker.scale.setScalar(camera.position.distanceTo(p) * 0.006);
  marker.visible = true;
  clearTimeout(marker.userData.timer);
  marker.userData.timer = setTimeout(() => { marker.visible = false; requestRender(); }, 900);
}

// ---------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------
/** Drop CPU-side copies once data is on the GPU: halves steady-state memory. */
function releaseAfterUpload(attr) {
  attr.onUpload(function () { this.array = null; });
  return attr;
}

function geometryFrom(d, keepIndex) {
  const g = new BufferGeometry();
  g.setAttribute('position', releaseAfterUpload(new BufferAttribute(d.position, 3)));
  if (d.normal) g.setAttribute('normal', releaseAfterUpload(new BufferAttribute(d.normal, 3, true)));
  if (d.color) g.setAttribute('color', releaseAfterUpload(new BufferAttribute(d.color, 3, true)));
  // The index stays on the CPU: three builds wireframes from it.
  const idx = d.index || d.indices;
  if (idx) g.setIndex(keepIndex ? new BufferAttribute(idx, 1) : releaseAfterUpload(new BufferAttribute(idx, 1)));
  return g;
}

function srgb(c) {
  return new Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, SRGBColorSpace);
}

function makeSurfaceMaterial(d) {
  const mat = new MeshStandardMaterial({
    color: d.color ? 0xffffff : srgb(d.uniformColor),
    vertexColors: !!d.color,
    metalness: 0.05,
    roughness: 0.5,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  // Cut faces show the inside (back faces): tint them while sectioning so the
  // cut reads as solid material.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCap = capUniform;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uCap;')
      .replace('#include <color_fragment>', '#include <color_fragment>\nif (!gl_FrontFacing) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.33, 0.24), uCap);');
  };
  registerMaterial(mat);
  return mat;
}

/** Positions an object given its absolute centre, relative to the model frame. */
function placeInFrame(obj, center) {
  if (!frameCenter) frameCenter = center || [0, 0, 0];
  if (center) obj.position.set(center[0] - frameCenter[0], center[1] - frameCenter[1], center[2] - frameCenter[2]);
  obj.updateMatrix();
  obj.matrixAutoUpdate = false;
}

function revealViewer() {
  setUi(true);
  if (!fitted) { fitted = true; setView('iso', false); }
  updateSectionPlane();
}

/** CAD preview chunk (coarse pass 0 or fine pass 1); replaced by the final mesh. */
let chunkMaterial = null;
function showChunk(d) {
  if (model) return; // final already shown
  if (!previews) {
    previews = new Object3D();
    placeInFrame(previews, frameCenter);
    root.add(previews);
  }
  chunkMaterial ||= makeSurfaceMaterial({ color: true });
  const g = geometryFrom({ position: d.position, normal: d.normal, color: d.color, index: d.indices }, true);
  const mesh = new Mesh(g, chunkMaterial);
  mesh.matrixAutoUpdate = false;
  // Every pass uses the same chunking, so fine chunk i replaces coarse chunk i.
  const old = previewChunks.get(d.chunk);
  if (old) { previews.remove(old); old.geometry.dispose(); }
  previewChunks.set(d.chunk, mesh);
  previews.add(mesh);
  revealViewer();
  statusEl.classList.add('compact');
  requestRender();
}

function clearPreviews() {
  if (!previews) return;
  for (const m of previewChunks.values()) m.geometry.dispose();
  previewChunks.clear();
  root.remove(previews);
  previews = null;
  if (chunkMaterial) { modelMaterials.delete(chunkMaterial); chunkMaterial.dispose(); chunkMaterial = null; }
}

function showMesh(d) {
  if (d.radius && !fitted) radius = d.radius;
  else if (d.radius) radius = Math.max(radius, d.radius);
  isPoints = d.type === 'points';
  const g = geometryFrom(d, !isPoints);
  g.boundingSphere = new Sphere(new Vector3(), d.radius);
  g.boundingBox = new Box3(new Vector3(-d.size[0] / 2, -d.size[1] / 2, -d.size[2] / 2), new Vector3(d.size[0] / 2, d.size[1] / 2, d.size[2] / 2));
  if (isPoints) {
    const size = (2.5 * d.radius) / Math.sqrt(Math.max(1, d.vertices));
    const mat = new PointsMaterial({ size, sizeAttenuation: true, vertexColors: !!d.color, color: d.color ? 0xffffff : srgb(d.uniformColor) });
    registerMaterial(mat);
    model = new Points(g, mat);
  } else {
    // A material array + geometry groups lets the model tree hide parts by
    // drawing only the visible triangle ranges (still one draw call when
    // everything is visible).
    model = new Mesh(g, [makeSurfaceMaterial(d)]);
    g.addGroup(0, g.index.count, 0);
  }
  placeInFrame(model, d.center);
  model.userData.triangles = d.triangles;
  root.add(model);
  clearPreviews();
  revealViewer();
  hideStatus();
  statusEl.classList.remove('compact');
  buildTreeFromRanges(d);
  const total = performance.now() - t0;
  infoEl.textContent = [
    isPoints ? `${fmtInt(d.vertices)} points` : `${fmtInt(d.triangles)} triangles`,
    fmtSize(d.size, d.units),
    `${(total / 1000).toFixed(2)} s${d.cached ? ' (cached)' : ''}`,
    d.skipped ? `⚠ ${d.skipped} broken part${d.skipped > 1 ? 's' : ''} skipped` : '',
  ].filter(Boolean).join('  ·  ');
  infoEl.title = d.cached
    ? `Loaded from cache · total incl. download: ${total.toFixed(0)} ms`
    : `Parse + mesh: ${d.parseMs.toFixed(0)} ms${d.timings ? ` (read ${d.timings.read.toFixed(0)} · mesh ${d.timings.mesh.toFixed(0)})` : ''} · total incl. download: ${total.toFixed(0)} ms`;
  infoEl.hidden = false;
  applyDisplay();
  requestRender();
}

function showEdges(positions, tri) {
  if (!positions.length || !model) return;
  const g = new BufferGeometry();
  g.setAttribute('position', releaseAfterUpload(new BufferAttribute(positions, 3)));
  g.boundingSphere = new Sphere(new Vector3(), radius);
  const dark = document.documentElement.dataset.theme === 'dark';
  const mat = new LineBasicMaterial({ color: dark ? 0x0b0e12 : 0x24292f });
  registerMaterial(mat);
  edges = new LineSegments(g, [mat]);
  edges.position.copy(model.position);
  edges.updateMatrix();
  edges.matrixAutoUpdate = false;
  edgeTri = tri || null;
  g.addGroup(0, positions.length / 3, 0);
  let on;
  if (settings.edges === 'on') on = true;
  else if (settings.edges === 'off') on = false;
  else {
    // Auto: CAD always; meshes only when they look hard-surface (few feature
    // edges per triangle) so dense organic scans don't turn into noise.
    const ratio = positions.length / 6 / Math.max(1, model.userData.triangles || 0);
    on = CAD.has(init.format) || ratio < (init.format === 'vrml' || init.format === 'off' ? 0.25 : 0.05);
  }
  display.edges = on;
  root.add(edges);
  $('b-edges').hidden = false;
  applyVisibility();
  applyDisplay();
}

function registerMaterial(mat) {
  modelMaterials.add(mat);
  return mat;
}

// ---------------------------------------------------------------------------
// Display options: edges, wireframe, X-ray, section plane
// ---------------------------------------------------------------------------
function toggleDisplay(key) {
  if (key === 'edges' && !edges) return;
  if (key === 'wire' && isPoints) return;
  display[key] = !display[key];
  applyDisplay();
}

function applyDisplay() {
  if (!settings) return;
  if (!settings.sectionPlane) display.section = false;
  if (edges) edges.visible = display.edges;
  const clip = display.section ? [section.plane] : null;
  capUniform.value = display.section ? 0.65 : 0;
  for (const m of modelMaterials) {
    if (m.isLineBasicMaterial) { m.clippingPlanes = clip; continue; }
    if ('wireframe' in m && !m.isPointsMaterial) m.wireframe = display.wire;
    const wantTransparent = display.xray || m.userData.origTransparent;
    if (m.userData.origTransparent === undefined) {
      m.userData.origTransparent = m.transparent;
      m.userData.origOpacity = m.opacity;
      m.userData.origDepthWrite = m.depthWrite;
    }
    m.transparent = wantTransparent;
    m.opacity = display.xray ? Math.min(0.28, m.userData.origOpacity) : m.userData.origOpacity;
    m.depthWrite = display.xray ? false : m.userData.origDepthWrite;
    m.clippingPlanes = clip;
    m.needsUpdate = true;
  }
  $('b-edges').setAttribute('aria-pressed', String(display.edges));
  $('b-wire').setAttribute('aria-pressed', String(display.wire));
  $('b-xray').setAttribute('aria-pressed', String(display.xray));
  $('b-section').setAttribute('aria-pressed', String(display.section));
  $('section').hidden = !(display.section && settings.sectionPlane && uiShown);
  updateSectionPlane();
  requestRender();
}

function updateSectionPlane() {
  if (!root) return;
  const axis = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[section.axis];
  // Model axes, turned with the model's up-axis rotation.
  const n = new Vector3(...axis).applyQuaternion(root.quaternion).normalize();
  const extent = modelHalfExtent(section.axis);
  const d = section.pos * extent;
  // Three keeps the side where n·p + c >= 0. Default: keep the far side.
  const sign = section.flip ? -1 : 1;
  section.plane.normal.copy(n).multiplyScalar(sign);
  section.plane.constant = -d * sign;
  requestRender();
}

function modelHalfExtent(axis) {
  const g = model && model.geometry;
  if (g && g.boundingBox) {
    const i = { x: 'x', y: 'y', z: 'z' }[axis];
    return (g.boundingBox.max[i] - g.boundingBox.min[i]) / 2 + radius * 0.01;
  }
  return radius;
}

async function screenshot() {
  renderer.render(scene, camera);
  const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
  if (!blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(init.name || 'model').replace(/\.[^.]+$/, '')}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------------------
// UI wiring & feature toggles (settings)
// ---------------------------------------------------------------------------
let uiShown = false;
function wireUi() {
  document.querySelectorAll('#presets [data-view]').forEach((b) => {
    b.addEventListener('click', () => { setView(b.dataset.view, true); b.setAttribute('aria-pressed', 'true'); });
  });
  $('b-ortho').onclick = () => setOrtho(camera !== orthoCam);
  $('b-edges').onclick = () => toggleDisplay('edges');
  $('b-wire').onclick = () => toggleDisplay('wire');
  $('b-xray').onclick = () => toggleDisplay('xray');
  $('b-section').onclick = () => toggleDisplay('section');
  $('b-up').onclick = () => setUp(!upZ, true);
  $('b-shot').onclick = screenshot;
  $('b-settings').onclick = () => {
    // Firefox doesn't expose openOptionsPage to extension frames inside web pages.
    if (browser.runtime.openOptionsPage) browser.runtime.openOptionsPage().catch(openOptionsTab);
    else openOptionsTab();
  };
  const full = $('b-full');
  if (document.fullscreenEnabled) {
    full.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  } else full.remove();
  document.querySelectorAll('#section [data-axis]').forEach((b) => {
    b.onclick = () => {
      section.axis = b.dataset.axis;
      document.querySelectorAll('#section [data-axis]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      updateSectionPlane();
    };
  });
  $('section-pos').oninput = (e) => { section.pos = Number(e.target.value); updateSectionPlane(); };
  $('section-flip').onclick = () => { section.flip = !section.flip; updateSectionPlane(); };
  $('tree-close').onclick = () => setTreeOpen(false);
  $('tree-open').onclick = () => setTreeOpen(true);
  $('tree-showall').onclick = showAll;
}

function openOptionsTab() {
  window.open(browser.runtime.getURL('options/options.html'), '_blank', 'noopener');
}

function setUi(shown) {
  uiShown = shown;
  applyFeatures();
}

/** Shows/hides features per settings; safe to call any time (live updates). */
function applyFeatures() {
  if (!renderer || !settings) return;
  $('presets').hidden = !(uiShown && settings.viewPresets);
  $('display').hidden = !(uiShown && settings.displayOptions);
  $('b-section').hidden = !settings.sectionPlane;
  $('b-edges').hidden = !edges;
  $('b-wire').hidden = isPoints;
  if (!settings.viewPresets && camera === orthoCam) setOrtho(false);
  controls.mouseButtons.MIDDLE = settings.orbitPoint ? -1 : MOUSE.DOLLY;
  applyTreeVisibility();
  applyDisplay();
}

// ---------------------------------------------------------------------------
// Model tree
// ---------------------------------------------------------------------------
// Two backends: "ranges" (our merged mesh: nodes are triangle ranges, hidden
// parts are dropped from the draw groups) and "objects" (glTF scene graph:
// nodes are Object3Ds and use .visible).
let tree = null; // { kind, roots, all, ... }

function treeOpenPref() {
  try { const v = localStorage.getItem('stepside.treeOpen'); if (v != null) return v === '1'; } catch { /* storage blocked */ }
  return document.body.clientWidth >= 640;
}

function setTreeOpen(open) {
  try { localStorage.setItem('stepside.treeOpen', open ? '1' : '0'); } catch { /* storage blocked */ }
  applyTreeVisibility(open);
}

function applyTreeVisibility(forceOpen) {
  const enabled = settings.modelTree && tree && tree.all.length > 1;
  const open = forceOpen ?? treeOpenPref();
  $('tree').hidden = !(enabled && open);
  $('tree-open').hidden = !(enabled && !open);
  infoEl.style.left = enabled && open ? '278px' : '';
}

function buildTreeFromRanges(d) {
  if (!d.tree || !d.tree.length) return;
  const all = d.tree.map((n, i) => ({
    id: i, name: n.name, depth: n.depth, start: n.start, count: n.count, children: [], parent: null, hidden: false,
    bounds: d.treeBounds ? Array.from(d.treeBounds.subarray(i * 6, i * 6 + 6)) : null,
  }));
  const roots = [], stack = [];
  for (const n of all) {
    while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
    if (stack.length) { n.parent = stack[stack.length - 1]; n.parent.children.push(n); } else roots.push(n);
    stack.push(n);
  }
  tree = { kind: 'ranges', roots, all };
  renderTree();
}

function buildTreeFromObjects(sceneRoot) {
  const all = [];
  const walk = (obj, depth, parent) => {
    // Skip anonymous single-child wrappers to keep the tree readable.
    let o = obj;
    while (!o.name && o.children.length === 1 && !o.isMesh) o = o.children[0];
    const node = { id: all.length, name: o.name || (o.isMesh ? 'Mesh' : 'Node'), depth, children: [], parent, hidden: false, obj: o };
    all.push(node);
    for (const c of o.children) if (c.isMesh || c.children.length) node.children.push(walk(c, depth + 1, node));
    return node;
  };
  const roots = sceneRoot.children.filter((c) => c.isMesh || c.children.length).map((c) => walk(c, 0, null));
  tree = { kind: 'objects', roots, all };
  renderTree();
}

const CARET = 'M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z';
const EYE = 'M8 2c1.98 0 3.73.76 5.1 1.87C14.4 4.94 15.38 6.3 15.9 7.6a1 1 0 0 1 0 .8c-.52 1.3-1.5 2.66-2.8 3.73C11.73 13.24 9.98 14 8 14s-3.73-.76-5.1-1.87C1.6 11.06.62 9.7.1 8.4a1 1 0 0 1 0-.8c.52-1.3 1.5-2.66 2.8-3.73C4.27 2.76 6.02 2 8 2Zm0 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z';
const EYE_OFF = 'M.14 1.2a.75.75 0 0 1 1.06-.06l13.5 12.25a.75.75 0 1 1-1 1.11l-2.2-2A7.6 7.6 0 0 1 8 14c-1.98 0-3.73-.76-5.1-1.87C1.6 11.06.62 9.7.1 8.4a1 1 0 0 1 0-.8c.43-1.07 1.18-2.18 2.18-3.13L.2 2.26A.75.75 0 0 1 .14 1.2ZM8 2c1.98 0 3.73.76 5.1 1.87 1.3 1.07 2.28 2.43 2.8 3.73a1 1 0 0 1 0 .8c-.3.76-.75 1.52-1.32 2.22L5.06 2.4C6 2.15 6.98 2 8 2Z';

function icon(d) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

function renderTree() {
  const list = $('tree-list');
  list.replaceChildren();
  const frag = document.createDocumentFragment();
  // Roots expanded; a lone root's children too.
  const expandAll = tree.roots.length === 1;
  for (const r of tree.roots) frag.appendChild(nodeEl(r, expandAll || r.children.length < 50));
  list.appendChild(frag);
  const parts = tree.all.filter((n) => !n.children.length).length;
  $('tree-count').textContent = `${parts.toLocaleString('en-US')} part${parts === 1 ? '' : 's'}`;
  applyTreeVisibility();
}

function nodeEl(n, expanded) {
  const wrap = document.createElement('div');
  wrap.setAttribute('role', 'treeitem');
  const row = document.createElement('div');
  row.className = 'node' + (n.hidden ? ' off' : '');
  row.style.paddingLeft = `${4 + Math.min(n.depth, 12) * 12}px`;
  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'caret' + (n.children.length ? '' : ' leaf');
  caret.replaceChildren(icon(CARET));
  caret.setAttribute('aria-expanded', String(!!expanded));
  caret.setAttribute('aria-label', 'Expand');
  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'eye';
  eye.title = 'Show/hide (Alt-click: show only this)';
  eye.replaceChildren(icon(n.hidden ? EYE_OFF : EYE));
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = n.name;
  name.title = `${n.name} — click to zoom to it`;
  row.append(caret, eye, name);
  if (n.children.length) {
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = n.children.length;
    row.append(c);
  }
  wrap.appendChild(row);
  const kids = document.createElement('div');
  kids.setAttribute('role', 'group');
  wrap.appendChild(kids);
  n.el = { row, eye, kids };
  const fill = () => { if (!kids.childElementCount) for (const ch of n.children) kids.appendChild(nodeEl(ch, false)); };
  if (expanded && n.children.length) fill(); else kids.hidden = true;
  caret.onclick = () => {
    const open = caret.getAttribute('aria-expanded') !== 'true';
    caret.setAttribute('aria-expanded', String(open));
    if (open) fill();
    kids.hidden = !open;
  };
  eye.onclick = (ev) => {
    if (ev.altKey) isolate(n); else setHidden(n, !n.hidden);
  };
  name.onclick = () => zoomTo(n);
  name.ondblclick = () => isolate(n);
  return wrap;
}

function setHidden(n, hidden) {
  n.hidden = hidden;
  if (n.el) {
    n.el.row.classList.toggle('off', hidden);
    n.el.eye.replaceChildren(icon(hidden ? EYE_OFF : EYE));
    n.el.kids.classList.toggle('branch-off', hidden);
  }
  if (tree.kind === 'objects') n.obj.visible = !hidden;
  applyVisibility();
}

/** Shows only `n`: its ancestors and descendants stay visible, all else hides. */
function isolate(n) {
  const keep = new Set();
  for (let p = n; p; p = p.parent) keep.add(p);
  const inside = (m) => { for (let p = m; p; p = p.parent) if (p === n) return true; return false; };
  for (const m of tree.all) {
    m.hidden = !(keep.has(m) || inside(m));
    if (m.el) { m.el.row.classList.toggle('off', m.hidden); m.el.eye.replaceChildren(icon(m.hidden ? EYE_OFF : EYE)); m.el.kids.classList.toggle('branch-off', m.hidden); }
    if (tree.kind === 'objects') m.obj.visible = !m.hidden;
  }
  applyVisibility();
}

function showAll() {
  if (!tree) return;
  for (const n of tree.all) {
    n.hidden = false;
    if (n.el) { n.el.row.classList.remove('off'); n.el.eye.replaceChildren(icon(EYE)); n.el.kids.classList.remove('branch-off'); }
    if (tree.kind === 'objects') n.obj.visible = true;
  }
  applyVisibility();
}

/** Visible triangle runs: leaves under no hidden node, merged when adjacent. */
function visibleRuns() {
  const runs = [];
  const visit = (n) => {
    if (n.hidden) return;
    if (!n.children.length) {
      if (!n.count) return;
      const last = runs[runs.length - 1];
      if (last && last[0] + last[1] === n.start) last[1] += n.count;
      else runs.push([n.start, n.count]);
      return;
    }
    for (const c of n.children) visit(c);
  };
  for (const r of tree.roots) visit(r);
  return runs;
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

function applyVisibility() {
  if (!tree || tree.kind !== 'ranges' || !model || !model.geometry.index) { requestRender(); return; }
  const runs = visibleRuns();
  const g = model.geometry;
  g.clearGroups();
  for (const [s, c] of runs) g.addGroup(s * 3, c * 3, 0);
  if (edges) {
    const eg = edges.geometry;
    eg.clearGroups();
    if (edgeTri) {
      for (const [s, c] of runs) {
        const a = lowerBound(edgeTri, s), b = lowerBound(edgeTri, s + c);
        if (b > a) eg.addGroup(a * 2, (b - a) * 2, 0);
      }
    } else eg.addGroup(0, Infinity, 0);
  }
  requestRender();
}

/** Zooms to a tree node, keeping the current viewing direction. */
function zoomTo(n) {
  let center, r;
  if (tree.kind === 'objects') {
    const box = new Box3().setFromObject(n.obj);
    if (box.isEmpty()) return;
    center = box.getCenter(new Vector3());
    r = box.getSize(new Vector3()).length() / 2;
  } else {
    if (!n.bounds || !n.count) return;
    const [x0, y0, z0, x1, y1, z1] = n.bounds;
    center = new Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2).applyMatrix4(model.matrixWorld);
    r = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
  }
  r = Math.max(r, radius * 0.002);
  const dir = camera.position.clone().sub(controls.target).normalize();
  const zoom = camera === orthoCam ? (radius * 1.05) / (r * 1.1) : null;
  moveCamera(center, dir.multiplyScalar(fitDistance(r)), zoom, true);
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

  gltfRoot = gltf.scene || gltf.scenes[0];
  const box = new Box3().setFromObject(gltfRoot);
  const center = box.getCenter(new Vector3()), size = box.getSize(new Vector3());
  gltfRoot.position.sub(center);
  radius = size.length() / 2 || 1;
  let tris = 0;
  gltfRoot.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) registerMaterial(m);
    }
  });
  root.add(gltfRoot);
  model = gltfRoot;
  frameCenter = [0, 0, 0];
  revealViewer();
  hideStatus();
  buildTreeFromObjects(gltfRoot);
  const total = performance.now() - t0;
  infoEl.textContent = [`${fmtInt(tris)} triangles`, fmtSize(size.toArray(), null), `${(total / 1000).toFixed(2)} s`].join('  ·  ');
  infoEl.hidden = false;
  applyDisplay();
}

// ---------------------------------------------------------------------------
// Status UI
// ---------------------------------------------------------------------------
function setStatus(text, actions = null, isError = false) {
  statusEl.hidden = false;
  statusEl.classList.toggle('error', isError);
  if (isError) statusEl.classList.remove('compact');
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
