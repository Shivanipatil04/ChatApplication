const mongoose = require('mongoose');

/**
 * E2EE — WrappedGroupKey model
 *
 * For each group, every member gets their own copy of the group AES-256-GCM
 * key, wrapped (encrypted) with that member's public key so only they can
 * unwrap it.  The server stores and routes these blobs but can NEVER unwrap
 * them — it never has any member's private key.
 *
 * Wrapping mechanism (client-side):
 *   1. Generate a random 32-byte group AES key (GroupKey).
 *   2. For each member:
 *        a. Perform ECDH(myPrivate, memberPublic) → sharedSecret
 *        b. HKDF(sharedSecret, groupId) → wrapKey (AES-256-GCM)
 *        c. AES-GCM-encrypt(GroupKey) → { ciphertext, iv }
 *        d. base64-encode and store as wrappedKey.
 *   3. POST /api/keys/groups/:groupId/wrapped-keys  (one entry per member).
 *
 * On join / key-fetch:
 *   GET /api/keys/groups/:groupId/wrapped-key   (returns your own blob)
 *   Unwrap client-side with ECDH(myPrivate, senderPublic) → wrapKey → AES-GCM-decrypt.
 *
 * Key rotation when a member is removed is out of scope for v1.
 * TODO(v2): increment keyVersion, re-wrap for remaining members, mark old blobs stale.
 */
const wrappedGroupKeySchema = new mongoose.Schema(
  {
    groupId:    { type: String, required: true, index: true },
    userId:     { type: String, required: true, index: true },
    // base64-encoded  { ciphertext, iv }  (AES-GCM wrapped AES key)
    wrappedKey: { type: String, required: true },
    // userId of the member who performed the wrapping (i.e. the group creator
    // or whoever added this member).  Needed by the recipient to fetch the
    // correct public key for ECDH key-agreement during unwrap.
    wrappedBy:  { type: String, required: true },
  },
  { timestamps: true },
);

// Compound index: each (group, user) pair has exactly one active wrapped key (v1).
wrappedGroupKeySchema.index({ groupId: 1, userId: 1 }, { unique: true });

module.exports =
  mongoose.models.WrappedGroupKey ||
  mongoose.model('WrappedGroupKey', wrappedGroupKeySchema);
