/**
 * E2EE — Existing-Message Migration Script
 *
 * ============================================================
 * IMPORTANT LIMITATION — READ BEFORE RUNNING
 * ============================================================
 * True end-to-end encryption means the SERVER never holds decryption keys.
 * Therefore this script CANNOT encrypt existing plaintext messages: doing so
 * would require the server to know the recipients' private keys, which would
 * completely defeat the E2EE security model.
 *
 * The correct approach for pre-E2EE messages is one of:
 *   A) Leave them as-is (plaintext in DB).  The client-side decryptMessage()
 *      in encryptionService.js detects payloads that are NOT valid E2EE
 *      blobs and returns them as plain strings unchanged.  Users will
 *      continue to see their old messages normally.
 *
 *   B) (Optional, manual) Bulk-delete all historical messages before
 *      activating E2EE.  Only do this if your product policy requires a
 *      clean-slate approach.
 *
 * This script implements option A by performing a DRY-RUN that logs how many
 * legacy plaintext messages exist per collection, then exits without modifying
 * any data.  It is safe to run at any time.
 *
 * Usage:
 *   cd server
 *   node scripts/migrateEncryptExistingMessages.js
 *
 * Requires MONGO_URI in server/.env.
 * ============================================================
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Chat        = require('../models/Chat');
const GroupMessage = require('../models/GroupMessage');

// An E2EE ciphertext blob is a base64-encoded JSON string that, when decoded,
// contains exactly the keys { ciphertext, iv }.  Any msg field that does NOT
// match this shape is a legacy plaintext message.
const isEncrypted = (msg) => {
  if (!msg || typeof msg !== 'string' || !msg.trim()) return true; // empty — no action needed
  try {
    const parsed = JSON.parse(Buffer.from(msg, 'base64').toString('utf8'));
    return typeof parsed.ciphertext === 'string' && typeof parsed.iv === 'string';
  } catch {
    return false; // not base64-JSON → plaintext legacy message
  }
};

async function main() {
  console.log('=== E2EE Migration Audit (DRY RUN — no data is modified) ===\n');

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.\n');

  // ---- 1:1 messages ----
  const directMessages = await Chat.find({ type: 'text', msg: { $ne: '' } }).lean();
  const plaintextDirect = directMessages.filter((m) => !isEncrypted(m.msg));

  console.log(`Direct (1:1) text messages total : ${directMessages.length}`);
  console.log(`  → Already E2EE-encrypted        : ${directMessages.length - plaintextDirect.length}`);
  console.log(`  → Legacy plaintext (no action)  : ${plaintextDirect.length}`);

  if (plaintextDirect.length > 0) {
    console.log('\n[INFO] Legacy plaintext direct messages exist.');
    console.log('       They will render normally in the UI because');
    console.log('       encryptionService.decryptMessage() falls back to');
    console.log('       returning the raw string when it is not a valid E2EE blob.');
  }

  // ---- Group messages ----
  const groupMessages = await GroupMessage.find({ type: 'text', msg: { $ne: '' } }).lean();
  const plaintextGroup = groupMessages.filter((m) => !isEncrypted(m.msg));

  console.log(`\nGroup text messages total        : ${groupMessages.length}`);
  console.log(`  → Already E2EE-encrypted        : ${groupMessages.length - plaintextGroup.length}`);
  console.log(`  → Legacy plaintext (no action)  : ${plaintextGroup.length}`);

  if (plaintextGroup.length > 0) {
    console.log('\n[INFO] Legacy plaintext group messages exist.');
    console.log('       Same graceful fallback applies — users will see them as-is.');
  }

  console.log('\n=== Audit complete.  No documents were modified. ===');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration script failed:', err);
  process.exit(1);
});
