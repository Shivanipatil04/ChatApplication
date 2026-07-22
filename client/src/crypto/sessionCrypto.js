/**
 * E2EE — 1:1 Session Crypto
 *
 * Derives a per-conversation AES-256-GCM session key via:
 *   ECDH(myPrivateKey, theirPublicKey) → 32-byte sharedSecret
 *   HKDF(sharedSecret, salt=conversationId, info="chatapp-e2ee-v1") → AES-256-GCM key
 *
 * The derived key is cached in IndexedDB under "session:<conversationId>" so
 * it survives page reloads without requiring another ECDH operation.
 *
 * Encrypt/decrypt use AES-256-GCM with a random 12-byte IV per message.
 * SubtleCrypto's GCM mode appends the 16-byte authentication tag to the
 * ciphertext automatically — the output blob is (ciphertext + tag), making
 * it a single base64 string for storage.
 *
 * Wire format stored in Chat.msg (base64-encoded JSON):
 *   base64( JSON.stringify({ ciphertext: "<base64>", iv: "<base64>" }) )
 */

import { idbGet, idbSet } from './idbStore';
import { getOwnPrivateKey, fetchPeerPublicKey } from './keyManager';

const AES_PARAMS  = { name: 'AES-GCM', length: 256 };
const HKDF_INFO   = new TextEncoder().encode('chatapp-e2ee-v1');
const IV_LENGTH   = 12; // bytes — GCM standard

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

// ---- Session key derivation -------------------------------------------------

/**
 * Derive and cache the AES session key for a 1:1 conversation.
 *
 * The conversationId is a stable string that both sides compute identically —
 * we use the lexicographically-sorted pair of the two user IDs joined by ':'
 * so it doesn't matter which side is "sender" vs "recipient".
 *
 * @param {string} myUserId
 * @param {string} theirUserId
 * @param {string} token — JWT for fetching the peer's public key if needed
 * @returns {Promise<CryptoKey>} AES-256-GCM non-extractable session key
 */
export async function getOrDeriveSessionKey(myUserId, theirUserId, token) {
  // Canonical conversation id — order-independent
  const conversationId = [myUserId, theirUserId].sort().join(':');
  const idbKey = `session:${conversationId}`;

  // Return cached key from IndexedDB if available.
  const cached = await idbGet(idbKey);
  if (cached) return cached;

  // Derive fresh key via ECDH + HKDF.
  const myPrivateKey   = await getOwnPrivateKey();
  const theirPublicKey = await fetchPeerPublicKey(theirUserId, token);

  if (!myPrivateKey) {
    throw new Error('E2EE: own private key not found in IndexedDB');
  }

  // Step 1: ECDH → raw shared secret bits
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirPublicKey },
    myPrivateKey,
    256, // P-256 gives 256 bits
  );

  // Step 2: Import the shared bits as an HKDF source key
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    sharedBits,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );

  // Step 3: HKDF → AES-256-GCM key, salted with the conversation id
  const salt = new TextEncoder().encode(conversationId);
  const sessionKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    hkdfKey,
    AES_PARAMS,
    false, // non-extractable — stays in memory / IndexedDB only
    ['encrypt', 'decrypt'],
  );

  await idbSet(idbKey, sessionKey);
  return sessionKey;
}

// ---- Encrypt ----------------------------------------------------------------

/**
 * Encrypt a plaintext string for a 1:1 conversation.
 *
 * @param {string} myUserId
 * @param {string} theirUserId
 * @param {string} plaintext
 * @param {string} token
 * @returns {Promise<string>}  base64-encoded JSON payload { ciphertext, iv }
 */
export async function encryptDirect(myUserId, theirUserId, plaintext, token) {
  const sessionKey = await getOrDeriveSessionKey(myUserId, theirUserId, token);

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sessionKey,
    encoded,
  );

  const payload = {
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv),
  };
  return btoa(JSON.stringify(payload));
}

// ---- Decrypt ----------------------------------------------------------------

/**
 * Decrypt a ciphertext payload for a 1:1 conversation.
 *
 * @param {string} myUserId
 * @param {string} theirUserId
 * @param {string} payloadB64   — the same base64 string produced by encryptDirect
 * @param {string} token
 * @returns {Promise<string>}   plaintext
 * @throws if the payload is malformed or authentication fails
 */
export async function decryptDirect(myUserId, theirUserId, payloadB64, token) {
  const sessionKey = await getOrDeriveSessionKey(myUserId, theirUserId, token);

  const { ciphertext, iv } = JSON.parse(atob(payloadB64));
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuffer(iv) },
    sessionKey,
    base64ToBuffer(ciphertext),
  );

  return new TextDecoder().decode(plainBuffer);
}
