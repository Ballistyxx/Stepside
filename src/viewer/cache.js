// Content-addressed mesh cache (IndexedDB, extension origin). Keyed by the
// SHA-256 of the file bytes, so a re-visit of the same file — on any URL,
// branch or commit — skips parsing/tessellation entirely. LRU-bounded.

const DB_NAME = 'stepside';
const VERSION = 1;
const SCHEMA = 3; // bump to invalidate entries when the mesh format changes
let maxBytes = 512 * 1024 * 1024; // from settings (cacheMB); 0 disables caching

/** Applies the user's cache size setting (MB). */
export function setCacheLimit(mb) {
  maxBytes = Math.max(0, Number(mb) || 0) * 1024 * 1024;
}

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('meshes');
        db.createObjectStore('meta'); // key -> {bytes, used}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    }).catch(() => null); // private browsing etc.: run without a cache
  }
  return dbPromise;
}

const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

/** `variant` covers settings that change the result (e.g. CAD tessellation quality). */
export async function cacheKey(format, buffer, variant = '') {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  let hex = '';
  for (const b of hash) hex += b.toString(16).padStart(2, '0');
  return `${SCHEMA}:${format}:${variant}:${hex}`;
}

export async function cacheGet(key) {
  if (!maxBytes) return null;
  try {
    const db = await open();
    if (!db) return null;
    const tx = db.transaction(['meshes', 'meta'], 'readwrite');
    const entry = await wrap(tx.objectStore('meshes').get(key));
    if (entry) {
      const meta = tx.objectStore('meta');
      const m = await wrap(meta.get(key));
      if (m) meta.put({ ...m, used: Date.now() }, key);
    }
    await done(tx);
    return entry || null;
  } catch {
    return null;
  }
}

function sizeOf(mesh, edges) {
  let n = 0;
  for (const k of ['position', 'normal', 'color', 'index', 'treeBounds']) if (mesh[k]) n += mesh[k].byteLength;
  if (edges) n += edges.positions.byteLength + edges.tri.byteLength;
  return n;
}

export async function cachePut(key, mesh, edges) {
  try {
    const bytes = sizeOf(mesh, edges);
    if (!maxBytes || bytes > maxBytes * 0.5) return; // one model may use at most half the cache
    const db = await open();
    if (!db) return;
    const tx = db.transaction(['meshes', 'meta'], 'readwrite');
    tx.objectStore('meshes').put({ mesh, edges }, key); // structured clone happens here, synchronously
    tx.objectStore('meta').put({ bytes, used: Date.now() }, key);
    await done(tx);
    await evict(db);
  } catch {
    /* quota or private mode: ignore */
  }
}

async function evict(db) {
  const tx = db.transaction(['meshes', 'meta'], 'readwrite');
  const meta = tx.objectStore('meta');
  const [keys, vals] = await Promise.all([wrap(meta.getAllKeys()), wrap(meta.getAll())]);
  let total = vals.reduce((a, v) => a + v.bytes, 0);
  if (total > maxBytes) {
    const order = keys.map((k, i) => [k, vals[i]]).sort((a, b) => a[1].used - b[1].used);
    for (const [k, v] of order) {
      if (total <= maxBytes) break;
      tx.objectStore('meshes').delete(k);
      meta.delete(k);
      total -= v.bytes;
    }
  }
  await done(tx);
}

/** {bytes, count} currently stored. */
export async function cacheUsage() {
  try {
    const db = await open();
    if (!db) return { bytes: 0, count: 0 };
    const tx = db.transaction('meta', 'readonly');
    const vals = await wrap(tx.objectStore('meta').getAll());
    return { bytes: vals.reduce((a, v) => a + v.bytes, 0), count: vals.length };
  } catch {
    return { bytes: 0, count: 0 };
  }
}

export async function cacheClear() {
  const db = await open();
  if (!db) return;
  const tx = db.transaction(['meshes', 'meta'], 'readwrite');
  tx.objectStore('meshes').clear();
  tx.objectStore('meta').clear();
  await done(tx);
}

/** Shrinks the cache to the current limit (after the limit is lowered). */
export async function cacheTrim() {
  const db = await open();
  if (db) await evict(db);
}
