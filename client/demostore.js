// Saved demos (client/demo.js) in IndexedDB, a database of their own (the editor's handoff,
// client/handoff.js, keeps its version-1 database): `meta` holds { name, map, at, seconds,
// size } per name, `data` the bytes, so listing them reads no demo. Also downloads.

const DB = 'comicstrike-demos', META = 'meta', DATA = 'data';

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(META);
      r.result.createObjectStore(DATA);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Runs fn(stores) in one transaction over both stores; resolves with what fn put in `out`.
function transact(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction([META, DATA], mode), out = {};
    fn(tx.objectStore(META), tx.objectStore(DATA), out);
    tx.oncomplete = () => {
      d.close();
      resolve(out.value);
    };
    tx.onerror = tx.onabort = () => {
      d.close();
      reject(tx.error || new Error('storage failed'));
    };
  }));
}

// meta: { name, map, seconds }, bytes: Uint8Array (a whole demo file).
export const saveDemo = (meta, bytes) => transact('readwrite', (m, d) => {
  m.put({ ...meta, at: Date.now(), size: bytes.length }, meta.name);
  d.put(bytes, meta.name);
});

// The demo's bytes, or null.
export const loadDemo = (name) => transact('readonly', (_m, d, out) => {
  const r = d.get(name);
  r.onsuccess = () => (out.value = r.result || null);
});

// Every saved demo's meta, newest first.
export const listDemos = () => transact('readonly', (m, _d, out) => {
  const r = m.getAll();
  r.onsuccess = () => (out.value = (r.result || []).sort((a, b) => b.at - a.at));
});

export const deleteDemo = (name) => transact('readwrite', (m, d) => {
  m.delete(name);
  d.delete(name);
});

// Saves `bytes` as a file named `name`.csdemo through the browser's download.
export function downloadDemo(name, bytes) {
  downloadFile(`${name}.csdemo`, bytes);
}

// Saves `data` (bytes or text) as a file named `fileName` through the browser's download.
export function downloadFile(fileName, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
