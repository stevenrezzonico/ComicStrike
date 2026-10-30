// Hands a compiled map from the map editor to a game page (Play alone, Host for friends):
// the editor stores it here, then opens `/?fromeditor`, which takes it out. IndexedDB, not
// a message to the opened tab: it works whether the browser opens a new tab or reuses this
// one, and holds maps of any size (localStorage keeps a few MB of text).

const DB = 'comicstrike', STORE = 'handoff', KEY = 'play';

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function request(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const r = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      d.close();
      resolve(r && r.result);
    };
    tx.onerror = () => {
      d.close();
      reject(tx.error);
    };
  }));
}

// value: { action: 'practice' | 'host', name, bytes, mode, players, difficulty, team }
export const putHandoff = (value) => request('readwrite', (s) => s.put({ ...value, at: Date.now() }, KEY));

// The waiting map, taken out (null if none, or older than a minute: a stale one).
export async function takeHandoff() {
  let value = null;
  await request('readwrite', (s) => {
    const r = s.get(KEY);
    r.onsuccess = () => {
      value = r.result || null;
      s.delete(KEY);
    };
    return null;
  });
  return value && Date.now() - value.at < 60000 ? value : null;
}
