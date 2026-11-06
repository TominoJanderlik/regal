// Malý obal nad IndexedDB. Lokálne dáta sú cache + fronta zmien, nie hlavný zdroj.
const DB_NAME = 'regal';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('parcels')) db.createObjectStore('parcels', { keyPath: 'tracking_number' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('released')) db.createObjectStore('released', { keyPath: 'tracking_number' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Databázu prehliadača blokuje iná karta – zavri staršie karty aplikácie.'));
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transakcia zrušená'));
    const handles = Object.fromEntries((Array.isArray(stores) ? stores : [stores]).map((s) => [s, t.objectStore(s)]));
    Promise.resolve(fn(handles, wrap)).then((r) => { result = r; }, (e) => { try { t.abort(); } catch {} reject(e); });
  });
}

export const idb = {
  get: (store, key) => tx(store, 'readonly', (s, w) => w(s[store].get(key))),
  getAll: (store) => tx(store, 'readonly', (s, w) => w(s[store].getAll())),
  put: (store, value, key) => tx(store, 'readwrite', (s, w) => w(key === undefined ? s[store].put(value) : s[store].put(value, key))),
  del: (store, key) => tx(store, 'readwrite', (s, w) => w(s[store].delete(key))),
  clear: (store) => tx(store, 'readwrite', (s, w) => w(s[store].clear())),
};
