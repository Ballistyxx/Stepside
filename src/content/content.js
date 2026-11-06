// Stepside content script. This is the only code that runs on every GitHub
// page, so it is deliberately tiny: a URL regex test on navigation, nothing
// else. The 3D viewer (three.js, workers, WASM) lives in an extension-origin
// iframe that is only created when a supported model file is being viewed.

import browser from 'webextension-polyfill';

const FORMATS = {
  step: 'step', stp: 'step', p21: 'step',
  iges: 'iges', igs: 'iges',
  brep: 'brep', brp: 'brep',
  obj: 'obj', ply: 'ply', off: 'off',
  wrl: 'vrml', vrml: 'vrml',
  gltf: 'gltf', glb: 'glb',
};
const BLOB_RE = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/;
const EXT_RE = /\.([a-z0-9]+)$/i;
const SECTION = 'section[aria-labelledby*="file-name-id"]';
const AUTO_LOAD_LIMIT = 64 * 1024 * 1024;
const HIDE_ATTR = 'data-stepside-hidden';

let state = null; // the currently mounted viewer, if any
let scheduled = false;

function matchFile() {
  const m = BLOB_RE.exec(location.pathname);
  if (!m) return null;
  const ext = EXT_RE.exec(m[3]);
  const format = ext && FORMATS[ext[1].toLowerCase()];
  if (!format) return null;
  return {
    key: location.pathname,
    format,
    name: decodeURIComponent(m[3].split('/').pop()),
    rawUrl: `${location.origin}/${m[1]}/${m[2]}/raw/${m[3]}`,
    repoRaw: `${location.origin}/${m[1]}/${m[2]}/raw/`,
  };
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; check(); });
}

function check() {
  const file = matchFile();
  if (!file) { teardown(); return; }
  // Already mounted (or still waiting for GitHub to render the file view).
  if (state && state.file.key === file.key && (state.host.isConnected || !state.section)) return;
  teardown();
  mount(file);
}

// ---------------------------------------------------------------------------
// Navigation detection without polling. GitHub navigates via Turbo and React
// soft navigation; both update <title>, so a title observer plus the events
// GitHub dispatches cover every path. All of these fire only on navigation.
// ---------------------------------------------------------------------------
for (const ev of ['turbo:load', 'turbo:render', 'soft-nav:end', 'pjax:end']) document.addEventListener(ev, schedule);
window.addEventListener('popstate', schedule);
window.addEventListener('pageshow', schedule);
const titleObserver = new MutationObserver(schedule);
function watchTitle() {
  titleObserver.disconnect();
  if (document.head) titleObserver.observe(document.head, { childList: true });
  const t = document.querySelector('head > title');
  if (t) titleObserver.observe(t, { childList: true, characterData: true, subtree: true });
}
watchTitle();
new MutationObserver(watchTitle).observe(document.documentElement, { childList: true });
schedule();

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------
// The file view is server-rendered and then hydrated by React; touching it
// before hydration finishes makes React throw the subtree away. GitHub marks
// <react-app> with class "loaded" once it's done, so wait for that (falling
// back to a short grace period in case that signal ever disappears).
const HYDRATION_GRACE_MS = 2500;

function waitForSection(file, cb) {
  let firstSeen = 0;
  const ready = () => {
    const s = document.querySelector(SECTION);
    if (!s) return null;
    const app = s.closest('react-app');
    if (!app || app.classList.contains('loaded')) return s;
    firstSeen ||= performance.now();
    return performance.now() - firstSeen > HYDRATION_GRACE_MS ? s : null;
  };
  const el = ready();
  if (el) { cb(el); return () => {}; }
  // Short-lived observer while GitHub renders the file view (≤ 15 s).
  const tryNow = () => {
    if (location.pathname !== file.key) { stop(); return; }
    const s = ready();
    if (s) { stop(); cb(s); }
  };
  const obs = new MutationObserver(tryNow);
  const grace = setTimeout(tryNow, HYDRATION_GRACE_MS + 50);
  const timer = setTimeout(() => {
    stop();
    if (state && state.file === file && !state.section) state = null; // allow a later retry
  }, 15000);
  const stop = () => { obs.disconnect(); clearTimeout(timer); clearTimeout(grace); };
  obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  return stop;
}

function mount(file) {
  const st = { file, host: document.createElement('div'), stopWait: null, observers: [], xhr: null, port: null, source: false };
  state = st;
  // Start downloading right away; messages queue on the channel until the
  // viewer iframe exists and picks up the other end.
  st.channel = new MessageChannel();
  st.port = st.channel.port1;
  st.port.onmessage = (e) => onViewerMessage(st, e.data);
  download(st, false);
  st.stopWait = waitForSection(file, (section) => {
    if (state !== st) return;
    attach(st, section);
  });
}

function attach(st, section) {
  injectStyle();
  const { file } = st;
  const host = st.host;
  host.className = 'stepside-host';
  host.innerHTML = `
    <div class="stepside-bar">
      <div class="stepside-seg" role="group" aria-label="View mode">
        <button type="button" data-mode="3d" aria-pressed="true">3D</button>
        <button type="button" data-mode="source" aria-pressed="false">Source</button>
      </div>
      <span class="stepside-label"></span>
    </div>
    <div class="stepside-frame"></div>`;
  host.querySelector('.stepside-label').textContent = `Stepside · ${labelFor(file.format)}`;
  host.querySelectorAll('.stepside-seg button').forEach((b) => {
    b.addEventListener('click', () => setMode(st, b.dataset.mode));
  });

  const frameWrap = host.querySelector('.stepside-frame');
  frameWrap.style.height = `${Math.round(Math.min(Math.max(window.innerHeight * 0.7, 360), 820))}px`;
  const iframe = document.createElement('iframe');
  iframe.src = browser.runtime.getURL('viewer/viewer.html');
  iframe.title = `3D preview of ${file.name}`;
  iframe.allow = 'fullscreen';
  iframe.allowFullscreen = true;
  iframe.setAttribute('loading', 'eager');
  frameWrap.appendChild(iframe);

  section.prepend(host);
  section.setAttribute(HIDE_ATTR, '');
  st.section = section;

  iframe.addEventListener('load', () => {
    if (state !== st) return;
    const extOrigin = new URL(browser.runtime.getURL('')).origin;
    iframe.contentWindow.postMessage({
      stepside: 'init', format: file.format, name: file.name, fileUrl: file.rawUrl, theme: theme(),
    }, extOrigin, [st.channel.port2]);
  }, { once: true });

  // If GitHub re-renders and drops our node (or the section), re-mount.
  const reattach = new MutationObserver(() => {
    if (state === st && !host.isConnected) { teardown(); schedule(); }
  });
  reattach.observe(section, { childList: true });
  if (section.parentNode) reattach.observe(section.parentNode, { childList: true });
  st.observers.push(reattach);
}

function setMode(st, mode) {
  st.source = mode === 'source';
  st.host.querySelectorAll('.stepside-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  st.host.toggleAttribute('data-source', st.source);
  if (st.section) st.section.toggleAttribute(HIDE_ATTR, !st.source);
}

function teardown() {
  const st = state;
  if (!st) return;
  state = null;
  if (st.stopWait) st.stopWait();
  st.observers.forEach((o) => o.disconnect());
  if (st.xhr) st.xhr.abort();
  if (st.port) st.port.close();
  st.host.remove(); // destroys the iframe => worker, WebGL context and memory go with it
  if (st.section) st.section.removeAttribute(HIDE_ATTR);
}

// ---------------------------------------------------------------------------
// Downloads run here, in the page's context, so private repos and LFS work
// with the user's GitHub session. Bytes are transferred to the viewer.
// ---------------------------------------------------------------------------
const PageXHR = (typeof content === 'object' && content && content.XMLHttpRequest) || XMLHttpRequest;

function getBytes(url, { onProgress, limit, onXhr } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new PageXHR();
    if (onXhr) onXhr(xhr);
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 2 && limit) {
        const len = Number(xhr.getResponseHeader('Content-Length'));
        if (len > limit) { xhr.abort(); resolve({ tooLarge: len }); }
      }
    };
    if (onProgress) xhr.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : 0);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({ buffer: xhr.response });
      else reject(new Error(`download failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('download failed (network error)'));
    xhr.send();
  });
}

function post(st, msg, transfer) {
  if (state !== st) return;
  try { st.port.postMessage(msg, transfer || []); }
  catch { st.port.postMessage(msg); } // cross-compartment buffers (Firefox) may refuse transfer
}

async function download(st, force) {
  let last = 0;
  try {
    const res = await getBytes(st.file.rawUrl, {
      limit: force ? 0 : AUTO_LOAD_LIMIT,
      onXhr: (x) => { st.xhr = x; },
      onProgress: (loaded, total) => {
        const now = performance.now();
        if (now - last > 100) { last = now; post(st, { type: 'progress', loaded, total }); }
      },
    });
    st.xhr = null;
    if (res.tooLarge) post(st, { type: 'too-large', size: res.tooLarge });
    else post(st, { type: 'file', buffer: res.buffer }, [res.buffer]);
  } catch (err) {
    post(st, { type: 'error', message: err.message });
  }
}

async function onViewerMessage(st, d) {
  if (state !== st || !d) return;
  if (d.type === 'force') download(st, true);
  else if (d.type === 'show-source') setMode(st, 'source');
  else if (d.type === 'fetch') {
    // Only sibling files from the same repository are ever fetched.
    let url;
    try { url = new URL(d.url); } catch { url = null; }
    if (!url || url.origin !== location.origin || !url.href.startsWith(st.file.repoRaw)) {
      post(st, { type: 'fetch-result', id: d.id, error: 'blocked' });
      return;
    }
    try {
      const res = await getBytes(url.href);
      post(st, { type: 'fetch-result', id: d.id, buffer: res.buffer }, [res.buffer]);
    } catch (err) {
      post(st, { type: 'fetch-result', id: d.id, error: err.message });
    }
  }
}

// ---------------------------------------------------------------------------
function theme() {
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--bgColor-muted').trim();
  return { dark: isDark(bodyBg), bg: muted || bodyBg };
}

function isDark(rgb) {
  const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(rgb || '');
  if (!m) return matchMedia('(prefers-color-scheme: dark)').matches;
  return 0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3] < 128;
}

function labelFor(f) {
  return { step: 'STEP', iges: 'IGES', brep: 'BREP', obj: 'OBJ', ply: 'PLY', off: 'OFF', vrml: 'VRML', gltf: 'glTF', glb: 'glTF' }[f];
}

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = `
[${HIDE_ATTR}] > :not(.stepside-host) { display: none !important; }
.stepside-host { display: block; }
.stepside-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px; border-bottom: 1px solid var(--borderColor-default, #d1d9e0);
}
.stepside-host[data-source] .stepside-bar { border-bottom-color: transparent; }
.stepside-seg { display: inline-flex; border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; overflow: hidden; }
.stepside-seg button {
  font: inherit; font-size: 12px; font-weight: 500; line-height: 20px; padding: 3px 12px; margin: 0;
  border: 0; background: var(--bgColor-default, #fff); color: var(--fgColor-muted, #59636e); cursor: pointer;
}
.stepside-seg button + button { border-left: 1px solid var(--borderColor-default, #d1d9e0); }
.stepside-seg button[aria-pressed="true"] { background: var(--bgColor-muted, #f6f8fa); color: var(--fgColor-default, #1f2328); font-weight: 600; }
.stepside-seg button:hover { color: var(--fgColor-default, #1f2328); }
.stepside-label { font-size: 12px; color: var(--fgColor-muted, #59636e); }
.stepside-frame { position: relative; resize: vertical; overflow: hidden; min-height: 240px; border-radius: 0 0 6px 6px; }
.stepside-frame iframe { display: block; width: 100%; height: 100%; border: 0; }
.stepside-host[data-source] .stepside-frame { display: none; }`;
  document.head.appendChild(s);
}
