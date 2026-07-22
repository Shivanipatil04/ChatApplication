/**
 * E2EE — Identity Key Manager
 *
 * Generates a fresh ECDH P-256 identity key pair on every login and uploads
 * the public key to the server. The private key lives in IndexedDB and never
 * leaves the browser.
 *
 * Why regenerate on every login:
 *   The ECDH shared secret = ECDH(myPrivate, theirPublic). Both sides must use
 *   the SAME key pair for this to be symmetric. If a key pair was generated on
 *   one device/origin and the other user's server entry is overwritten, the
 *   secrets diverge. Always regenerating on login and always re-uploading
 *   guarantees the server has exactly the public key that matches the private
 *   key in the current browser's IDB.
 *
 * TODO(v2): persistent key pairs with a signed pre-key bundle for cross-device
 * message history recovery.
 */

import { idbSet, idbGet } from './idbStore';
import { API_URL } from '../config/api';

const PRIVATE_KEY_IDB = 'identity:privateKey';
const PUBLIC_KEY_IDB  = 'identity:publicKey';

const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' };

// In-memory cache: userId → CryptoKey (public, ECDH)
const peerKeyCache = new Map();

// ---- Helpers ----------------------------------------------------------------

function bufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// ---- Session key cleanup ----------------------------------------------------

/**
 * Delete all derived session + group keys from IndexedDB.
 * Must be called whenever the identity key pair is regenerated so that
 * stale derived keys are not used to decrypt messages.
 */
async function clearDerivedKeys() {
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('e2ee-keys', 1);
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
    await new Promise((resolve, reject) => {
      const tx    = db.transaction('keys', 'readwrite');
      const store = tx.objectStore('keys');
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = (e) => {
        for (const key of e.target.result) {
          if (key.startsWith('session:') || key.startsWith('groupKey:')) {
            store.delete(key);
          }
        }
        tx.oncomplete = () => resolve();
        tx.onerror    = (err) => reject(err);
      };
      keysReq.onerror = (e) => reject(e.target.error);
    });
    console.info('[E2EE] Cleared stale session/group keys from IndexedDB.');
  } catch (err) {
    console.warn('[E2EE] Could not clear derived keys:', err);
  }
}

// ---- Public API -------------------------------------------------------------

/**
 * Called on every login / registration success.
 * Always generates a fresh key pair and uploads the public key so the server
 * entry always matches the private key in the current browser's IndexedDB.
 *
 * @param {string} token — JWT for the upload request
 */
export async function ensureIdentityKeyPair(token) {
  try {
    // Always generate fresh keys on login — this is the only way to guarantee
    // that the server's public key matches the private key in this IDB.
    const keyPair = await crypto.subtle.generateKey(
      ECDH_PARAMS,
      false, // private key non-extractable
      ['deriveKey', 'deriveBits'],
    );

    await idbSet(PRIVATE_KEY_IDB, keyPair.privateKey);
    await idbSet(PUBLIC_KEY_IDB,  keyPair.publicKey);
    console.info('[E2EE] Fresh identity key pair generated.');

    // Clear stale derived session/group keys — they used the old key pair.
    await clearDerivedKeys();

    // Clear in-memory peer key cache — peers must be re-fetched fresh.
    peerKeyCache.clear();

    // Upload fresh public key to server (upsert).
    const spkiBuffer   = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const publicKeyB64 = bufferToBase64(spkiBuffer);

    const uploadRes = await fetch(`${API_URL}/api/keys/public-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ publicKey: publicKeyB64 }),
    });

    if (uploadRes.ok) {
      console.info('[E2EE] Public key uploaded to server successfully.');
    } else {
      console.warn('[E2EE] Public key upload failed:', uploadRes.status);
    }
  } catch (err) {
    console.error('[E2EE] ensureIdentityKeyPair failed:', err);
  }
}

/**
 * Load our own private ECDH key from IndexedDB.
 * @returns {Promise<CryptoKey|null>}
 */
export async function getOwnPrivateKey() {
  return idbGet(PRIVATE_KEY_IDB);
}

/**
 * Fetch and import a peer's ECDH public key from the server.
 * Results are cached in-memory for the lifetime of the page.
 *
 * @param {string} userId
 * @param {string} token
 * @returns {Promise<CryptoKey>}
 */
export async function fetchPeerPublicKey(userId, token) {
  if (peerKeyCache.has(userId)) return peerKeyCache.get(userId);

  const res = await fetch(`${API_URL}/api/keys/public-key/${userId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`No public key for user ${userId} (HTTP ${res.status})`);
  }

  const { publicKey: b64 } = await res.json();
  const cryptoKey = await crypto.subtle.importKey(
    'spki',
    base64ToBuffer(b64),
    ECDH_PARAMS,
    true,
    [],
  );

  peerKeyCache.set(userId, cryptoKey);
  return cryptoKey;
}

/**
 * Evict one peer's public key from the in-memory cache.
 * @param {string} userId
 */
export function evictPeerKeyCache(userId) {
  peerKeyCache.delete(userId);
}

/**
 * Clear the entire in-memory peer public key cache.
 * Called on login so stale keys from a previous session don't persist.
 */
export function clearPeerKeyCache() {
  peerKeyCache.clear();
}
