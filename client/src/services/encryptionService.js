/**
 * E2EE — Encryption Service (integration surface)
 *
 * This is the ONLY module that existing chat components import from.
 * It exposes two functions:
 *
 *   encryptMessage(context, plaintext) → encrypted payload string (or '' for non-text)
 *   decryptMessage(context, msg)       → plaintext string (or fallback on failure)
 *
 * Context object shape:
 *   {
 *     type:        'direct' | 'group',
 *     myUserId:    string,
 *     theirUserId: string,   // for direct only
 *     groupId:     string,   // for group only
 *     token:       string,   // JWT from localStorage
 *   }
 *
 * Edge cases handled here:
 *   - plaintext is empty / non-string → pass through unchanged (call / attachment messages)
 *   - peer has no public key yet      → fetch on demand (up to 1 retry), then throw
 *   - decryption failure              → return DECRYPT_FALLBACK constant (never crash the UI)
 *   - legacy plaintext in DB          → detected as non-E2EE blob → returned as-is
 *
 * Nothing in this file logs plaintext content or key material.
 */

import { encryptDirect, decryptDirect } from '../crypto/sessionCrypto';
import { encryptGroup, decryptGroup }   from '../crypto/groupCrypto';

/** Displayed in place of a message that cannot be decrypted on this device. */
export const DECRYPT_FALLBACK = '🔒 Unable to decrypt this message';

/**
 * Detect whether a string looks like an E2EE ciphertext blob.
 * Valid blobs are base64-encoded JSON with exactly { ciphertext, iv } keys.
 * Exported so callers (e.g. sidebar preview) can use the same check.
 */
export function isEncryptedPayload(str) {
  if (!str || typeof str !== 'string' || !str.trim()) return false;
  try {
    const parsed = JSON.parse(atob(str));
    return typeof parsed.ciphertext === 'string' && typeof parsed.iv === 'string';
  } catch {
    return false;
  }
}

// ---- Public API -------------------------------------------------------------

/**
 * Encrypt a plaintext message before emitting it over the socket.
 *
 * Only encrypts type='text' messages.  Non-text payloads (audio URL, file URL,
 * location, contact card) are returned unchanged because they don't contain
 * sensitive text content embedded in the msg field.
 *
 * @param {{ type, myUserId, theirUserId?, groupId?, token }} context
 * @param {string} plaintext
 * @returns {Promise<string>}  encrypted payload, or original string if not applicable
 */
export async function encryptMessage(context, plaintext) {
  if (!plaintext || typeof plaintext !== 'string' || !plaintext.trim()) {
    return plaintext; // empty or non-text — pass through
  }

  // E2EE: encryption must succeed — we do NOT fall back to plaintext.
  // If this throws, sendMessage in ChatApp.jsx will catch it and show an error
  // to the user rather than sending an unencrypted message to the server.
  if (context.type === 'direct') {
    return await encryptDirect(context.myUserId, context.theirUserId, plaintext, context.token);
  }
  if (context.type === 'group') {
    return await encryptGroup(context.groupId, context.myUserId, plaintext, context.token);
  }

  return plaintext;
}

/**
 * Decrypt an incoming message payload before rendering it.
 *
 * - If the payload is NOT a valid E2EE blob (legacy plaintext, system message,
 *   empty string) it is returned as-is so existing messages render normally.
 * - If decryption fails (wrong key, corrupted data, new device) it returns
 *   DECRYPT_FALLBACK instead of crashing the UI.
 *
 * @param {{ type, myUserId, theirUserId?, groupId?, token }} context
 * @param {string} msg  — value of the msg field from the database / socket
 * @returns {Promise<string>}  plaintext, original string, or DECRYPT_FALLBACK
 */
export async function decryptMessage(context, msg) {
  // Pass through non-E2EE content unchanged.
  if (!isEncryptedPayload(msg)) return msg;

  try {
    if (context.type === 'direct') {
      return await decryptDirect(context.myUserId, context.theirUserId, msg, context.token);
    }
    if (context.type === 'group') {
      return await decryptGroup(context.groupId, context.myUserId, msg, context.token);
    }
  } catch {
    return DECRYPT_FALLBACK;
  }

  return msg;
}
