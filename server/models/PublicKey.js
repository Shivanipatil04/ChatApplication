const mongoose = require('mongoose');

/**
 * E2EE — PublicKey model
 *
 * Stores each user's ECDH P-256 public key (exported as a base64-encoded
 * SubjectPublicKeyInfo DER blob via SubtleCrypto.exportKey('spki', ...)).
 *
 * The corresponding private key is generated client-side and NEVER sent here.
 * The server is a dumb key-directory: it stores and serves public keys so
 * that two clients can derive a shared ECDH secret independently.
 *
 * Key rotation (new device / compromised key) is out of scope for v1.
 * TODO(v2): add version counter, previous-key array, and signed pre-keys.
 */
const publicKeySchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      unique: true, // one active identity key per user (v1)
      index: true,
    },
    // base64-encoded SPKI DER — safe for JSON, easy to import with
    //   SubtleCrypto.importKey('spki', base64ToBuffer(publicKey), ...)
    publicKey: { type: String, required: true },
  },
  { timestamps: true },
);

module.exports =
  mongoose.models.PublicKey || mongoose.model('PublicKey', publicKeySchema);
