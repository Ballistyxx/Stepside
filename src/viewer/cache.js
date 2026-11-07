// Content-addressed mesh cache (IndexedDB, extension origin). Keyed by the
// SHA-256 of the file bytes, so a re-visit of the same file — on any URL,
// branch or commit — skips parsing/tessellation entirely. LRU-bounded.

const DB_NAME = 'stepside';
const VERSION = 1;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY = 192 * 1024 * 1024;
const SCHEMA = 2; // bump to invalidate entries when the mesh format changes

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

export async function cacheKey(format, buffer) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  let hex = '';
  for (const b of hash) hex += b.toString(16).padStart(2, '0');
  return `${SCHEMA}:${format}:${hex}`;
}

export async function cacheGet(key) {
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
  for (const k of ['position', 'normal', 'color', 'index']) if (mesh[k]) n += mesh[k].byteLength;
  return n + (edges ? edges.byteLength : 0);
}

export async function cachePut(key, mesh, edges) {
  try {
    const bytes = sizeOf(mesh, edges);
    if (bytes > MAX_ENTRY) return;
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
  if (total > MAX_BYTES) {
    const order = keys.map((k, i) => [k, vals[i]]).sort((a, b) => a[1].used - b[1].used);
    for (const [k, v] of order) {
      if (total <= MAX_BYTES) break;
      tx.objectStore('meshes').delete(k);
      meta.delete(k);
      total -= v.bytes;
    }
  }
  await done(tx);
}
