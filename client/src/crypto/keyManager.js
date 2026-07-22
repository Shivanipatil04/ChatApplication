/**
 * E2EE — Identity Key Manager
 *
 * Responsibilities:
 *  1. Generate an ECDH P-256 identity key pair on first login/registration
 *     for this device, and store it in IndexedDB.
 *  2. Export the public key as a base64 SPKI blob and upload it to the server
 *     so other users can fetch it for key agreement.
 *  3. Provide fetchPeerPublicKey(userId) with an in-memory LRU-style cache so
 *     repeated lookups don't hit the network on every message.
 *
 * The PRIVATE key is stored non-extractable in IndexedDB and NEVER leaves
 * the browser.  It is never logged, serialised to state, or sent to the server.
 *
 * TODO(v2): key rotation on new device — implement a signed pre-key bundle
 * exchange so a new device can bootstrap keys from an existing session.
 */

import { idbGet, idbSet } from './idbStore';
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

// ---- Public API -------------------------------------------------------------

/**
 * Called once after a successful login or registration.
 * - If an identity key pair already exists in IndexedDB for this device, it
 *   re-uploads the public key (idempotent upsert on the server) to handle
 *   the case where the DB row was deleted.
 * - If no key pair exists, it generates one and uploads the public key.
 *
 * @param {string} token  — JWT from localStorage, used for the upload request.
 */
export async function ensureIdentityKeyPair(token) {
  try {
    let privateKey = await idbGet(PRIVATE_KEY_IDB);
    let publicKey  = await idbGet(PUBLIC_KEY_IDB);

    if (!privateKey || !publicKey) {
      // Generate a fresh non-extractable ECDH P-256 key pair.
      const keyPair = await crypto.subtle.generateKey(
        ECDH_PARAMS,
        false, // private key is non-extractable — it never leaves IndexedDB
        ['deriveKey', 'deriveBits'],
      );
      privateKey = keyPair.privateKey;
      // Public key must be extractable so we can export and share it.
      publicKey  = keyPair.publicKey;

      await idbSet(PRIVATE_KEY_IDB, privateKey);
      await idbSet(PUBLIC_KEY_IDB,  publicKey);
      console.info('[E2EE] New identity key pair generated and stored in IndexedDB.');
    } else {
      console.info('[E2EE] Existing identity key pair found in IndexedDB.');
    }

    // Export the public key as SPKI and upload it (upsert).
    const spkiBuffer = await crypto.subtle.exportKey('spki', publicKey);
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
      console.warn('[E2EE] Public key upload failed with status:', uploadRes.status);
    }
  } catch (err) {
    // Log the real error so it's visible in DevTools Console.
    console.error('[E2EE] ensureIdentityKeyPair failed:', err);
  }
}

/**
 * Load our own private ECDH key from IndexedDB.
 * Returns null if it hasn't been generated yet (caller should handle gracefully).
 *
 * @returns {Promise<CryptoKey|null>}
 */
export async function getOwnPrivateKey() {
  return idbGet(PRIVATE_KEY_IDB);
}

/**
 * Fetch and import a peer's ECDH public key.
 * Results are cached in-memory for the lifetime of the page so repeated
 * sends to the same contact only hit the network once.
 *
 * @param {string} userId  — the target user's MongoDB _id string
 * @param {string} token   — JWT for the GET request
 * @returns {Promise<CryptoKey>}
 * @throws if the server returns 404 (peer hasn't uploaded a key yet)
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
  const spkiBuffer = base64ToBuffer(b64);

  const cryptoKey = await crypto.subtle.importKey(
    'spki',
    spkiBuffer,
    ECDH_PARAMS,
    true,  // extractable = true for the public key (safe — it's public)
    [],    // ECDH public keys have no usages at import time
  );

  peerKeyCache.set(userId, cryptoKey);
  return cryptoKey;
}

/**
 * Manually evict a peer's cached public key (e.g. after a key-rotation event).
 * @param {string} userId
 */
export function evictPeerKeyCache(userId) {
  peerKeyCache.delete(userId);
}
