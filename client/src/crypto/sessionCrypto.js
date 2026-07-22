/**
 * E2EE — 1:1 Session Crypto
 *
 * Derives a per-conversation AES-256-GCM session key via:
 *   ECDH(myPrivateKey, theirPublicKey) → 32-byte sharedSecret
 *   HKDF(sharedSecret, salt=conversationId, info="chatapp-e2ee-v1") → AES-256-GCM key
 *
 * Session keys are cached in IndexedDB for performance.  On decryption failure
 * the cache entry is evicted and the key is re-derived from the server's
 * current public key — this handles the case where the peer regenerated their
 * key pair (e.g. after logging in on a new device/origin).
 */

import { idbGet, idbSet, idbDelete } from './idbStore';
import { getOwnPrivateKey, fetchPeerPublicKey, evictPeerKeyCache } from './keyManager';

const AES_PARAMS  = { name: 'AES-GCM', length: 256 };
const HKDF_INFO   = new TextEncoder().encode('chatapp-e2ee-v1');
const IV_LENGTH   = 12;

function bufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// ---- Session key derivation -------------------------------------------------

/**
 * Derive the AES session key from scratch — always fetches peer's public key
 * fresh from the server (no cache).
 */
async function deriveSessionKeyFresh(myUserId, theirUserId, token) {
  const conversationId = [myUserId, theirUserId].sort().join(':');

  const myPrivateKey   = await getOwnPrivateKey();
  if (!myPrivateKey) throw new Error('E2EE: own private key not found in IndexedDB');

  // Evict any cached public key so we always fetch the latest from the server.
  evictPeerKeyCache(theirUserId);
  const theirPublicKey = await fetchPeerPublicKey(theirUserId, token);

  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirPublicKey },
    myPrivateKey,
    256,
  );

  const hkdfKey = await crypto.subtle.importKey(
    'raw', sharedBits, { name: 'HKDF' }, false, ['deriveKey'],
  );

  const salt = new TextEncoder().encode(conversationId);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    hkdfKey,
    AES_PARAMS,
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Get the cached session key, or derive and cache a fresh one.
 */
async function getOrDeriveSessionKey(myUserId, theirUserId, token) {
  const conversationId = [myUserId, theirUserId].sort().join(':');
  const idbKey = `session:${conversationId}`;

  const cached = await idbGet(idbKey);
  if (cached) return { key: cached, idbKey };

  const sessionKey = await deriveSessionKeyFresh(myUserId, theirUserId, token);
  await idbSet(idbKey, sessionKey);
  return { key: sessionKey, idbKey };
}

// ---- Encrypt ----------------------------------------------------------------

export async function encryptDirect(myUserId, theirUserId, plaintext, token) {
  const { key: sessionKey } = await getOrDeriveSessionKey(myUserId, theirUserId, token);

  const iv      = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sessionKey,
    encoded,
  );

  return btoa(JSON.stringify({
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv),
  }));
}

// ---- Decrypt ----------------------------------------------------------------

/**
 * Decrypt a message payload.
 * On failure: evict stale cached key, re-derive from server's current public
 * key, and retry once.  This auto-recovers from peer key rotation.
 */
export async function decryptDirect(myUserId, theirUserId, payloadB64, token) {
  const { key: sessionKey, idbKey } = await getOrDeriveSessionKey(myUserId, theirUserId, token);

  const { ciphertext, iv } = JSON.parse(atob(payloadB64));

  try {
    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuffer(iv) },
      sessionKey,
      base64ToBuffer(ciphertext),
    );
    return new TextDecoder().decode(plainBuffer);
  } catch {
    // Decryption failed — the cached session key is stale.
    // Evict it from IDB and re-derive using the server's current public key.
    await idbDelete(idbKey);
    evictPeerKeyCache(theirUserId);

    const freshKey = await deriveSessionKeyFresh(myUserId, theirUserId, token);
    const conversationId = [myUserId, theirUserId].sort().join(':');
    await idbSet(`session:${conversationId}`, freshKey);

    // Retry with the fresh key.
    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuffer(iv) },
      freshKey,
      base64ToBuffer(ciphertext),
    );
    return new TextDecoder().decode(plainBuffer);
    // If this also fails, the error propagates to decryptMessage() in
    // encryptionService.js which returns DECRYPT_FALLBACK.
  }
}
