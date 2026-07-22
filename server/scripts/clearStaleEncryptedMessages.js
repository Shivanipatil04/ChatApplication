/**
 * clearStaleEncryptedMessages.js
 *
 * Run this ONCE after deploying to a new environment (e.g. localhost → Render)
 * to replace all E2EE-encrypted message content with a placeholder text.
 *
 * WHY THIS IS NEEDED:
 *   E2EE messages encrypted on localhost used private keys that only existed in
 *   that browser's IndexedDB. Those keys NEVER transfer to a new origin/device.
 *   The server cannot decrypt the messages (it never had the keys — that's the
 *   whole point of E2EE). So old encrypted messages must either be cleared or
 *   left as-is (showing "Message encrypted on another device").
 *
 *   This script replaces the encrypted blobs with a human-readable placeholder
 *   so the chat history looks clean in the deployed app instead of showing
 *   decryption failure banners.
 *
 * USAGE:
 *   cd server
 *   node scripts/clearStaleEncryptedMessages.js
 *
 * Requires MONGO_URI in server/.env
 *
 * SAFE TO RE-RUN: it only touches messages that look like E2EE blobs (base64
 * JSON with {ciphertext, iv} keys). Plain-text legacy messages are untouched.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Chat = require('../models/Chat');
const GroupMessage = require('../models/GroupMessage');

const PLACEHOLDER = '[Message sent from another device — please send again]';

function isEncryptedBlob(msg) {
  if (!msg || typeof msg !== 'string' || !msg.trim()) return false;
  try {
    const parsed = JSON.parse(Buffer.from(msg, 'base64').toString('utf8'));
    return typeof parsed.ciphertext === 'string' && typeof parsed.iv === 'string';
  } catch {
    return false;
  }
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.\n');

  // ---- Direct messages ----
  const directMessages = await Chat.find({ type: 'text', msg: { $ne: '' } }).lean();
  const staleDirectIds = directMessages.filter((m) => isEncryptedBlob(m.msg)).map((m) => m._id);

  if (staleDirectIds.length) {
    await Chat.updateMany({ _id: { $in: staleDirectIds } }, { $set: { msg: PLACEHOLDER } });
    console.log(`✅ Cleared ${staleDirectIds.length} stale encrypted direct messages.`);
  } else {
    console.log('ℹ️  No stale encrypted direct messages found.');
  }

  // ---- Group messages ----
  const groupMessages = await GroupMessage.find({ type: 'text', msg: { $ne: '' } }).lean();
  const staleGroupIds = groupMessages.filter((m) => isEncryptedBlob(m.msg)).map((m) => m._id);

  if (staleGroupIds.length) {
    await GroupMessage.updateMany({ _id: { $in: staleGroupIds } }, { $set: { msg: PLACEHOLDER } });
    console.log(`✅ Cleared ${staleGroupIds.length} stale encrypted group messages.`);
  } else {
    console.log('ℹ️  No stale encrypted group messages found.');
  }

  console.log('\nDone. Messages will now display the placeholder text instead of decryption errors.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
