/**
 * E2EE — IndexedDB store for private key material
 *
 * Exposes a minimal async key-value API over a single IndexedDB database
 * ("e2ee-keys", object store "keys").  Private keys and derived session keys
 * are kept here and NEVER written to:
 *   - localStorage / sessionStorage
 *   - Redux / React state / any in-memory global that could be serialised
 *   - Any network request to the server
 *   - console.log or any logging output
 *
 * Key names used by the rest of the crypto layer:
 *   "identity:privateKey"          → CryptoKey (ECDH, private, non-extractable)
 *   "identity:publicKey"           → CryptoKey (ECDH, public, extractable)
 *   "session:<conversationId>"     → CryptoKey (AES-GCM, non-extractable)
 *   "groupKey:<groupId>"           → CryptoKey (AES-GCM, non-extractable)
 */

const DB_NAME    = 'e2ee-keys';
const STORE_NAME = 'keys';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess  = (event) => { _db = event.target.result; resolve(_db); };
    req.onerror    = (event) => reject(event.target.error);
  });
}

/**
 * Store a value under `key`.  Value can be a CryptoKey, plain string, or
 * any structured-clone-compatible type.
 */
export async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Retrieve the value stored under `key`.  Returns undefined if not found.
 */
export async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.get(key);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Delete the entry for `key`.  No-op if the key does not exist.
 */
export async function idbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}
